import { closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createConnection, createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { dlopen, FFIType } from "bun:ffi";
import { Database } from "bun:sqlite";
import { csvCell } from "./output";
import { downloadPostMedia, downloadProfile, fetchBody, isMediaHost, MAX_VIDEO_BYTES, mediaExt, parseDataUrl, profileUrl, resolveHomePath, safeSeg, screenshotPath } from "./media";
import { identity, lockPath, pairingPath, socketPath, stateDir, extensionVersion } from "./lib/state";
import { effectivePort } from "./lib/config";
import { compatibleVersion } from "./lib/extension";
import { DEFAULT_CAP, DUP_MS, checkMessageText, GAP_MS, JITTER_MS, MAX_LEN, capFromEnv, contactStatuses, parseMessageTarget, telegramChat, tgChannelsCapFromEnv, tiktokUploadsCapFromEnv, validateJob } from "./lib/validate";
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
  db.run("CREATE TABLE IF NOT EXISTS uploads (id INTEGER PRIMARY KEY, at TEXT NOT NULL, platform TEXT NOT NULL, sha256 TEXT NOT NULL, file TEXT NOT NULL, status TEXT NOT NULL, error TEXT, jobId INTEGER)");
  db.run("CREATE TABLE IF NOT EXISTS channels (id INTEGER PRIMARY KEY, at TEXT NOT NULL, platform TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL, error TEXT, jobId INTEGER)");
  const haltRow = db.query("SELECT value FROM service_state WHERE key = 'halted'").get() as { value: string } | null;
  let halted: { code: string; reason: string } | null = haltRow ? JSON.parse(haltRow.value) : null;
  // Side-effect actions found running at startup must become unverified, NEVER queued:
  db.run("UPDATE jobs SET data = json_set(data, '$.status', 'unverified') WHERE json_extract(data, '$.action') IN ('sendMessage','tiktokUpload','tgSendMessage','tgSendMedia','tgCreateChannel') AND json_extract(data, '$.status') = 'running'");
  // Read actions can be requeued to queued:
  db.run("UPDATE jobs SET data = json_set(data, '$.status', 'queued') WHERE json_extract(data, '$.action') IN ('readPage','snapshot','getProfile','getComments','getPosts','getPost','screenshot','search','downloadProfile','readInbox','readThread','ytStudioRead','click','scroll','tiktokProfile','tiktokPosts','tiktokVideo','tiktokComments','tiktokSearch','tiktokInbox','tgStatus','tgDialogsList','tgMessagesRead','tgMediaDownload') AND json_extract(data, '$.status') = 'running'");
  type ExtensionData = { token: string; challenge?: { clientNonce: string; serverNonce: string; version: string } };
  let extensionSocket: Bun.ServerWebSocket<ExtensionData> | null = null;
  let connectedVersion: string | null = null;
  const pending = new Map<string, { ws: Bun.ServerWebSocket<ExtensionData>; finish: (reply: unknown) => void | Promise<void>; timer: ReturnType<typeof setTimeout> }>();
  type ChunkEntry = {
    total: number;
    chunks: string[];
    bytes: number;
    itemIndex?: number;
    mediaType?: string;
    preview?: boolean;
  };
  type ActiveTgDownload = {
    id: string;
    jobId: number;
    chat: string;
    dir?: string;
    fileSeq: number;
    saved: Array<{ path: string; type?: string; preview?: boolean }>;
    skipped: Array<{ type?: string; reason: string; preview?: boolean }>;
    chunks: Map<string, ChunkEntry>;
  };
  let activeTgDownload: ActiveTgDownload | null = null;
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
          if (hello.type === "chunk" && ws === extensionSocket) {
            if (!activeTgDownload || hello.id !== activeTgDownload.id) {
              return;
            }
            const fileId = String(hello.fileId || "");
            const total = hello.total;
            const index = hello.index;
            const data = typeof hello.data === "string" ? hello.data : "";
            if (!Number.isInteger(total) || total < 1 || total > 1000 || !Number.isInteger(index) || index < 0 || index >= total) {
              return;
            }

            let acc: ChunkEntry | undefined = activeTgDownload.chunks.get(fileId);
            if (!acc) {
              acc = {
                total,
                chunks: new Array(total),
                bytes: 0,
                itemIndex: typeof hello.itemIndex === "number" ? hello.itemIndex : undefined,
                mediaType: typeof hello.mediaType === "string" ? hello.mediaType : undefined,
                preview: Boolean(hello.preview),
              };
              activeTgDownload.chunks.set(fileId, acc);
            }
            const chunkAcc = acc;

            const chunkBytes = Buffer.byteLength(data, "base64");
            if (chunkAcc.bytes + chunkBytes > 50 * 1024 * 1024) {
              activeTgDownload.chunks.delete(fileId);
              activeTgDownload.skipped.push({
                type: chunkAcc.mediaType || "media",
                reason: "File exceeds 50 MB limit",
                preview: chunkAcc.preview,
              });
              return;
            }

            chunkAcc.chunks[index] = data;
            chunkAcc.bytes += chunkBytes;

            if (chunkAcc.chunks.filter(Boolean).length === chunkAcc.total) {
              activeTgDownload.chunks.delete(fileId);
              try {
                const rawBuffer = Buffer.concat(chunkAcc.chunks.map((c) => Buffer.from(c, "base64")));
                if (rawBuffer.length > 50 * 1024 * 1024) {
                  activeTgDownload.skipped.push({
                    type: chunkAcc.mediaType || "media",
                    reason: "File exceeds 50 MB limit",
                    preview: chunkAcc.preview,
                  });
                  return;
                }
                const ext = mediaExt(rawBuffer);
                if (ext && ["jpg", "png", "webp", "mp4"].includes(ext)) {
                  activeTgDownload.fileSeq++;
                  const itemIdx = chunkAcc.itemIndex ?? activeTgDownload.fileSeq;
                  const outDir = activeTgDownload.dir
                    ? resolveHomePath(activeTgDownload.dir)
                    : resolveHomePath(`~/socmedia-data/telegram/${safeSeg(activeTgDownload.chat)}`);
                  mkdirSync(outDir, { recursive: true, mode: 0o700 });
                  let filename = `media_${itemIdx}.${ext}`;
                  if (existsSync(join(outDir, filename))) {
                    let counter = 1;
                    while (existsSync(join(outDir, `media_${itemIdx}_${counter}.${ext}`))) {
                      counter++;
                    }
                    filename = `media_${itemIdx}_${counter}.${ext}`;
                  }
                  const filePath = join(outDir, filename);
                  writeFileSync(filePath, rawBuffer);
                  activeTgDownload.saved.push({
                    path: filePath,
                    type: chunkAcc.mediaType || (ext === "mp4" ? "video" : "photo"),
                    ...(chunkAcc.preview ? { preview: true } : {}),
                  });
                } else {
                  activeTgDownload.skipped.push({
                    type: chunkAcc.mediaType || "media",
                    reason: "Invalid or unsupported media format",
                    ...(chunkAcc.preview ? { preview: true } : {}),
                  });
                }
              } catch (e: any) {
                activeTgDownload.skipped.push({
                  type: chunkAcc.mediaType || "media",
                  reason: `Failed to write file: ${e?.message || String(e)}`,
                  ...(chunkAcc.preview ? { preview: true } : {}),
                });
              }
            }
            return;
          }
          if (hello.type === "result" && ws === extensionSocket) {
            const request = pending.get(hello.id);
            if (!request || request.ws !== ws) return;
            pending.delete(hello.id); clearTimeout(request.timer);
            if (hello.error?.code === "HALT" && typeof hello.error.reason === "string" && hello.error.reason.length > 0 && hello.error.reason.length <= 500) {
              const isPostAction = Boolean(
                (hello.error as any).sent || (hello.error as any).posted || (hello.error as any).created ||
                (hello as any).sent || (hello as any).posted || (hello as any).created ||
                (hello as any).result?.sent || (hello as any).result?.posted || (hello as any).result?.created
              );
              request.finish({
                halt: { code: "HALT", reason: hello.error.reason },
                sent: Boolean((hello.error as any).sent || (hello as any).sent || (hello as any).result?.sent),
                posted: Boolean((hello.error as any).posted || (hello as any).posted || (hello as any).result?.posted),
                created: Boolean((hello.error as any).created || (hello as any).created || (hello as any).result?.created),
                isPostAction,
              });
            }
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
    const rows = db.query("SELECT id, data FROM jobs WHERE json_extract(data, '$.action') IN ('readPage','snapshot','getProfile','getComments','getPosts','getPost','screenshot','search','downloadProfile','readInbox','readThread','sendMessage','ytStudioRead','click','scroll','tiktokProfile','tiktokPosts','tiktokVideo','tiktokComments','tiktokSearch','tiktokInbox','tiktokUpload','tgStatus','tgDialogsList','tgMessagesRead','tgMediaDownload','tgSendMessage','tgSendMedia','tgCreateChannel') AND json_extract(data, '$.status') = 'queued' ORDER BY id").all() as { id: number; data: string }[];
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
    if (job.action === "tgMediaDownload") {
      activeTgDownload = {
        id,
        jobId: row.id,
        chat: String(job.args.chat || ""),
        dir: job.args.dir ? String(job.args.dir) : undefined,
        fileSeq: 0,
        saved: [],
        skipped: [],
        chunks: new Map(),
      };
    }
    const finish = async (reply: unknown) => {
      const halt = reply && typeof reply === "object" && "halt" in reply ? (reply as { halt: { code: string; reason: string } }).halt : null;
      const error = reply && typeof reply === "object" && "error" in reply ? String((reply as { error: unknown }).error) : null;
      const isSideEffect = ["sendMessage", "tiktokUpload", "tgSendMessage", "tgSendMedia", "tgCreateChannel"].includes(job.action);
      const postPointOfNoReturn = Boolean(
        (reply as any)?.sent || (reply as any)?.posted || (reply as any)?.created ||
        (reply as any)?.isPostAction
      );
      if (halt) {
        halted = halt;
        if (postPointOfNoReturn && isSideEffect) {
          job.status = "unverified";
          job.error = halt;
        } else {
          job.status = "failed";
          job.error = halt;
        }
      }
      else if (error === "Extension disconnected") {
        if (isSideEffect) {
          job.status = "unverified";
          job.error = error;
        } else {
          job.status = "queued";
        }
      }
      else if (error === "Extension request timed out") {
        if (isSideEffect) {
          job.status = "unverified";
          job.error = error;
        } else {
          job.status = "failed";
          job.error = error;
        }
      }
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
        } else if (job.action === "tiktokVideo" && job.args?.download) {
          try {
            const vidRes = reply as { url?: string; author?: string; id?: string; videoUrl?: string | null; [key: string]: unknown };
            const author = safeSeg(job.args.author || vidRes.author) || "_unknown";
            const videoId = safeSeg(job.args.id || vidRes.id) || "_unknown";
            const dir = resolveHomePath(`~/socmedia-data/tiktok/${author}/${videoId}`);
            mkdirSync(dir, { recursive: true, mode: 0o700 });

            const vUrl = vidRes.videoUrl;
            if (!vUrl || vUrl.startsWith("blob:")) {
              finalResult = {
                ...vidRes,
                downloaded: false,
                reason: !vUrl ? "No video URL exposed on page" : "Page only exposes a blob: URL; direct CDN download not possible",
                savedAt: dir,
              };
            } else {
              const fetchRes = await fetchBody(vUrl, { max: MAX_VIDEO_BYTES, timeout: 60000, allow: isMediaHost });
              const ext = fetchRes.status === 200 && !fetchRes.truncated ? mediaExt(fetchRes.body) : null;
              if (ext === "mp4") {
                writeFileSync(join(dir, "video.mp4"), fetchRes.body);
                writeFileSync(join(dir, "video.json"), JSON.stringify({ ...vidRes, downloaded: true }, null, 2));
                finalResult = {
                  ...vidRes,
                  downloaded: true,
                  file: join(dir, "video.mp4"),
                  meta: join(dir, "video.json"),
                };
              } else {
                finalResult = {
                  ...vidRes,
                  downloaded: false,
                  reason: "Fetched media did not pass mp4 verification",
                  savedAt: dir,
                };
              }
            }
          } catch (e: any) {
            finalResult = {
              ...(typeof reply === "object" && reply ? reply : {}),
              downloaded: false,
              reason: `Download failed: ${e?.message || String(e)}`,
            };
          }
        } else if (job.action === "tgMediaDownload" && activeTgDownload && activeTgDownload.id === id) {
          const rawReply = (reply && typeof reply === "object" ? reply : {}) as Record<string, any>;
          finalResult = {
            chat: activeTgDownload.chat,
            attempted: rawReply.attempted ?? (activeTgDownload.saved.length + activeTgDownload.skipped.length),
            saved: activeTgDownload.saved,
            skipped: [...(rawReply.skipped || []), ...activeTgDownload.skipped],
          };
        }
        if (job.status !== "failed" && job.status !== "unverified") {
          const isUnverifiedRes = reply && typeof reply === "object" && ("verified" in reply) && (reply as any).verified === false;
          if (isUnverifiedRes && isSideEffect) {
            job.status = "unverified";
            job.result = finalResult;
          } else {
            job.status = "done";
            job.result = finalResult;
          }
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
            } else if (job.status === "unverified") {
              sendStatus = "unverified";
              sendError = job.error ? (typeof job.error === "object" ? job.error.reason : String(job.error)) : "unverified";
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
          if (job.action === "tgSendMessage" || job.action === "tgSendMedia") {
            const nowIso = new Date().toISOString();
            let sendStatus = "failed";
            let sendError: string | null = job.error ? (typeof job.error === "object" ? job.error.reason : String(job.error)) : null;
            if (job.status === "done") {
              const res = reply as { sent?: boolean; verified?: boolean };
              if (res.sent && res.verified) sendStatus = "sent";
              else if (res.sent) { sendStatus = "unverified"; sendError = "sent, but unverified"; }
              else sendStatus = "failed";
            } else if (job.status === "unverified") {
              sendStatus = "unverified";
              sendError = job.error ? (typeof job.error === "object" ? job.error.reason : String(job.error)) : "unverified";
            }
            const msgText = job.action === "tgSendMessage" ? String(job.args.text) : String(job.args.caption || "");
            db.query("INSERT INTO messages (at, platform, toUrl, text, status, error, jobId) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
              nowIso, "tg", String(job.args.chat), msgText, sendStatus, sendError, row.id
            );
          }
          if (job.action === "tiktokUpload") {
            const nowIso = new Date().toISOString();
            let upStatus = "failed";
            let upError: string | null = job.error ? (typeof job.error === "object" ? job.error.reason : String(job.error)) : null;
            if (job.status === "done") {
              const res = reply as { posted?: boolean; verified?: boolean };
              if (res.posted && res.verified) upStatus = "sent";
              else if (res.posted) { upStatus = "unverified"; upError = "posted, but unverified"; }
              else upStatus = "failed";
            } else if (job.status === "unverified") {
              upStatus = "unverified";
              upError = job.error ? (typeof job.error === "object" ? job.error.reason : String(job.error)) : "unverified";
            }
            db.query("INSERT INTO uploads (at, platform, sha256, file, status, error, jobId) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
              nowIso, "tt", String(job.args.sha256), String(job.args.file), upStatus, upError, row.id
            );
          }
          if (job.action === "tgCreateChannel") {
            const nowIso = new Date().toISOString();
            let chanStatus = "failed";
            let chanError: string | null = job.error ? (typeof job.error === "object" ? job.error.reason : String(job.error)) : null;
            if (job.status === "done") {
              const res = reply as { created?: boolean; verified?: boolean };
              if (res.created && res.verified) chanStatus = "sent";
              else if (res.created) { chanStatus = "unverified"; chanError = "created, but unverified"; }
              else chanStatus = "failed";
            } else if (job.status === "unverified") {
              chanStatus = "unverified";
              chanError = job.error ? (typeof job.error === "object" ? job.error.reason : String(job.error)) : "unverified";
            }
            db.query("INSERT INTO channels (at, platform, title, status, error, jobId) VALUES (?, ?, ?, ?, ?, ?)").run(
              nowIso, "tg", String(job.args.title), chanStatus, chanError, row.id
            );
          }
          db.query("UPDATE jobs SET data = ? WHERE id = ?").run(JSON.stringify(job), row.id);
        })();
      } catch (error) {
        job.status = "failed"; job.error = `Contact upsert failed: ${error instanceof Error ? error.message : String(error)}`; delete job.result;
        db.query("UPDATE jobs SET data = ? WHERE id = ?").run(JSON.stringify(job), row.id);
      }
      if (activeTgDownload && activeTgDownload.id === id) {
        activeTgDownload = null;
      }
      browserBusy = false;
      queueMicrotask(pump);
    };
    const actionTimeoutMap: Record<string, number> = {
      tiktokUpload: 10 * 60 * 1000,
      tgSendMedia: 10 * 60 * 1000,
      tgMediaDownload: 5 * 60 * 1000,
      tiktokProfile: 75000,
      tiktokPosts: 75000,
      tiktokVideo: 75000,
      tiktokComments: 75000,
      tiktokSearch: 75000,
      tiktokInbox: 75000,
      tgStatus: 75000,
      tgDialogsList: 75000,
      tgMessagesRead: 75000,
      tgSendMessage: 75000,
      tgCreateChannel: 75000,
      getComments: Math.max(extensionTimeout, 60000),
      getProfile: Math.max(extensionTimeout, 45000),
    };
    const timeout = actionTimeoutMap[job.action] ?? extensionTimeout;
    const timer = setTimeout(() => { pending.delete(id); finish({ error: "Extension request timed out" }); }, timeout);
    pending.set(id, { ws, finish, timer });
    ws.send(JSON.stringify({ type: "request", id, action: job.action, args: job.args }));
  }
  const extensionStatus = () => ({ connected: extensionSocket !== null, version: connectedVersion, compatible: connectedVersion === null ? null : compatibleVersion(connectedVersion), port: extensionServer.port });
  const server = createServer((socket) => {
    socket.write(JSON.stringify({
      identity,
      pid: process.pid,
      version: extensionVersion,
      extension: extensionStatus(),
      halted,
      extensionUrl: `ws://127.0.0.1:${extensionServer.port}/extension`,
      portSource: portConfig.source,
      limits: {
        messages: { cap: capFromEnv() },
        tiktokUploads: { cap: tiktokUploadsCapFromEnv() },
        telegramChannels: { cap: tgChannelsCapFromEnv() },
      },
    }) + "\n");
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
          const create = db.transaction(() => {
            const job = validateJob(JSON.parse(command.slice("queue enqueue ".length)));
            if (job.action === "sendMessage") {
              const msgArgs = job.args as Record<string, unknown>;
              const parsedTarget = parseMessageTarget(msgArgs.to);
              const text = checkMessageText(msgArgs.text);
              const now = Date.now();
              const cap = capFromEnv();
              const startOfToday = new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate()).toISOString();
              const usedToday = db.query("SELECT COUNT(*) as count FROM messages WHERE platform = ? AND status IN ('sent', 'unverified') AND at >= ?").get(parsedTarget.platform, startOfToday) as { count: number };
              const activeJobs = db.query("SELECT data FROM jobs WHERE json_extract(data, '$.action') = 'sendMessage' AND json_extract(data, '$.status') IN ('queued', 'running')").all() as { data: string }[];
              let activeCount = 0;
              const normInput = text.replace(/\s+/g, " ").trim().toLowerCase();
              for (const row of activeJobs) {
                const j = JSON.parse(row.data);
                try {
                  const pt = parseMessageTarget(j.args?.to);
                  if (pt.platform === parsedTarget.platform) {
                    activeCount++;
                    if (normInput && checkMessageText(j.args?.text).replace(/\s+/g, " ").trim().toLowerCase() === normInput && pt.url.toLowerCase() === parsedTarget.url.toLowerCase()) {
                      throw new Error("Refused: identical text is already queued or running (7-day rule). Change the text or wait.");
                    }
                  }
                } catch (err: any) {
                  if (err.message.includes("already queued or running")) throw err;
                }
              }
              const totalToday = usedToday.count + activeCount;
              if (totalToday >= cap) throw new Error(`Daily message cap reached: ${totalToday} of ${cap} messages on ${parsedTarget.platform} today (SOCMEDIA_MAX_MESSAGES_PER_DAY). Try again tomorrow.`);
              const sevenDaysAgo = new Date(now - DUP_MS).toISOString();
              const recent = db.query("SELECT at, toUrl, text FROM messages WHERE platform = ? AND status IN ('sent', 'unverified') AND at >= ?").all(parsedTarget.platform, sevenDaysAgo) as { at: string; toUrl: string; text: string }[];
              const dup = recent.find((r) => {
                try {
                  return parseMessageTarget(r.toUrl).url.toLowerCase() === parsedTarget.url.toLowerCase() && r.text.replace(/\s+/g, " ").trim().toLowerCase() === normInput;
                } catch { return false; }
              });
              if (dup) throw new Error(`Refused: identical text was already sent to this recipient on ${dup.at} (7-day rule). Change the text or wait.`);
              let anchor = 0;
              for (const row of activeJobs) {
                const j = JSON.parse(row.data);
                const at = j.notBefore ? Date.parse(j.notBefore) : (j.createdAt ? Date.parse(j.createdAt) : now);
                anchor = Math.max(anchor, at);
              }
              const lastMsg = db.query("SELECT at FROM messages WHERE status IN ('sent', 'unverified') ORDER BY id DESC LIMIT 1").get() as { at: string } | null;
              if (lastMsg) anchor = Math.max(anchor, Date.parse(lastMsg.at) || 0);
              if (anchor > 0) {
                const minPlanned = anchor + GAP_MS;
                const planned = Math.max(now, minPlanned + Math.floor(Math.random() * JITTER_MS));
                if (!job.notBefore || Date.parse(String(job.notBefore)) < minPlanned) {
                  job.notBefore = new Date(planned).toISOString();
                }
              }
            }
            if (job.action === "tgSendMessage" || job.action === "tgSendMedia") {
              const tgArgs = job.args as Record<string, any>;
              const chat = telegramChat(tgArgs.chat);
              const text = job.action === "tgSendMessage" ? String(tgArgs.text) : String(tgArgs.caption || "");
              const now = Date.now();
              const cap = capFromEnv();
              const startOfToday = new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate()).toISOString();
              const usedToday = db.query("SELECT COUNT(*) as count FROM messages WHERE platform = 'tg' AND status IN ('sent', 'unverified') AND at >= ?").get(startOfToday) as { count: number };
              const activeJobs = db.query("SELECT data FROM jobs WHERE json_extract(data, '$.action') IN ('tgSendMessage', 'tgSendMedia') AND json_extract(data, '$.status') IN ('queued', 'running')").all() as { data: string }[];
              const normInput = text ? text.replace(/\s+/g, " ").trim().toLowerCase() : "";
              for (const row of activeJobs) {
                const j = JSON.parse(row.data);
                try {
                  const jChat = telegramChat(j.args?.chat || "");
                  if (jChat.toLowerCase() === chat.toLowerCase()) {
                    if (normInput) {
                      const jText = (j.action === "tgSendMessage" ? String(j.args?.text || "") : String(j.args?.caption || "")).replace(/\s+/g, " ").trim().toLowerCase();
                      if (jText === normInput) {
                        throw new Error("Refused: identical text is already queued or running (7-day rule). Change the text or wait.");
                      }
                    }
                    if (tgArgs.sha256 && j.args?.sha256 && String(j.args.sha256) === String(tgArgs.sha256)) {
                      throw new Error("Refused: identical file is already queued or running (7-day rule). Change the file or wait.");
                    }
                  }
                } catch (err: any) {
                  if (err.message.includes("already queued or running")) throw err;
                }
              }
              const totalToday = usedToday.count + activeJobs.length;
              if (totalToday >= cap) {
                const err: any = new Error(`Daily message cap reached: ${totalToday} of ${cap} messages on tg today (SOCMEDIA_MAX_MESSAGES_PER_DAY). Try again tomorrow.`);
                err.code = "RATE_LIMIT";
                throw err;
              }
              if (text.trim()) {
                const sevenDaysAgo = new Date(now - DUP_MS).toISOString();
                const recent = db.query("SELECT at, toUrl, text FROM messages WHERE platform = 'tg' AND status IN ('sent', 'unverified') AND at >= ?").all(sevenDaysAgo) as { at: string; toUrl: string; text: string }[];
                const dup = recent.find((r) => r.toUrl.toLowerCase() === chat.toLowerCase() && r.text.replace(/\s+/g, " ").trim().toLowerCase() === normInput);
                if (dup) throw new Error(`Refused: identical text was already sent to this recipient on ${dup.at} (7-day rule). Change the text or wait.`);
              }
              let anchor = 0;
              for (const row of activeJobs) {
                const j = JSON.parse(row.data);
                const at = j.notBefore ? Date.parse(j.notBefore) : (j.createdAt ? Date.parse(j.createdAt) : now);
                anchor = Math.max(anchor, at);
              }
              const lastMsg = db.query("SELECT at FROM messages WHERE platform = 'tg' AND status IN ('sent', 'unverified') ORDER BY id DESC LIMIT 1").get() as { at: string } | null;
              if (lastMsg) anchor = Math.max(anchor, Date.parse(lastMsg.at) || 0);
              if (anchor > 0) {
                const minPlanned = anchor + GAP_MS;
                const planned = Math.max(now, minPlanned + Math.floor(Math.random() * JITTER_MS));
                if (!job.notBefore || Date.parse(String(job.notBefore)) < minPlanned) {
                  job.notBefore = new Date(planned).toISOString();
                }
              }
            }
            if (job.action === "tiktokUpload") {
              const ttArgs = job.args as Record<string, any>;
              const fileSha = String(ttArgs.sha256);
              const now = Date.now();
              const cap = tiktokUploadsCapFromEnv();
              const startOfToday = new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate()).toISOString();
              const usedToday = db.query("SELECT COUNT(*) as count FROM uploads WHERE platform = 'tt' AND status IN ('sent', 'unverified') AND at >= ?").get(startOfToday) as { count: number };
              const activeJobs = db.query("SELECT data FROM jobs WHERE json_extract(data, '$.action') = 'tiktokUpload' AND json_extract(data, '$.status') IN ('queued', 'running')").all() as { data: string }[];
              for (const row of activeJobs) {
                const j = JSON.parse(row.data);
                if (fileSha && String(j.args?.sha256) === fileSha) {
                  throw new Error("Refused: identical file is already queued or running (7-day rule). Change the file or wait.");
                }
              }
              const totalToday = usedToday.count + activeJobs.length;
              if (totalToday >= cap) {
                const err: any = new Error(`Daily upload cap reached: ${totalToday} of ${cap} uploads on tt today (SOCMEDIA_MAX_TIKTOK_UPLOADS_PER_DAY). Try again tomorrow.`);
                err.code = "RATE_LIMIT";
                throw err;
              }
              const sevenDaysAgo = new Date(now - DUP_MS).toISOString();
              const recent = db.query("SELECT at, sha256 FROM uploads WHERE platform = 'tt' AND sha256 = ? AND status IN ('sent', 'unverified') AND at >= ?").get(fileSha, sevenDaysAgo) as { at: string; sha256: string } | null;
              if (recent) throw new Error(`Refused: identical file was already uploaded on ${recent.at} (7-day rule). Change the file or wait.`);
            }
            if (job.action === "tgCreateChannel") {
              const cap = tgChannelsCapFromEnv();
              const startOfToday = new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate()).toISOString();
              const usedToday = db.query("SELECT COUNT(*) as count FROM channels WHERE platform = 'tg' AND status IN ('sent', 'unverified') AND at >= ?").get(startOfToday) as { count: number };
              const activeJobs = db.query("SELECT data FROM jobs WHERE json_extract(data, '$.action') = 'tgCreateChannel' AND json_extract(data, '$.status') IN ('queued', 'running')").all() as { data: string }[];
              const totalToday = usedToday.count + activeJobs.length;
              if (totalToday >= cap) {
                const err: any = new Error(`Daily channel creation cap reached: ${totalToday} of ${cap} channels on tg today (SOCMEDIA_MAX_TG_CHANNELS_PER_DAY). Try again tomorrow.`);
                err.code = "RATE_LIMIT";
                throw err;
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
