import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { createHash } from "node:crypto";
import manifest from "../extension/manifest.json";

const run = async (env: Record<string, string>, ...args: string[]) => {
  const cli = Bun.spawn(["bun", "run", "src/cli.ts", ...args], { cwd: import.meta.dir + "/..", env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([new Response(cli.stdout).text(), new Response(cli.stderr).text(), cli.exited]);
  return { stdout, stderr, exit };
};
const PINNED = "ingpbbhdgldgomideaihffffiinjgifj";
const idFromKey = (key: string) => [...createHash("sha256").update(Buffer.from(key, "base64")).digest("hex").slice(0, 32)].map((n) => String.fromCharCode(97 + parseInt(n, 16))).join("");
const freePort = async () => { const s = createServer(); await new Promise<void>((r) => s.listen(0, "127.0.0.1", r)); const p = (s.address() as { port: number }).port; await new Promise<void>((r) => s.close(() => r())); return p; };
const kill = async (pid?: number) => { if (!pid) return; try { process.kill(pid, "SIGTERM"); } catch {} for (let i = 0; i < 100; i++) { try { process.kill(pid, 0); } catch { break; } await Bun.sleep(20); } };

test("status (service down) shows the ready-made extension URL, extensionId derived from the manifest key and extensionPinned", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "socmedia-st-"));
  const port = await freePort();
  try {
    const r = await run({ SOCMEDIA_STATE_DIR: stateDir, SOCMEDIA_EXTENSION_PORT: String(port) }, "service", "status", "--json");
    const s = JSON.parse(r.stdout);
    expect(s.running).toBe(false);
    expect(s.extensionUrl).toBe(`ws://127.0.0.1:${port}/extension`);
    expect(s.extensionId).toBe(idFromKey(manifest.key));
    expect(s.extensionId).toBe(PINNED);
    expect(s.extensionPinned).toBe(true);
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});

test("status (service running) also reports extensionUrl, extensionId and extensionPinned", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "socmedia-st-run-"));
  const env = { SOCMEDIA_STATE_DIR: stateDir, SOCMEDIA_EXTENSION_PORT: "0" };
  let pid: number | undefined;
  try {
    pid = JSON.parse((await run(env, "service", "start", "--json")).stdout).pid;
    const s = JSON.parse((await run(env, "service", "status", "--json")).stdout);
    expect(s).toMatchObject({ running: true, extensionId: PINNED, extensionPinned: true });
    expect(s.extensionUrl).toBe(`ws://127.0.0.1:${s.extension.port}/extension`);
    const text = (await run(env, "service", "status", "--text")).stdout;
    expect(text).toContain("Pinned ID:");
  } finally { await kill(pid); await rm(stateDir, { recursive: true, force: true }); }
});

test("PORT_IN_USE: own exit code 8, with port, owner PID and hint (start error and status)", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "socmedia-piu-"));
  const foreign = createServer();
  await new Promise<void>((r) => foreign.listen(0, "127.0.0.1", r));
  const port = (foreign.address() as { port: number }).port;
  const env = { SOCMEDIA_STATE_DIR: stateDir, SOCMEDIA_EXTENSION_PORT: String(port), SOCMEDIA_CLI_FORMAT: "json" };
  try {
    const start = await run(env, "service", "start", "--json");
    expect(start.exit).toBe(8);
    const err = JSON.parse(start.stderr);
    expect(err).toMatchObject({ code: "PORT_IN_USE", port, ownerPid: process.pid });
    expect(err.error).toContain(String(port));
    expect(err.hint).toContain("config set port");
    const st = JSON.parse((await run(env, "service", "status", "--json")).stdout);
    expect(st).toMatchObject({ running: false, portInUse: true, code: "PORT_IN_USE", port, ownerPid: process.pid });
    expect(st.hint).toContain("config set port");
    // other errors keep exit 1
    expect((await run(env, "config", "set", "port", "0", "--json")).exit).toBe(1);
  } finally { foreign.close(); await rm(stateDir, { recursive: true, force: true }); }
});

// A service of an older version greets on the socket without the `identity` field.
async function legacyService(daemonArgs: string[]) {
  const stateDir = await mkdtemp(join(tmpdir(), "socmedia-legacy-"));
  const proc = Bun.spawn(["bun", "-e", "setInterval(()=>{},1e6)", ...daemonArgs], { stdout: "ignore", stderr: "ignore" });
  const server = createServer((s) => s.end(JSON.stringify({ pid: proc.pid, extension: { connected: false } }) + "\n"));
  await new Promise<void>((r) => server.listen(join(stateDir, "service.sock"), r));
  return { stateDir, proc, server, env: { SOCMEDIA_STATE_DIR: stateDir, SOCMEDIA_EXTENSION_PORT: "0" }, close: async () => { proc.kill(); await new Promise<void>((r) => server.close(() => r())); await rm(stateDir, { recursive: true, force: true }); } };
}

test("an older service without the identity field is recognised as ours (and stoppable); an unrelated pid is not", async () => {
  const own = await legacyService(["--service-daemon"]);
  try {
    const st = JSON.parse((await run(own.env, "service", "status", "--json")).stdout);
    expect(st).toMatchObject({ running: true, pid: own.proc.pid, legacy: true });
    const stop = await run(own.env, "service", "stop", "--json");
    expect(stop.exit).toBe(0);
    expect(JSON.parse(stop.stdout)).toEqual({ running: false });
    await Promise.race([own.proc.exited, Bun.sleep(3000)]);
    expect(own.proc.killed || own.proc.exitCode !== null || own.proc.signalCode !== null).toBe(true);
  } finally { await own.close(); }
  const foreign = await legacyService(["--unrelated"]);
  try {
    const st = JSON.parse((await run(foreign.env, "service", "status", "--json")).stdout);
    expect(st.running).toBe(false);
    expect(foreign.proc.exitCode).toBeNull(); // untouched
  } finally { await foreign.close(); }
});
