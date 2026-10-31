import { mkdirSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { DoctorCheck, runDoctor as runDoctorModule } from "../doctor";
import { runUpdate as runUpdateModule } from "../update";
import { stateDir, socketPath, identity, extensionPath, extensionVersion, PINNED_EXTENSION_ID, CliError } from "./state";
import { effectivePort } from "./config";
import { extensionIdentity } from "./extension";

export async function isPortInUse(port: number): Promise<boolean> {
  if (!port || port <= 0 || port > 65535) return false;
  return new Promise((res) => {
    const s = createServer();
    s.once("error", () => res(true));
    s.once("listening", () => { s.close(() => res(false)); });
    s.listen(port, "127.0.0.1");
  });
}

// Best-effort PID of the process listening on a TCP port (lsof may be absent).
export function portOwnerPid(port: number): number | null {
  const r = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" });
  const pid = Number((r.stdout ?? "").split("\n").find(Boolean));
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}
// A service from a version without the identity field is still ours if its process is a socmedia daemon.
export const isOwnProcess = (pid: number) => /--service-daemon|socmedia/.test(spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).stdout ?? "");
export const portHint = "Stop the process holding the port, or choose another: socmedia config set port <PORT> (then enter it in the extension popup)";

export async function status(): Promise<{ running: boolean; pid?: number; version?: string; extension?: unknown; halted?: unknown; extensionUrl?: string; portSource?: string; port: number; pinnedId: string; portInUse?: boolean; code?: string; ownerPid?: number | null; hint?: string; legacy?: boolean; extensionId?: string | null; extensionPinned?: boolean }> {
  const pCfg = effectivePort();
  const configuredPort = pCfg.port;
  return new Promise((resolve) => {
    const socket = createConnection(socketPath);
    let data = "";
    const finishAbsent = async () => {
      const inUse = await isPortInUse(configuredPort);
      resolve({
        running: false,
        port: configuredPort,
        portSource: pCfg.source,
        pinnedId: PINNED_EXTENSION_ID,
        ...extensionIdentity(),
        extensionUrl: `ws://127.0.0.1:${configuredPort}/extension`,
        ...(inUse ? { portInUse: true, code: "PORT_IN_USE", ownerPid: portOwnerPid(configuredPort), hint: portHint } : {}),
      });
    };
    const timer = setTimeout(() => { socket.destroy(); finishAbsent(); }, 1000);
    socket.once("error", () => { clearTimeout(timer); finishAbsent(); });
    socket.on("data", (chunk) => {
      data += chunk.toString();
      if (!data.includes("\n")) return;
      clearTimeout(timer);
      socket.destroy();
      try {
        const response = JSON.parse(data.split("\n")[0]!);
        const legacy = response.identity === undefined && Number.isInteger(response.pid) && response.pid > 0 && isOwnProcess(response.pid);
        if ((response.identity === identity || legacy) && Number.isInteger(response.pid) && response.pid > 0) {
          const ext = response.extension as { port?: number } | undefined;
          resolve({
            running: true,
            pid: response.pid,
            version: response.version,
            extension: response.extension,
            halted: response.halted,
            extensionUrl: response.extensionUrl,
            portSource: response.portSource,
            port: ext?.port ?? configuredPort,
            pinnedId: PINNED_EXTENSION_ID,
            ...extensionIdentity(),
            ...(legacy ? { legacy: true } : {}),
          });
          return;
        }
      } catch { /* not a socmedia response */ }
      finishAbsent();
    });
    socket.once("end", () => { clearTimeout(timer); finishAbsent(); });
  });
}

export async function start() {
  const existing = await status();
  if (existing.running) return existing;
  if (existing.portInUse) {
    throw new CliError(`PORT_IN_USE: port ${existing.port} is held by another process${existing.ownerPid ? ` (pid ${existing.ownerPid})` : ""}, not by socmedia`, portHint, "PORT_IN_USE", { port: existing.port, ownerPid: existing.ownerPid ?? null });
  }
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const isCompiled = import.meta.path.startsWith("/$bunfs");
  const childArgs = isCompiled ? ["--service-daemon"] : [join(import.meta.dir, "..", "cli.ts"), "--service-daemon"];
  const child = spawn(process.execPath, childArgs, {
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

export async function stop() {
  const current = await status();
  if (!current.running) return { running: false };
  if (current.legacy && current.pid) process.kill(current.pid, "SIGTERM"); // older service: no identity, no stop protocol guarantee
  else await new Promise<void>((resolve, reject) => {
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

export async function queueRequest(command: string): Promise<unknown> {
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
            if (message.error && !message.status) reject(new Error(message.error)); else resolve(message);
            return;
          }
        } catch (error) { clearTimeout(timer); socket.destroy(); reject(error); return; }
      }
    });
    socket.once("end", () => { clearTimeout(timer); reject(new Error("Service closed the queue request")); });
  });
}

export async function runPageJob(action: "snapshot" | "readPage" | "getProfile" | "getComments" | "getPosts" | "getPost" | "screenshot" | "search" | "readInbox" | "readThread" | "sendMessage" | "ytStudioRead" | "click" | "scroll", args: Record<string, unknown>): Promise<unknown> {
  const current = await status();
  if (!current.running) throw new Error("Service not running");
  if (current.halted) {
    const reason = (current.halted as { reason?: string }).reason || "security challenge";
    throw new Error(`HALT: ${reason}; resolve it in Chrome and run service resume`);
  }
  const extension = current.extension as { connected?: boolean; compatible?: boolean } | undefined;
  if (!extension?.connected) throw new Error("Extension not connected");
  if (!extension.compatible) throw new Error("Extension version incompatible");
  const created = await queueRequest(`queue enqueue ${JSON.stringify({ action, args })}`) as { id: number };
  const deadline = Date.now() + (action === "getComments" || action === "getPosts" || action === "getPost" || action === "search" ? 75000 : action === "getProfile" ? 60000 : 30000);
  while (Date.now() < deadline) {
    let job = await queueRequest(`queue get ${created.id}`) as { status: string; result?: unknown; error?: string | { code?: string; reason?: string } };
    if (!["done", "failed", "cancelled"].includes(job.status)) {
      const state = await status();
      if (state.halted) {
        // HALT and the job result are persisted together; status can observe them
        // after the earlier job read, so read the job again before reporting it.
        job = await queueRequest(`queue get ${created.id}`) as typeof job;
        if (!["done", "failed", "cancelled"].includes(job.status)) throw new Error(`Job ${created.id} is ${job.status}; resolve the challenge and run service resume`);
      }
      if (!state.running) throw new Error(`Service stopped; inspect job ${created.id} after restarting`);
    }
    if (job.status === "done") return job.result;
    if (job.status === "failed" || job.status === "cancelled") {
      if (typeof job.error === "object" && job.error?.code === "HALT") throw new Error(`HALT: ${job.error.reason}; resolve it in Chrome and run service resume`);
      throw new Error(`Job ${created.id}: ${typeof job.error === "object" ? job.error?.reason : job.error || job.status}`);
    }
    await Bun.sleep(50);
  }
  throw new Error(`Job ${created.id} still pending; inspect it with queue get`);
}

export async function runDoctor(): Promise<{ ok: boolean; checks: DoctorCheck[] }> {
  return runDoctorModule({
    stateDir,
    extensionPath,
    extensionVersion,
    status,
    isPortInUse,
  });
}

export async function runUpdate(checkOnly = false) {
  return runUpdateModule(
    {
      currentVersion: extensionVersion,
      stateDir,
      extensionPath,
      isCompiled: import.meta.path.startsWith("/$bunfs"),
      status,
      queueRequest,
      stopService: stop,
      startService: start,
    },
    checkOnly
  );
}
