#!/usr/bin/env bun
// Build release artifacts into dist/: compiled binary per arch, tar.gz per arch, extension tar.gz, latest.json.
//   bun scripts/build.ts          host arch only
//   bun scripts/build.ts --all    darwin-arm64 and darwin-x64
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import pkg from "../package.json";
import manifest from "../extension/manifest.json";

const root = join(import.meta.dir, "..");
const dist = join(root, "dist");
const sha = (f: string) => createHash("sha256").update(readFileSync(f)).digest("hex");
const run = (cmd: string[]) => {
  const r = Bun.spawnSync(cmd, { stdout: "inherit", stderr: "inherit", cwd: root });
  if (r.exitCode !== 0) throw new Error(`failed: ${cmd.join(" ").slice(0, 120)}`);
};

function readDirRecursive(dir: string, base = dir): Record<string, Buffer> {
  const entries: Record<string, Buffer> = {};
  for (const name of readdirSync(dir)) {
    if (name === ".DS_Store") continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      Object.assign(entries, readDirRecursive(full, base));
    } else {
      entries[relative(base, full)] = readFileSync(full);
    }
  }
  return entries;
}

const files = readDirRecursive(join(root, "extension"));
const ev = manifest.version;
const [a, b] = [ev, pkg.version].map((v) => v.split("."));
if (a![0] !== b![0] || a![1] !== b![1]) throw new Error(`extension ${ev} and package ${pkg.version} differ in major.minor: bump both together`);

const bundle = JSON.stringify(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, v.toString("base64")])));

const hostArch = process.arch === "arm64" ? "arm64" : "x64";
const arches = process.argv.includes("--all") ? ["arm64", "x64"] : [hostArch];
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
const stage = mkdtempSync(join(tmpdir(), "socmedia-build-"));
const binaries: Record<string, { url: string; sha256: string }> = {};

try {
  for (const arch of arches) {
    const bin = join(stage, arch, "socmedia");
    mkdirSync(join(stage, arch));
    run(["bun", "build", "--compile", `--target=bun-darwin-${arch}`, "--define", `EXT_BUNDLE_JSON=${JSON.stringify(bundle)}`, "src/cli.ts", "--outfile", bin]);
    chmodSync(bin, 0o755);
    const name = `socmedia-${pkg.version}-darwin-${arch}.tar.gz`;
    run(["tar", "-czf", join(dist, name), "-C", join(stage, arch), "socmedia"]);
    binaries[`darwin-${arch}`] = { url: name, sha256: sha(join(dist, name)) };
    if (arch === hostArch) copyFileSync(bin, join(dist, "socmedia"));
  }

  const extDir = join(stage, "extension");
  for (const [f, buf] of Object.entries(files)) {
    mkdirSync(dirname(join(extDir, f)), { recursive: true });
    writeFileSync(join(extDir, f), buf);
  }
  const extName = `extension-${ev}.tar.gz`;
  run(["tar", "-czf", join(dist, extName), "-C", extDir, "."]);

  writeFileSync(
    join(dist, "latest.json"),
    JSON.stringify({ version: pkg.version, binaries, extension: { url: extName, sha256: sha(join(dist, extName)) } }, null, 2) + "\n"
  );
  copyFileSync(join(root, "scripts", "install.sh"), join(dist, "install.sh"));
} finally {
  rmSync(stage, { recursive: true, force: true });
}

console.log(`built ${pkg.version} (${arches.join(", ")}) -> ${dist}`);
