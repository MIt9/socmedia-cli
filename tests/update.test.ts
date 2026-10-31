import { test, expect } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { runUpdate, type UpdateContext } from "../src/update";

const NEWER = "9.9.9";
const KEY = `${process.platform}-${process.arch === "arm64" ? "arm64" : "x64"}`;
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

// A local release: latest.json + binary tar.gz (a shell script named `socmedia`) + extension tar.gz. No real network.
function release(opts: { badBinarySha?: boolean } = {}) {
  const work = mkdtempSync(join(tmpdir(), "socmedia-rel-fixture-"));
  mkdirSync(join(work, "b")); mkdirSync(join(work, "e"));
  writeFileSync(join(work, "b/socmedia"), "#!/bin/sh\necho new-binary\n", { mode: 0o755 });
  writeFileSync(join(work, "e/manifest.json"), JSON.stringify({ version: NEWER }));
  spawnSync("tar", ["-czf", join(work, "bin.tar.gz"), "-C", join(work, "b"), "socmedia"]);
  spawnSync("tar", ["-czf", join(work, "ext.tar.gz"), "-C", join(work, "e"), "."]);
  const bin = readFileSync(join(work, "bin.tar.gz")), ext = readFileSync(join(work, "ext.tar.gz"));
  const files: Record<string, Buffer | string> = {
    "/latest.json": JSON.stringify({ version: NEWER, binaries: { [KEY]: { url: "bin.tar.gz", sha256: opts.badBinarySha ? "0".repeat(64) : sha(bin) } }, extension: { url: "ext.tar.gz", sha256: sha(ext) } }),
    "/bin.tar.gz": bin, "/ext.tar.gz": ext,
  };
  const hits: string[] = [];
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(req) { const p = new URL(req.url).pathname; hits.push(p); const body = files[p]; return body === undefined ? new Response("no", { status: 404 }) : new Response(body as BodyInit); } });
  return { url: `http://127.0.0.1:${server.port}`, hits, close: () => { server.stop(true); rmSync(work, { recursive: true, force: true }); } };
}

function setup(running: { running: boolean; connected?: boolean; jobs?: { status: string }[] } = { running: false }) {
  const dir = mkdtempSync(join(tmpdir(), "socmedia-upd-"));
  const stateDir = join(dir, "state");
  const extensionPath = join(stateDir, "extension");
  const binary = join(dir, "socmedia");
  mkdirSync(extensionPath, { recursive: true });
  writeFileSync(binary, "#!/bin/sh\necho old-binary\n", { mode: 0o755 });
  writeFileSync(join(extensionPath, "manifest.json"), JSON.stringify({ version: "0.0.1" }));
  writeFileSync(join(extensionPath, "pair.json"), "{\"id\":\"x\"}");
  const calls: string[] = [];
  const ctx: UpdateContext = {
    currentVersion: "0.16.0", stateDir, extensionPath, isCompiled: false,
    status: async () => ({ running: running.running, extension: { connected: running.connected ?? false } }),
    queueRequest: async (cmd) => { calls.push(cmd); return cmd === "queue list" ? { jobs: running.jobs ?? [] } : { sent: true }; },
    stopService: async () => { calls.push("stop"); },
    startService: async () => { calls.push("start"); },
  };
  return { dir, stateDir, extensionPath, binary, ctx, calls, done: () => rmSync(dir, { recursive: true, force: true }) };
}
const withEnv = async (srv: { url: string }, binary: string, fn: () => Promise<void>) => {
  const prev = { ...process.env };
  process.env.SOCMEDIA_CLI_UPDATE_URL = srv.url; process.env.SOCMEDIA_CLI_BINARY_PATH = binary; process.env.SOCMEDIA_UPDATE_RELOAD_WAIT_MS = "0";
  try { await fn(); } finally { for (const k of ["SOCMEDIA_CLI_UPDATE_URL", "SOCMEDIA_CLI_BINARY_PATH", "SOCMEDIA_UPDATE_RELOAD_WAIT_MS"]) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; } }
};

test("update --check only compares: one request, nothing replaced, even with a running job", async () => {
  const srv = release(), t = setup({ running: true, jobs: [{ status: "running" }] });
  try {
    await withEnv(srv, t.binary, async () => {
      const r = (await runUpdate(t.ctx, true)) as any;
      expect(r).toMatchObject({ current: "0.16.0", latest: NEWER, updateAvailable: true, checkOnly: true });
      expect(srv.hits).toEqual(["/latest.json"]);
      expect(readFileSync(t.binary, "utf8")).toContain("old-binary");
      expect(t.calls).toEqual([]);
    });
  } finally { srv.close(); t.done(); }
});

test("update refuses while a job is running and changes nothing", async () => {
  const srv = release(), t = setup({ running: true, connected: true, jobs: [{ status: "running" }] });
  try {
    await withEnv(srv, t.binary, async () => {
      await expect(runUpdate(t.ctx)).rejects.toThrow(/Cannot update while 1 job/);
      expect(srv.hits).toEqual(["/latest.json"]);
      expect(readFileSync(t.binary, "utf8")).toContain("old-binary");
      expect(t.calls).toEqual(["queue list"]);
    });
  } finally { srv.close(); t.done(); }
});

test("sha256 mismatch installs nothing: binary, extension and service stay untouched", async () => {
  const srv = release({ badBinarySha: true }), t = setup({ running: true, connected: true });
  try {
    await withEnv(srv, t.binary, async () => {
      await expect(runUpdate(t.ctx)).rejects.toThrow(/SHA256 mismatch/);
      expect(readFileSync(t.binary, "utf8")).toContain("old-binary");
      expect(existsSync(`${t.binary}.old`)).toBe(false);
      expect(existsSync(`${t.binary}.new`)).toBe(false);
      expect(JSON.parse(readFileSync(join(t.extensionPath, "manifest.json"), "utf8")).version).toBe("0.0.1");
      expect(existsSync(`${t.extensionPath}.bak`)).toBe(false);
      expect(t.calls).toEqual(["queue list"]); // no stop/start/reload
    });
  } finally { srv.close(); t.done(); }
});

test("successful update keeps .old, refreshes the extension (previous as .bak), no reload when the service is stopped", async () => {
  const srv = release(), t = setup({ running: false });
  try {
    await withEnv(srv, t.binary, async () => {
      const r = (await runUpdate(t.ctx)) as any;
      expect(r).toMatchObject({ updated: true, updatedTo: NEWER, service: "not running" });
      expect(r.extensionReload).toContain("skipped");
      expect(readFileSync(t.binary, "utf8")).toContain("new-binary");
      expect(readFileSync(`${t.binary}.old`, "utf8")).toContain("old-binary");
      expect(JSON.parse(readFileSync(join(t.extensionPath, "manifest.json"), "utf8")).version).toBe(NEWER);
      expect(JSON.parse(readFileSync(join(`${t.extensionPath}.bak`, "manifest.json"), "utf8")).version).toBe("0.0.1");
      expect(readFileSync(join(t.extensionPath, "pair.json"), "utf8")).toContain("\"x\"");
      expect(t.calls).toEqual([]);
    });
  } finally { srv.close(); t.done(); }
});

test("after a successful replace a running service is restarted and the extension is asked to reload (in that order)", async () => {
  const srv = release(), t = setup({ running: true, connected: true });
  try {
    await withEnv(srv, t.binary, async () => {
      const r = (await runUpdate(t.ctx)) as any;
      expect(r).toMatchObject({ updated: true, service: "restarted", extensionReload: "sent" });
      expect(t.calls).toEqual(["queue list", "stop", "start", "extension reload"]);
    });
  } finally { srv.close(); t.done(); }
});

test("source checkout without SOCMEDIA_CLI_BINARY_PATH is not replaced", async () => {
  const srv = release(), t = setup();
  try {
    process.env.SOCMEDIA_CLI_UPDATE_URL = srv.url;
    const r = (await runUpdate(t.ctx)) as any;
    expect(r.updated).toBe(false);
    expect(r.message).toContain("source");
    expect(srv.hits).toEqual(["/latest.json"]);
  } finally { delete process.env.SOCMEDIA_CLI_UPDATE_URL; srv.close(); t.done(); }
});

test("CLI: update --check uses SOCMEDIA_CLI_UPDATE_URL and exits 0; unsafe URL is rejected", async () => {
  const srv = release();
  try {
    const run = async (url: string) => {
      const p = Bun.spawn(["bun", "run", "src/cli.ts", "update", "--check", "--json"], { cwd: join(import.meta.dir, ".."), env: { ...process.env, SOCMEDIA_CLI_UPDATE_URL: url }, stdout: "pipe", stderr: "pipe" });
      const [out, err, exit] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
      return { out, err, exit };
    };
    const ok = await run(srv.url);
    expect(ok.exit).toBe(0);
    expect(JSON.parse(ok.out)).toMatchObject({ latest: NEWER, updateAvailable: true, checkOnly: true });
    const bad = await run("http://example.com");
    expect(bad.exit).not.toBe(0);
    expect(bad.err).toContain("SOCMEDIA_CLI_UPDATE_URL");
  } finally { srv.close(); }
});

test("CLI: update refuses while the state database has a running job (service stopped)", async () => {
  const { Database } = await import("bun:sqlite");
  const srv = release(), dir = mkdtempSync(join(tmpdir(), "socmedia-upd-db-"));
  try {
    const db = new Database(join(dir, "state.sqlite"));
    db.run("CREATE TABLE jobs (id INTEGER PRIMARY KEY, data TEXT NOT NULL)");
    db.run("INSERT INTO jobs (id, data) VALUES (1, ?)", [JSON.stringify({ id: 1, action: "readPage", status: "running" })]);
    db.close();
    const bin = join(dir, "socmedia"); writeFileSync(bin, "#!/bin/sh\necho old\n", { mode: 0o755 });
    const p = Bun.spawn(["bun", "run", "src/cli.ts", "update", "--json"], { cwd: join(import.meta.dir, ".."), env: { ...process.env, SOCMEDIA_STATE_DIR: dir, SOCMEDIA_EXTENSION_PORT: "0", SOCMEDIA_CLI_UPDATE_URL: srv.url, SOCMEDIA_CLI_BINARY_PATH: bin }, stdout: "pipe", stderr: "pipe" });
    const [err, exit] = await Promise.all([new Response(p.stderr).text(), p.exited]);
    expect(exit).not.toBe(0);
    expect(JSON.parse(err).error).toContain("actively running in the queue");
    expect(readFileSync(bin, "utf8")).toContain("old");
    expect(existsSync(bin + ".old")).toBe(false);
  } finally { srv.close(); rmSync(dir, { recursive: true, force: true }); }
});
