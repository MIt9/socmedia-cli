import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Database } from "bun:sqlite";

export function isNewer(latest: string, current: string): boolean {
  const l = latest.split(".").map(Number);
  const c = current.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const lp = l[i] ?? 0;
    const cp = c[i] ?? 0;
    if (lp > cp) return true;
    if (lp < cp) return false;
  }
  return false;
}

export type UpdateContext = {
  currentVersion: string;
  stateDir: string;
  extensionPath: string;
  isCompiled: boolean;
  status: () => Promise<{ running: boolean; extension?: unknown }>;
  queueRequest: (cmd: string) => Promise<unknown>;
  stopService: () => Promise<unknown>;
  startService: () => Promise<unknown>;
};

const DEFAULT_UPDATE_URL = "https://github.com/MIt9/socmedia-cli/releases/latest/download";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

export async function countActiveJobs(ctx: UpdateContext): Promise<number> {
  const s = await ctx.status();
  if (s.running) {
    try {
      const q = (await ctx.queueRequest("queue list")) as { jobs?: { status: string }[] };
      return (q?.jobs ?? []).filter((j) => j.status === "running").length;
    } catch {
      return 0;
    }
  }
  const dbPath = join(ctx.stateDir, "state.sqlite");
  if (existsSync(dbPath)) {
    try {
      const db = new Database(dbPath);
      const rows = db.query("SELECT data FROM jobs").all() as { data: string }[];
      db.close();
      return rows
        .map((r) => {
          try {
            return JSON.parse(r.data);
          } catch {
            return {};
          }
        })
        .filter((j) => j.status === "running").length;
    } catch {
      return 0;
    }
  }
  return 0;
}

type Entry = { url: string; sha256: string };

function baseUrl(): string {
  const base = (process.env.SOCMEDIA_CLI_UPDATE_URL ?? DEFAULT_UPDATE_URL).replace(/\/+$/, "");
  if (!/^(https:\/\/|http:\/\/(127\.0\.0\.1|localhost)[:/])/.test(base)) throw new Error("SOCMEDIA_CLI_UPDATE_URL must be https:// (http only for localhost)");
  return base;
}

// Downloads one release file and verifies it against latest.json; throws before anything is written on a mismatch.
async function download(base: string, entry: Entry | undefined, what: string): Promise<Buffer> {
  if (!entry?.url || !/^[a-f0-9]{64}$/.test(entry.sha256 ?? "")) throw new Error(`latest.json has no url/sha256 for ${what}; nothing was changed`);
  const url = entry.url.includes("://") ? entry.url : `${base}/${entry.url}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download ${what} from ${url}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const actual = sha(buf);
  if (actual !== entry.sha256) throw new Error(`SHA256 mismatch for ${what}: expected ${entry.sha256}, got ${actual}; nothing was changed`);
  return buf;
}

function untar(buf: Buffer, work: string, name: string): string {
  const file = join(work, `${name}.tar.gz`);
  const dir = join(work, name);
  writeFileSync(file, buf);
  mkdirSync(dir);
  const r = spawnSync("tar", ["-xzf", file, "-C", dir]);
  if (r.status !== 0) throw new Error(`Cannot unpack ${name} archive`);
  return dir;
}

export async function runUpdate(ctx: UpdateContext, checkOnly = false) {
  // 1. Read latest.json (the only request --check makes)
  const base = baseUrl();
  let latest: { version?: string; binaries?: Record<string, Entry>; extension?: Entry };
  try {
    const res = await fetch(`${base}/latest.json`, { headers: { "User-Agent": "socmedia-cli" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    latest = (await res.json()) as typeof latest;
  } catch (e) {
    throw new Error(`Cannot read ${base}/latest.json: ${e instanceof Error ? e.message : e}`);
  }
  if (typeof latest.version !== "string" || !/^\d+\.\d+\.\d+$/.test(latest.version)) throw new Error("latest.json has no valid version");

  const currentVer = ctx.currentVersion;
  const updateAvailable = isNewer(latest.version, currentVer);
  const out = {
    current: currentVer,
    latest: latest.version,
    checkOnly,
    updateAvailable,
    hint: updateAvailable
      ? "Update available; run socmedia update or re-run install.sh"
      : latest.version !== currentVer
      ? "Current version is ahead of latest release"
      : "Already up to date",
  };
  if (checkOnly) return out;
  if (!updateAvailable) return { ...out, updated: false, message: "Already up to date" };

  const target = process.env.SOCMEDIA_CLI_BINARY_PATH ?? (ctx.isCompiled ? process.execPath : null);
  if (!target) return { ...out, updated: false, message: "Running from source repository; run git pull && bun install to update" };

  // 2. Never replace anything while a job is running
  const activeCount = await countActiveJobs(ctx);
  if (activeCount > 0) {
    throw new Error(`Cannot update while ${activeCount} job(s) are actively running in the queue; wait for completion or cancel with socmedia queue cancel <id>`);
  }

  const key = `${process.platform}-${process.arch === "arm64" ? "arm64" : "x64"}`;
  const work = (mkdirSync(ctx.stateDir, { recursive: true, mode: 0o700 }), mkdtempSync(join(ctx.stateDir, "update-")));
  try {
    // 3. Download and verify everything before touching anything
    const binDir = untar(await download(base, latest.binaries?.[key], `binary ${key}`), work, "bin");
    const extDir = latest.extension ? untar(await download(base, latest.extension, "extension"), work, "ext") : null;
    const fresh = join(binDir, "socmedia");
    if (!existsSync(fresh)) throw new Error("Release archive has no `socmedia` binary; nothing was changed");
    chmodSync(fresh, 0o755);
    if (process.platform === "darwin") spawnSync("codesign", ["-s", "-", "-f", fresh]);
    if (spawnSync(fresh, ["--help"], { stdio: "ignore" }).status !== 0) throw new Error("The downloaded binary does not run (--help failed); nothing was changed");

    // 4. Binary: staged next to the target, previous kept as .old (hardlink), atomic rename over the target
    const staged = `${target}.new`;
    copyFileSync(fresh, staged);
    chmodSync(staged, 0o755);
    rmSync(`${target}.old`, { force: true });
    if (existsSync(target)) linkSync(target, `${target}.old`);
    renameSync(staged, target);

    // 5. Extension folder: previous kept as .bak, pairing file carried over
    let extension: { path: string; previous: string | null } | null = null;
    if (extDir) {
      const dest = ctx.extensionPath;
      const bak = `${dest}.bak`;
      const hadPrevious = existsSync(dest);
      const pair = join(dest, "pair.json");
      if (hadPrevious && existsSync(pair)) copyFileSync(pair, join(extDir, "pair.json"));
      mkdirSync(join(dest, ".."), { recursive: true });
      if (hadPrevious) { rmSync(bak, { recursive: true, force: true }); renameSync(dest, bak); }
      renameSync(extDir, dest);
      extension = { path: dest, previous: hadPrevious ? bak : null };
    }

    // 6. Only after the replace succeeded: restart the service (new binary) and ask the extension to reload
    const before = (await ctx.status()) as { running: boolean; extension?: { connected?: boolean } };
    let service = "not running";
    let extensionReload = "skipped: service was not running";
    if (before.running) {
      await ctx.stopService();
      await ctx.startService();
      service = "restarted";
      const deadline = Date.now() + Number(process.env.SOCMEDIA_UPDATE_RELOAD_WAIT_MS ?? (before.extension?.connected ? 45000 : 0));
      extensionReload = "skipped: extension not connected";
      for (;;) {
        const s = (await ctx.status()) as { extension?: { connected?: boolean } };
        if (s.extension?.connected) {
          try { await ctx.queueRequest("extension reload"); extensionReload = "sent"; } catch (e) { extensionReload = `skipped: ${e instanceof Error ? e.message : e}`; }
          break;
        }
        if (Date.now() >= deadline) break;
        await sleep(300);
      }
    }

    return {
      current: currentVer,
      latest: latest.version,
      updatedTo: latest.version,
      updated: true,
      binary: { path: target, previous: `${target}.old` },
      extension,
      service,
      extensionReload,
      hint: `Updated to ${latest.version}`,
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
