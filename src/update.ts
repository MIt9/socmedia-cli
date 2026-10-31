import { chmodSync, copyFileSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
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
  isCompiled: boolean;
  status: () => Promise<{ running: boolean }>;
  queueRequest: (cmd: string) => Promise<unknown>;
};

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

export async function runUpdate(ctx: UpdateContext, checkOnly = false) {
  // 1. Guard against updating while jobs are actively running in the queue
  const activeCount = await countActiveJobs(ctx);
  if (activeCount > 0) {
    throw new Error(
      `Cannot update while ${activeCount} job(s) are actively running in the queue; wait for completion or cancel with socmedia queue cancel <id>`
    );
  }

  // 2. Fetch latest release info
  let latestTag: string | null = null;
  try {
    const res = await fetch("https://api.github.com/repos/MIt9/socmedia-cli/releases/latest", {
      headers: { "User-Agent": "socmedia-cli" },
    });
    if (res.ok) {
      const data = (await res.json()) as { tag_name?: string };
      if (data?.tag_name) latestTag = data.tag_name;
    }
  } catch {}

  const currentVer = ctx.currentVersion;
  const cleanLatest = latestTag ? latestTag.replace(/^v/, "") : null;
  const updateAvailable = cleanLatest !== null && isNewer(cleanLatest, currentVer);

  const out = {
    current: currentVer,
    latest: cleanLatest,
    checkOnly,
    updateAvailable,
    hint: updateAvailable
      ? "Update available; run socmedia update or re-run install.sh"
      : cleanLatest && cleanLatest !== currentVer
      ? "Current version is ahead of latest release"
      : "Already up to date",
  };

  if (checkOnly) return out;

  if (!updateAvailable) {
    return { ...out, updated: false, message: "Already up to date" };
  }

  if (!ctx.isCompiled) {
    return {
      ...out,
      updated: false,
      message: "Running from source repository; run git pull && bun install to update",
    };
  }

  // 3. Download release artifacts with sha256 verification
  const platform = process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const binaryTarget = process.execPath;
  const downloadUrl = `https://github.com/MIt9/socmedia-cli/releases/download/${latestTag}/socmedia-${latestTag}-${platform}-${arch}.tar.gz`;

  // Fetch latest.json to get expected sha256
  let expectedSha: string | null = null;
  try {
    const manifestResp = await fetch(
      `https://github.com/MIt9/socmedia-cli/releases/download/${latestTag}/latest.json`
    );
    if (manifestResp.ok) {
      const mData = (await manifestResp.json()) as { binaries?: Record<string, { sha256?: string }> };
      expectedSha = mData?.binaries?.[`${platform}-${arch}`]?.sha256 ?? null;
    }
  } catch {}

  const resp = await fetch(downloadUrl);
  if (!resp.ok) throw new Error(`Failed to download update from ${downloadUrl}: ${resp.statusText}`);
  const tarBuf = Buffer.from(await resp.arrayBuffer());

  // Verify sha256 before extraction
  if (expectedSha) {
    const actualSha = createHash("sha256").update(tarBuf).digest("hex");
    if (actualSha !== expectedSha) {
      throw new Error(`SHA256 checksum mismatch for downloaded update: expected ${expectedSha}, got ${actualSha}`);
    }
  }

  const tmpTar = join(tmpdir(), `socmedia-update-${randomBytes(8).toString("hex")}.tar.gz`);
  const tmpExtract = join(tmpdir(), `socmedia-update-${randomBytes(8).toString("hex")}`);
  try {
    writeFileSync(tmpTar, tarBuf);
    mkdirSync(tmpExtract, { recursive: true });
    spawnSync("tar", ["-xzf", tmpTar, "-C", tmpExtract]);
    const newBin = join(tmpExtract, "bin", "socmedia");
    if (!existsSync(newBin)) throw new Error("Downloaded package did not contain bin/socmedia");
    chmodSync(newBin, 0o755);

    if (platform === "darwin") {
      spawnSync("codesign", ["-s", "-", "-f", newBin]);
    }

    // Safe replacement with .old backup and rollback on failure
    const backupBin = `${binaryTarget}.old`;
    try {
      renameSync(binaryTarget, backupBin);
    } catch {}

    try {
      copyFileSync(newBin, binaryTarget);
      chmodSync(binaryTarget, 0o755);
      if (platform === "darwin") {
        spawnSync("codesign", ["-s", "-", "-f", binaryTarget]);
      }
      rmSync(backupBin, { force: true });
    } catch (err) {
      if (existsSync(backupBin) && !existsSync(binaryTarget)) {
        try {
          renameSync(backupBin, binaryTarget);
        } catch {}
      }
      throw err;
    }

    return {
      current: currentVer,
      latest: cleanLatest,
      updatedTo: cleanLatest,
      updated: true,
      hint: `Updated to ${cleanLatest}`,
    };
  } finally {
    rmSync(tmpTar, { force: true });
    rmSync(tmpExtract, { recursive: true, force: true });
  }
}
