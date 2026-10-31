import { closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createConnection, createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { dlopen, FFIType } from "bun:ffi";
import { Database } from "bun:sqlite";
import { csvCell } from "./output";
import { downloadPostMedia, downloadProfile, parseDataUrl, profileUrl, resolveHomePath, screenshotPath } from "./media";
import { identity, lockPath, pairingPath, socketPath, stateDir, extensionVersion } from "./lib/state";
import { effectivePort } from "./lib/config";
import { compatibleVersion } from "./lib/extension";
import { DEFAULT_CAP, DUP_MS, checkMessageText, GAP_MS, JITTER_MS, MAX_LEN, capFromEnv, contactStatuses, parseMessageTarget, validateJob } from "./lib/validate";
import { exportContactFile, upsertProfileContact } from "./lib/contacts";

// Service daemon: `socmedia --service-daemon` (spawned detached by lib/client.ts start()).
// Moved verbatim from cli.ts; kept as one module on purpose (queue, sockets, extension WS, SQLite share state).
export async function runServiceDaemon() {
  const libc = dlopen(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  });
  const lockFd = openSync(lockPath, "a", 0o600);
  if (libc.symbols.flock(lockFd, 2 | 4) !== 0) { closeSync(lockFd); process.exit(1); }
  // The kernel releases the exclusive lock if this process crashes. Only its holder
  // may remove a stale socket, and a live unrelated listener must be left alone.
  try {
    if (!lstatSync(socketPath).isSocket()) throw new Error("service path is not a socket");
    await new Promise<void>((resolve, reject) => {
      const probe = createConnection(socketPath);
      probe.once("connect", () => { probe.destroy(); reject(new Error("socket already in use")); });
      probe.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "ECONNREFUSED" || error.code === "ENOENT") resolve(); else reject(error);
      });
    });
    rmSync(socketPath, { force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") { closeSync(lockFd); process.exit(1); }
  }
  const db = new Database(join(stateDir, "state.sqlite"));
  db.run("CREATE TABLE IF NOT EXISTS jobs (id INTEGER PRIMARY KEY, data TEXT NOT NULL)");
  db.run("CREATE TABLE IF NOT EXISTS contacts (id TEXT PRIMARY KEY, data TEXT NOT NULL)");
  db.run("CREATE TABLE IF NOT EXISTS service_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  db.run("CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY, at TEXT NOT NULL, platform TEXT NOT NULL, toUrl TEXT NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL, error TEXT, jobId INTEGER)");
  const haltRow = db.query("SELECT value FROM service_state WHERE key = 'halted'").get() as { value: string } | null;
  let halted: { code: string; reason: string } | null = haltRow ? JSON.parse(haltRow.value) : null;
  db.run("UPDATE jobs SET data = json_set(data, '$.status', 'queued') WHERE json_extract(data, '$.action') IN ('readPage','snapshot','getProfile','getComments','getPosts','getPost','screenshot','search','downloadProfile','readInbox','readThread','sendMessage','ytStudioRead','click','scroll') AND json_extract(data, '$.status') = 'running'");
  type ExtensionData = { token: string; challenge?: { clientNonce: string; serverNonce: string; version: string } };
  let extensionSocket: Bun.ServerWebSocket<ExtensionData> | null = null;
  let connectedVersion: string | null = null;
  const pending = new Map<string, { ws: Bun.ServerWebSocket<ExtensionData>; finish: (reply: unknown) => void | Promise<void>; timer: ReturnType<typeof setTimeout> }>();
  let browserBusy = false;
  let workerWake: ReturnType<typeof setTimeout> | undefined;
  const extensionTimeout = Number(process.env.SOCMEDIA_EXTENSION_TIMEOUT_MS ?? "10000");
  if (!Number.isInteger(extensionTimeout) || extensionTimeout < 1 || extensionTimeout > 12000) throw new Error("SOCMEDIA_EXTENSION_TIMEOUT_MS must be 1-12000");
  const portConfig = effectivePort();
  const port = portConfig.port;
  const extensionServer = Bun.serve<ExtensionData>({
    hostname: "127.0.0.1", port,
    fetch(request, server) {
      if (new URL(request.url).pathname !== "/extension") return new Response("Not found", { status: 404 });
      try {
        const pairing = JSON.parse(readFileSync(pairingPath, "utf8"));
        if (!/^[a-p]{32}$/.test(pairing.id) || !/^[a-f0-9]{64}$/.test(pairing.token) || request.headers.get("origin") !== `chrome-extension://${pairing.id}`) return new Response("Forbidden", { status: 403 });
        if (!server.upgrade(request, { data: { token: pairing.token } })) return new Response("Upgrade required", { status: 400 });
      } catch { return new Response("Forbidden", { status: 403 }); }
    },
    websocket: {
      message(ws, message) {
        try {
          const hello = JSON.parse(String(message));
          if (hello.type === "result" && ws === extensionSocket) {
            const request = pending.get(hello.id);
            if (!request || request.ws !== ws) return;
            pending.delete(hello.id); clearTimeout(request.timer);
            if (hello.error?.code === "HALT" && typeof hello.error.reason === "string" && hello.error.reason.length > 0 && hello.error.reason.length <= 500) request.finish({ halt: { code: "HALT", reason: hello.error.reason } });
            else request.finish(hello.error ? { error: String(hello.error) } : hello.result);
            return;
          }
          if (hello.type === "hello" && !ws.data.challenge && typeof hello.version === "string" && /^[a-f0-9]{64}$/.test(hello.clientNonce)) {
            const challenge = { version: hello.version, clientNonce: hello.clientNonce, serverNonce: randomBytes(32).toString("hex") };
            ws.data.challenge = challenge;
            const proof = createHmac("sha256", Buffer.from(ws.data.token, "hex")).update(`server:${challenge.clientNonce}:${challenge.serverNonce}:${challenge.version}`).digest("hex");
            ws.send(JSON.stringify({ type: "challenge", serverNonce: challenge.serverNonce, proof }));
            return;
          }
          const challenge = ws.data.challenge;
          ws.data.challenge = undefined;
          if (!challenge || hello.type !== "authenticate" || typeof hello.proof !== "string" || !/^[a-f0-9]{64}$/.test(hello.proof)) { ws.close(1008, "Authentication failed"); return; }
          const expected = createHmac("sha256", Buffer.from(ws.data.token, "hex")).update(`client:${challenge.clientNonce}:${challenge.serverNonce}:${challenge.version}`).digest();
          if (!timingSafeEqual(Buffer.from(hello.proof, "hex"), expected)) { ws.close(1008, "Authentication failed"); return; }
          if (extensionSocket && extensionSocket !== ws) extensionSocket.close(1000, "Replaced");
          extensionSocket = ws;
          connectedVersion = challenge.version;
          ws.send(JSON.stringify({ type: "hello", version: extensionVersion, compatible: compatibleVersion(challenge.version) }));
          queueMicrotask(pump);
        } catch { ws.close(1008, "Invalid hello"); }
      },
      close(ws) {
        if (extensionSocket === ws) { extensionSocket = null; connectedVersion = null; }
        for (const [id, request] of pending) if (request.ws === ws) {
          pending.delete(id); clearTimeout(request.timer); request.finish({ error: "Extension disconnected" });
        }
      },
    },
  });
  function pump() {
    if (workerWake) { clearTimeout(workerWake); workerWake = undefined; }
    if (halted || !extensionSocket || !connectedVersion || !compatibleVersion(connectedVersion)) return;
    const now = Date.now();
    let wakeAt = Infinity;
    const compRow = (db.query("SELECT id, data FROM jobs WHERE json_extract(data, '$.action') = 'downloadProfile' AND json_extract(data, '$.status') = 'queued' ORDER BY id").all() as { id: number; data: string }[]).find((candidate) => {
      const job = JSON.parse(candidate.data);
      const at = job.notBefore ? Date.parse(job.notBefore) : 0;
      if (at > now) { wakeAt = Math.min(wakeAt, at); return false; }
      return true;
    });
    if (compRow) {
      const compJob = JSON.parse(compRow.data);
      compJob.status = "running";
      db.query("UPDATE jobs SET data = ? WHERE id = ?").run(JSON.stringify(compJob), compRow.id);
      (async () => {
        try {
          const step = async (action: string, args: Record<string, unknown>) => {
            const sub = validateJob({ action, args });
            const subRow = db.query("INSERT INTO jobs (data) VALUES (?) RETURNING id").get(JSON.stringify({ ...sub, status: "queued", parent: compRow.id })) as { id: number };
            queueMicrotask(pump);
            const deadline = Date.now() + 75000;
            while (Date.now() < deadline) {
              const check = db.query("SELECT data FROM jobs WHERE id = ?").get(subRow.id) as { data: string };
              const current = JSON.parse(check.data);
              if (current.status === "done") return current.result;
              if (current.status === "failed") {
                if (current.error?.code === "HALT") throw new Error(`HALT: ${current.error.reason}`);
                throw new Error(typeof current.error === "object" ? current.error?.reason : current.error);
              }
              await Bun.sleep(50);
            }
            throw new Error(`Subtask ${action} timed out`);
          };
          const res = await downloadProfile(compJob.args, step);
          compJob.status = "done"; compJob.result = res;
        } catch (e: any) {
          compJob.status = "failed"; compJob.error = e?.message || String(e);
        } finally {
          db.query("UPDATE jobs SET data = ? WHERE id = ?").run(JSON.stringify(compJob), compRow.id);
          queueMicrotask(pump);
        }
      })();
    }
    if (browserBusy) return;
    const rows = db.query("SELECT id, data FROM jobs WHERE json_extract(data, '$.action') IN ('readPage','snapshot','getProfile','getComments','getPosts','getPost','screenshot','search','readInbox','readThread','sendMessage','ytStudioRead','click','scroll') AND json_extract(data, '$.status') = 'queued' ORDER BY id").all() as { id: number; data: string }[];
    const row = rows.find((candidate) => {
      const job = JSON.parse(candidate.data);
      const at = job.notBefore ? Date.parse(job.notBefore) : 0;
      if (at > now) { wakeAt = Math.min(wakeAt, at); return false; }
      return true;
    });
    if (!row) {
      if (Number.isFinite(wakeAt)) workerWake = setTimeout(pump, Math.min(wakeAt - now, 2 ** 31 - 1));
      return;
    }
    const job = JSON.parse(row.data);
    job.status = "running";
    db.query("UPDATE jobs SET data = ? WHERE id = ?").run(JSON.stringify(job), row.id);
    browserBusy = true;
    const ws = extensionSocket;
    const id = randomBytes(16).toString("hex");
    const finish = async (reply: unknown) => {
      const halt = reply && typeof reply === "object" && "halt" in reply ? (reply as { halt: { code: string; reason: string } }).halt : null;
      const error = reply && typeof reply === "object" && "error" in reply ? String((reply as { error: unknown }).error) : null;
      if (halt) { halted = halt; job.status = "failed"; job.error = halt; }
      else if (error === "Extension disconnected") { job.status = "queued"; }
      else if (error) { job.status = "failed"; job.error = error; }
      else {
        let finalResult: unknown = reply;
        if (job.action === "getPost" && job.args?.download) {
          try { finalResult = await downloadPostMedia(reply, job.args.url); } catch {}
        } else if (job.action === "screenshot") {
          try {
            const replyObj = reply as { dataUrl?: string; width?: number; height?: number; url?: string; truncated?: boolean };
            const buf = parseDataUrl(replyObj?.dataUrl);
            const from = (job.args as any)?.url || replyObj?.url;
            let platform = "web";
            if (from) {
              try {
                const u = new URL(from);
                if (u.hostname.includes("instagram.com")) platform = "ig";
                else if (u.hostname.includes("facebook.com") || u.hostname.includes("fb.com")) platform = "fb";
              } catch {}
            }
            const targetPath = (job.args as any)?.path ? resolveHomePath((job.args as any).path) : screenshotPath(platform, from);
            mkdirSync(dirname(targetPath), { recursive: true, mode: 0o700 });
            writeFileSync(targetPath, buf);
            finalResult = {
              path: targetPath,
              width: replyObj?.width ?? null,
              height: replyObj?.height ?? null,
              url: replyObj?.url ?? from ?? null,
              ...(replyObj?.truncated ? { truncated: true } : {}),
            };
          } catch (e: any) {
            job.status = "failed";
            job.error = e?.message || String(e);
            finalResult = undefined;
          }
        }
        if (job.status !== "failed") {
          job.status = "done";
          job.result = finalResult;
        }
      }
      try {
        db.transaction(() => {
          if (halt) db.query("INSERT INTO service_state (key, value) VALUES ('halted', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(halt));
          if (job.status === "done" && job.action === "getProfile") upsertProfileContact(db, reply, job.args.url);
          if (job.action === "sendMessage") {
            const nowIso = new Date().toISOString();
            const parsedTarget = parseMessageTarget(job.args.to);
            let sendStatus = "failed";
            let sendError: string | null = job.error ? (typeof job.error === "object" ? job.error.reason : String(job.error)) : null;
            if (job.status === "done") {
              const res = reply as { sent?: boolean; verified?: boolean };
              if (res.sent && res.verified) sendStatus = "sent";
              else if (res.sent) { sendStatus = "unverified"; sendError = "sent, but unverified"; }
              else sendStatus = "failed";
            }
            db.query("INSERT INTO messages (at, platform, toUrl, text, status, error, jobId) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
              nowIso, parsedTarget.platform, parsedTarget.url, job.args.text, sendStatus, sendError, row.id
            );
            if (sendStatus === "sent" || sendStatus === "unverified") {
              try {
                const canonical = profileUrl(parsedTarget.url);
                const u = new URL(canonical);
                const p = u.hostname.includes("instagram.com") ? "ig" : "fb";
                const path = u.pathname.replace(/^\/+|\/+$/g, "");
                const rel = p === "fb" && path.toLowerCase() === "profile.php" ? `${path}?id=${u.searchParams.get("id")}` : path;
                const contactId = `${p}:${rel.toLowerCase()}`;
                const contactRow = db.query("SELECT data FROM contacts WHERE id = ?").get(contactId) as { data: string } | null;
                if (contactRow) {
                  const c = JSON.parse(contactRow.data);
                  if (c.status === "new") {
                    c.status = "messaged";
                    c.updatedAt = nowIso;
                    db.query("UPDATE contacts SET data = ? WHERE id = ?").run(JSON.stringify(c), contactId);
                  }
                }
              } catch {}
            }
          }
          db.query("UPDATE jobs SET data = ? WHERE id = ?").run(JSON.stringify(job), row.id);
        })();
      } catch (error) {
        job.status = "failed"; job.error = `Contact upsert failed: ${error instanceof Error ? error.message : String(error)}`; delete job.result;
        db.query("UPDATE jobs SET data = ? WHERE id = ?").run(JSON.stringify(job), row.id);
      }
      browserBusy = false;
      queueMicrotask(pump);
    };
    const timeout = job.action === "getComments" ? Math.max(extensionTimeout, 60000) : job.action === "getProfile" ? Math.max(extensionTimeout, 45000) : extensionTimeout;
    const timer = setTimeout(() => { pending.delete(id); finish({ error: "Extension request timed out" }); }, timeout);
    pending.set(id, { ws, finish, timer });
    ws.send(JSON.stringify({ type: "request", id, action: job.action, args: job.args }));
  }
  const extensionStatus = () => ({ connected: extensionSocket !== null, version: connectedVersion, compatible: connectedVersion === null ? null : compatibleVersion(connectedVersion), port: extensionServer.port });
  const server = createServer((socket) => {
    socket.write(JSON.stringify({ identity, pid: process.pid, version: extensionVersion, extension: extensionStatus(), halted, extensionUrl: `ws://127.0.0.1:${extensionServer.port}/extension`, portSource: portConfig.source }) + "\n");
    let input = "";
    socket.on("data", (data) => {
      input += data.toString();
      if (!input.includes("\n")) return;
      const command = input.split("\n")[0];
      if (command === "stop") { socket.end(); shutdown(); }
      else if (command === "service resume") {
        db.query("DELETE FROM service_state WHERE key = 'halted'").run();
        halted = null;
        socket.end(JSON.stringify({ halted: null }) + "\n");
        queueMicrotask(pump);
      }
      else if (command === "tabs list" || command === "tabs clear" || command?.startsWith("tabs use ")) {
        if (browserBusy) { socket.end(JSON.stringify({ error: "Browser worker is busy" }) + "\n"); return; }
        let tabId: number | null = null;
        if (command.startsWith("tabs use ")) {
          const rawId = command.slice("tabs use ".length);
          tabId = Number(rawId);
          if (!/^(0|[1-9]\d*)$/.test(rawId) || !Number.isSafeInteger(tabId)) { socket.end(JSON.stringify({ error: "Tab ID must be a non-negative integer" }) + "\n"); return; }
        }
        if (!extensionSocket) { socket.end(JSON.stringify({ error: "Extension not connected" }) + "\n"); return; }
        if (!connectedVersion || !compatibleVersion(connectedVersion)) { socket.end(JSON.stringify({ error: "Extension version incompatible" }) + "\n"); return; }
        const id = randomBytes(16).toString("hex");
        const ws = extensionSocket;
        browserBusy = true;
        const finish = (reply: unknown) => { browserBusy = false; socket.end(JSON.stringify(reply) + "\n"); queueMicrotask(pump); };
        const timer = setTimeout(() => { pending.delete(id); finish({ error: "Extension request timed out" }); }, extensionTimeout);
        pending.set(id, { ws, finish, timer });
        ws.send(JSON.stringify(command === "tabs list" ? { type: "request", id, action: "tabs.list" } : { type: "request", id, action: "tabs.use", args: { tabId } }));
      }
      else if (command === "extension reload") {
        // Asks the connected extension to chrome.runtime.reload(); extensions without a handler ignore the message.
        if (!extensionSocket) { socket.end(JSON.stringify({ error: "Extension not connected" }) + "\n"); return; }
        extensionSocket.send(JSON.stringify({ type: "reload" }));
        socket.end(JSON.stringify({ sent: true }) + "\n");
      }
      else if (command === "queue list") {
        const rows = db.query("SELECT id, data FROM jobs ORDER BY id DESC").all() as { id: number; data: string }[];
        socket.end(JSON.stringify({ jobs: rows.map((row) => ({ id: row.id, ...JSON.parse(row.data) })) }) + "\n");
      } else if (command?.startsWith("contacts list ")) {
        try {
          const filters = JSON.parse(command.slice("contacts list ".length));
          if (filters.status !== undefined && !contactStatuses.includes(filters.status)) throw new Error("Invalid contact status");
          if (filters.platform !== undefined && !["ig", "fb"].includes(filters.platform)) throw new Error("Invalid contact platform");
          const rows = db.query("SELECT data FROM contacts ORDER BY rowid").all() as { data: string }[];
          const contacts = rows.map((row) => JSON.parse(row.data)).filter((contact) => (!filters.status || contact.status === filters.status) && (!filters.platform || contact.platform === filters.platform));
          socket.end(JSON.stringify({ count: contacts.length, file: join(stateDir, "state.sqlite"), contacts }) + "\n");
        } catch (error) { socket.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) + "\n"); }
      } else if (command?.startsWith("contacts import ")) {
        try {
          const { from } = JSON.parse(command.slice("contacts import ".length));
          const sourceDir = from ? resolveHomePath(from) : join(homedir(), ".socmedia-mcp");
          let contactsImported = 0;
          let messagesImported = 0;
          const contactsFile = join(sourceDir, "contacts.jsonl");
          if (existsSync(contactsFile)) {
            const lines = readFileSync(contactsFile, "utf8").split("\n").filter((l) => l.trim());
            db.transaction(() => {
              for (const line of lines) {
                try {
                  const c = JSON.parse(line);
                  if (c && typeof c.id === "string") {
                    const existing = db.query("SELECT data FROM contacts WHERE id = ?").get(c.id);
                    if (!existing) {
                      db.query("INSERT INTO contacts (id, data) VALUES (?, ?)").run(c.id, JSON.stringify(c));
                      contactsImported++;
                    }
                  }
                } catch {}
              }
            })();
          }
          const messagesFile = join(sourceDir, "messages.jsonl");
          if (existsSync(messagesFile)) {
            const lines = readFileSync(messagesFile, "utf8").split("\n").filter((l) => l.trim());
            db.transaction(() => {
              for (const line of lines) {
                try {
                  const m = JSON.parse(line);
                  if (m && m.at && m.to && m.text) {
                    const existing = db.query("SELECT id FROM messages WHERE at = ? AND toUrl = ? AND text = ?").get(m.at, m.to, m.text);
                    if (!existing) {
                      db.query("INSERT INTO messages (at, platform, toUrl, text, status, error, jobId) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
                        m.at, m.platform || "ig", m.to, m.text, m.status || "sent", m.error || null, m.jobId || null
                      );
                      messagesImported++;
                    }
                  }
                } catch {}
              }
            })();
          }
          socket.end(JSON.stringify({ contactsImported, messagesImported, source: sourceDir }) + "\n");
        } catch (error) { socket.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) + "\n"); }
      } else if (command?.startsWith("contacts export ")) {
        try {
          const args = JSON.parse(command.slice("contacts export ".length));
          if (args.status !== undefined && !contactStatuses.includes(args.status)) throw new Error("Invalid contact status");
          if (args.platform !== undefined && !["ig", "fb"].includes(args.platform)) throw new Error("Invalid contact platform");
          const format = args.format ?? "csv";
          if (!["csv", "json", "jsonl"].includes(format)) throw new Error("Format must be csv, json or jsonl");
          const rows = db.query("SELECT data FROM contacts ORDER BY rowid").all() as { data: string }[];
          const contacts = rows.map((row) => JSON.parse(row.data)).filter((contact) => (!args.status || contact.status === args.status) && (!args.platform || contact.platform === args.platform));
          socket.end(JSON.stringify(exportContactFile(args.path, format, contacts)) + "\n");
        } catch (error) { socket.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) + "\n"); }
      } else if (command?.startsWith("contacts update ")) {
        try {
          const update = JSON.parse(command.slice("contacts update ".length));
          if (typeof update.id !== "string" || !update.id.trim()) throw new Error("Contact ID is required");
          if (update.status === undefined && update.note === undefined) throw new Error("Provide --status or --note");
          if (update.status !== undefined && !contactStatuses.includes(update.status)) throw new Error("Invalid contact status");
          if (update.note !== undefined && (typeof update.note !== "string" || update.note.length > 2000)) throw new Error("Contact note must be at most 2000 characters");
          const result = db.transaction(() => {
            const row = db.query("SELECT data FROM contacts WHERE id = ?").get(update.id) as { data: string } | null;
            if (!row) throw new Error(`No contact ${update.id}`);
            const contact = { ...JSON.parse(row.data), ...(update.status !== undefined && { status: update.status }), ...(update.note !== undefined && { note: update.note }), updatedAt: new Date().toISOString() };
            db.query("UPDATE contacts SET data = ? WHERE id = ?").run(JSON.stringify(contact), update.id);
            return contact;
          })();
          socket.end(JSON.stringify(result) + "\n");
        } catch (error) { socket.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) + "\n"); }
      } else if (command?.startsWith("queue get ")) {
        const id = Number(command.slice("queue get ".length));
        if (!Number.isSafeInteger(id) || id < 1) {
          socket.end(JSON.stringify({ error: "Job ID must be a positive integer" }) + "\n");
          return;
        }
        const row = db.query("SELECT id, data FROM jobs WHERE id = ?").get(id) as { id: number; data: string } | null;
        socket.end(JSON.stringify(row ? { id: row.id, ...JSON.parse(row.data) } : { error: `Job ${id} not found` }) + "\n");
      } else if (command?.startsWith("queue enqueue ")) {
        try {
          const job = validateJob(JSON.parse(command.slice("queue enqueue ".length)));
          const create = db.transaction(() => {
            if (job.action === "sendMessage") {
              const msgArgs = job.args as Record<string, unknown>;
              const parsedTarget = parseMessageTarget(msgArgs.to);
              const text = checkMessageText(msgArgs.text);
              const now = Date.now();
              const cap = capFromEnv();
              const startOfToday = new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate()).toISOString();
              const usedToday = db.query("SELECT COUNT(*) as count FROM messages WHERE platform = ? AND status IN ('sent', 'unverified') AND at >= ?").get(parsedTarget.platform, startOfToday) as { count: number };
              if (usedToday.count >= cap) throw new Error(`Daily cap reached: ${usedToday.count} of ${cap} messages on ${parsedTarget.platform} today (SOCMEDIA_MAX_MESSAGES_PER_DAY). Try again tomorrow.`);
              const sevenDaysAgo = new Date(now - DUP_MS).toISOString();
              const normInput = text.replace(/\s+/g, " ").trim().toLowerCase();
              const recent = db.query("SELECT at, toUrl, text FROM messages WHERE platform = ? AND status IN ('sent', 'unverified') AND at >= ?").all(parsedTarget.platform, sevenDaysAgo) as { at: string; toUrl: string; text: string }[];
              const dup = recent.find((r) => {
                try {
                  return parseMessageTarget(r.toUrl).url.toLowerCase() === parsedTarget.url.toLowerCase() && r.text.replace(/\s+/g, " ").trim().toLowerCase() === normInput;
                } catch { return false; }
              });
              if (dup) throw new Error(`Refused: identical text was already sent to this recipient on ${dup.at} (7-day rule). Change the text or wait.`);
              if (!job.notBefore) {
                let anchor = 0;
                const activeJobs = db.query("SELECT data FROM jobs WHERE json_extract(data, '$.action') = 'sendMessage' AND json_extract(data, '$.status') IN ('queued', 'running')").all() as { data: string }[];
                for (const row of activeJobs) {
                  const j = JSON.parse(row.data);
                  const at = j.notBefore ? Date.parse(j.notBefore) : 0;
                  anchor = Math.max(anchor, at);
                }
                const lastMsg = db.query("SELECT at FROM messages WHERE status IN ('sent', 'unverified') ORDER BY id DESC LIMIT 1").get() as { at: string } | null;
                if (lastMsg) anchor = Math.max(anchor, Date.parse(lastMsg.at) || 0);
                if (anchor > 0) {
                  const planned = Math.max(now, anchor + GAP_MS + Math.floor(Math.random() * JITTER_MS));
                  job.notBefore = new Date(planned).toISOString();
                }
              }
            }
            if (job.key) {
              const existing = db.query("SELECT id, data FROM jobs WHERE json_extract(data, '$.key') = ? ORDER BY id DESC LIMIT 1").get(job.key as string) as { id: number; data: string } | null;
              if (existing) {
                const saved = JSON.parse(existing.data);
                if (saved.action !== job.action || !Bun.deepEquals(saved.args, job.args) || saved.notBefore !== job.notBefore) {
                  throw new Error(`Idempotency key conflict: ${job.key}`);
                }
                return { id: existing.id, ...saved };
              }
            }
            const data = JSON.stringify({ ...job, status: "queued", createdAt: new Date().toISOString() });
            const inserted = db.query("INSERT INTO jobs (data) VALUES (?)").run(data);
            return { id: Number(inserted.lastInsertRowid), ...JSON.parse(data) };
          });
          socket.end(JSON.stringify(create()) + "\n");
          queueMicrotask(pump);
        } catch (error) { socket.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) + "\n"); }
      } else if (command?.startsWith("queue cancel ")) {
        const id = Number(command.slice("queue cancel ".length));
        if (!Number.isSafeInteger(id) || id < 1) {
          socket.end(JSON.stringify({ error: "Job ID must be a positive integer" }) + "\n");
          return;
        }
        const cancel = db.transaction(() => {
          const row = db.query("SELECT id, data FROM jobs WHERE id = ?").get(id) as { id: number; data: string } | null;
          if (!row) return { error: `Job ${id} not found` };
          const job = JSON.parse(row.data);
          if (job.status === "cancelled") return { id: row.id, ...job };
          if (job.status !== "queued") return { error: `Job ${id} cannot be cancelled (status: ${job.status})` };
          job.status = "cancelled";
          db.query("UPDATE jobs SET data = ? WHERE id = ?").run(JSON.stringify(job), id);
          return { id: row.id, ...job };
        });
        socket.end(JSON.stringify(cancel()) + "\n");
      }
    });
  });
  server.on("error", () => { closeSync(lockFd); process.exit(1); });
  server.listen(socketPath);
  const shutdown = () => server.close(() => {
    extensionServer.stop(true);
    db.close();
    rmSync(socketPath, { force: true });
    closeSync(lockFd);
    process.exit(0);
  });
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
