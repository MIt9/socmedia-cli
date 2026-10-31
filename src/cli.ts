import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createConnection, createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { dlopen, FFIType } from "bun:ffi";
import { Database } from "bun:sqlite";

const stateDir = process.env.SOCMEDIA_STATE_DIR ?? join(homedir(), ".socmedia-cli");
const socketPath = join(stateDir, "service.sock");
const lockPath = join(stateDir, "service.lock");
const identity = "socmedia-service-v1";
const pairingPath = join(stateDir, "extension-pairing.json");
const extensionVersion = "0.1.0";
const actions = new Set(["getProfile", "getPosts", "getPost", "getComments", "search", "screenshot", "readInbox", "readThread", "readPage", "snapshot", "scroll", "listTabs", "useTab", "ytStudioRead", "click", "downloadProfile"]);

function validateJob(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Job must be an object");
  const job = value as { action?: unknown; args?: unknown; key?: unknown; notBefore?: unknown };
  if (typeof job.action !== "string" || !actions.has(job.action)) throw new Error("Unknown or restricted action");
  if (!job.args || typeof job.args !== "object" || Array.isArray(job.args)) throw new Error("--args must be a JSON object");
  if (job.key !== undefined && (typeof job.key !== "string" || !job.key)) throw new Error("--key must be a nonempty string");
  if (job.notBefore !== undefined && (typeof job.notBefore !== "string" || !Number.isFinite(Date.parse(job.notBefore)))) throw new Error("--not-before must be a valid ISO date");
  return job;
}

async function status(): Promise<{ running: boolean; pid?: number; extension?: unknown }> {
  return new Promise((resolve) => {
    const socket = createConnection(socketPath);
    let data = "";
    const timer = setTimeout(() => { socket.destroy(); resolve({ running: false }); }, 1000);
    socket.once("error", () => { clearTimeout(timer); resolve({ running: false }); });
    socket.on("data", (chunk) => {
      data += chunk.toString();
      if (!data.includes("\n")) return;
      clearTimeout(timer);
      socket.destroy();
      try {
        const response = JSON.parse(data.split("\n")[0]!);
        if (response.identity === identity && Number.isInteger(response.pid) && response.pid > 0) {
          resolve({ running: true, pid: response.pid, extension: response.extension });
          return;
        }
      } catch { /* not a socmedia response */ }
      resolve({ running: false });
    });
    socket.once("end", () => { clearTimeout(timer); resolve({ running: false }); });
  });
}

async function start() {
  const existing = await status();
  if (existing.running) return existing;
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const child = spawn(process.execPath, [import.meta.path, "--service-daemon"], {
    detached: true, stdio: "ignore", env: process.env,
  });
  child.unref();
  for (let i = 0; i < 100; i++) {
    const current = await status();
    if (current.running) return current;
    await Bun.sleep(30);
  }
  throw new Error("Service did not start; check the state directory and existing socket or lock");
}

async function stop() {
  if (!(await status()).running) return { running: false };
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection(socketPath);
    let data = "";
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("Service stop timed out")); }, 1000);
    socket.once("error", (error) => { clearTimeout(timer); reject(error); });
    socket.on("data", (chunk) => {
      data += chunk.toString();
      if (!data.includes("\n")) return;
      try {
        const greeting = JSON.parse(data.split("\n")[0]!);
        if (greeting.identity !== identity) throw new Error("Not a socmedia service");
        clearTimeout(timer);
        socket.end("stop\n", () => resolve());
      } catch (error) { clearTimeout(timer); socket.destroy(); reject(error); }
    });
  });
  for (let i = 0; i < 100; i++) {
    if (!(await status()).running) return { running: false };
    await Bun.sleep(30);
  }
  throw new Error("Service did not stop");
}

async function queueRequest(command: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let data = "";
    let identified = false;
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("Service request timed out")); }, 15000);
    socket.once("error", (error) => { clearTimeout(timer); reject(error); });
    socket.on("data", (chunk) => {
      data += chunk.toString();
      while (data.includes("\n")) {
        const end = data.indexOf("\n");
        const line = data.slice(0, end);
        data = data.slice(end + 1);
        try {
          const message = JSON.parse(line);
          if (!identified) {
            if (message.identity !== identity) throw new Error("Not a socmedia service");
            identified = true;
            socket.write(command + "\n");
          } else {
            clearTimeout(timer); socket.destroy();
            if (message.error) reject(new Error(message.error)); else resolve(message);
            return;
          }
        } catch (error) { clearTimeout(timer); socket.destroy(); reject(error); return; }
      }
    });
    socket.once("end", () => { clearTimeout(timer); reject(new Error("Service closed the queue request")); });
  });
}

if (Bun.argv[2] === "--service-daemon") {
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
  type ExtensionData = { token: string; challenge?: { clientNonce: string; serverNonce: string; version: string } };
  let extensionSocket: Bun.ServerWebSocket<ExtensionData> | null = null;
  let connectedVersion: string | null = null;
  const pending = new Map<string, { ws: Bun.ServerWebSocket<ExtensionData>; finish: (reply: unknown) => void; timer: ReturnType<typeof setTimeout> }>();
  const extensionTimeout = Number(process.env.SOCMEDIA_EXTENSION_TIMEOUT_MS ?? "10000");
  if (!Number.isInteger(extensionTimeout) || extensionTimeout < 1 || extensionTimeout > 12000) throw new Error("SOCMEDIA_EXTENSION_TIMEOUT_MS must be 1-12000");
  const port = Number(process.env.SOCMEDIA_EXTENSION_PORT ?? "47842");
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("SOCMEDIA_EXTENSION_PORT must be 0-65535");
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
            request.finish(hello.error ? { error: String(hello.error) } : hello.result);
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
          ws.send(JSON.stringify({ type: "hello", version: extensionVersion, compatible: challenge.version === extensionVersion }));
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
  const extensionStatus = () => ({ connected: extensionSocket !== null, version: connectedVersion, compatible: connectedVersion === null ? null : connectedVersion === extensionVersion, port: extensionServer.port });
  const server = createServer((socket) => {
    socket.write(JSON.stringify({ identity, pid: process.pid, extension: extensionStatus() }) + "\n");
    let input = "";
    socket.on("data", (data) => {
      input += data.toString();
      if (!input.includes("\n")) return;
      const command = input.split("\n")[0];
      if (command === "stop") { socket.end(); shutdown(); }
      else if (command === "tabs list") {
        if (!extensionSocket) { socket.end(JSON.stringify({ error: "Extension not connected" }) + "\n"); return; }
        if (connectedVersion !== extensionVersion) { socket.end(JSON.stringify({ error: "Extension version incompatible" }) + "\n"); return; }
        const id = randomBytes(16).toString("hex");
        const ws = extensionSocket;
        const finish = (reply: unknown) => socket.end(JSON.stringify(reply) + "\n");
        const timer = setTimeout(() => { pending.delete(id); finish({ error: "Extension request timed out" }); }, extensionTimeout);
        pending.set(id, { ws, finish, timer });
        ws.send(JSON.stringify({ type: "request", id, action: "tabs.list" }));
      }
      else if (command === "queue list") {
        const rows = db.query("SELECT id, data FROM jobs ORDER BY id DESC").all() as { id: number; data: string }[];
        socket.end(JSON.stringify({ jobs: rows.map((row) => ({ id: row.id, ...JSON.parse(row.data) })) }) + "\n");
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
} else if (Bun.argv.includes("--help")) {
  if (Bun.argv[2] === "service") {
    console.log("Usage: socmedia service <start|status|stop> [--json]\n\nCommands:\n  start   Start the local service or return the running service\n  status  Show service and extension connection status\n  stop    Stop the local service; succeed if already stopped\n\nOptions:\n  --json  Print the result as JSON\n  --help  Show this help message\n\nEnvironment:\n  SOCMEDIA_STATE_DIR             Service data directory\n  SOCMEDIA_EXTENSION_PORT        Extension WebSocket port (default: 47842; 0 selects an available port)\n  SOCMEDIA_EXTENSION_TIMEOUT_MS  Extension request timeout in milliseconds (default: 10000, range: 1-12000)");
  } else if (Bun.argv[2] === "queue") {
    console.log("Usage: socmedia queue <list|get|cancel|enqueue> [options]\n\nCommands:\n  list              List saved queue jobs\n  get <id>          Show a job by its positive numeric ID\n  cancel <id>       Cancel a queued job by ID; cancelling twice returns the same job\n  enqueue <action>  Queue a supported action without executing it\n\nOptions:\n  --args JSON       Action arguments as a JSON object (default: {})\n  --not-before TIME Earliest run time as an ISO date\n  --key KEY         Reuse the same job; changed action, args or time causes a key conflict\n  --json            Print the result as JSON\n  --help            Show this help message");
  } else if (Bun.argv[2] === "tabs") {
    console.log("Usage: socmedia tabs list [--json]\n\nCommands:\n  list    List Social bot group tabs and the selected tab\n\nOptions:\n  --json  Print the result as JSON\n  --help  Show this help message");
  } else if (Bun.argv[2] === "extension") {
    console.log("Usage: socmedia extension pair --id ID [--json]\n\nCommands:\n  pair       Generate a pairing secret for the Chrome extension\n\nOptions:\n  --id ID    Chrome extension ID shown in chrome://extensions\n  --json     Print pairing details as JSON; secret is sensitive\n  --help     Show this help message\n\nPairing replaces any previous pairing; restart the service to disconnect existing clients.");
  } else {
    console.log("Usage: socmedia [options]\n\nCommands:\n  service    Start or inspect the local service\n  queue      Inspect the service queue\n  extension  Pair the Chrome extension\n  tabs       Inspect extension work tabs\n\nOptions:\n  --help     Show this help message");
  }
} else if (Bun.argv[2] === "extension" && Bun.argv[3] === "pair") {
  try {
    if (Bun.argv[4] !== "--id" || !/^[a-p]{32}$/.test(Bun.argv[5] ?? "") || Bun.argv.slice(6).some((arg) => arg !== "--json")) throw new Error("Provide --id followed by the 32-character Chrome extension ID");
    const pairing = { id: Bun.argv[5]!, token: randomBytes(32).toString("hex") };
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const temporary = join(stateDir, `.pairing-${randomBytes(8).toString("hex")}`);
    try {
      writeFileSync(temporary, JSON.stringify(pairing), { mode: 0o600, flag: "wx" });
      renameSync(temporary, pairingPath);
    } finally { rmSync(temporary, { force: true }); }
    console.log(JSON.stringify(pairing));
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
} else if (Bun.argv[2] === "service" && Bun.argv[3] === "status") {
  console.log(JSON.stringify(await status()));
} else if (Bun.argv[2] === "service" && Bun.argv[3] === "start") {
  try { console.log(JSON.stringify(await start())); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
} else if (Bun.argv[2] === "service" && Bun.argv[3] === "stop") {
  try { console.log(JSON.stringify(await stop())); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
} else if (Bun.argv[2] === "tabs" && Bun.argv[3] === "list") {
  try { console.log(JSON.stringify(await queueRequest("tabs list"))); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
} else if (Bun.argv[2] === "queue" && Bun.argv[3] === "list") {
  try { console.log(JSON.stringify(await queueRequest("queue list"))); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
} else if (Bun.argv[2] === "queue" && Bun.argv[3] === "enqueue") {
  try {
    const action = Bun.argv[4];
    let args: unknown = {};
    let key: string | undefined;
    let notBefore: string | undefined;
    for (let i = 5; i < Bun.argv.length; i++) {
      const option = Bun.argv[i];
      if (option === "--json") continue;
      if (!["--args", "--key", "--not-before"].includes(option ?? "") || !Bun.argv[i + 1]) throw new Error(`Invalid option or missing value: ${option}`);
      const value = Bun.argv[++i]!;
      if (option === "--args") { try { args = JSON.parse(value); } catch { throw new Error("--args must be a JSON object"); } }
      else if (option === "--key") key = value;
      else notBefore = value;
    }
    const job = validateJob({ action, args, key, notBefore });
    console.log(JSON.stringify(await queueRequest(`queue enqueue ${JSON.stringify(job)}`)));
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
} else if (Bun.argv[2] === "queue" && (Bun.argv[3] === "get" || Bun.argv[3] === "cancel")) {
  try {
    const id = Bun.argv[4];
    if (!id || !/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))) throw new Error("Job ID must be a positive integer");
    console.log(JSON.stringify(await queueRequest(`queue ${Bun.argv[3]} ${id}`)));
  }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
