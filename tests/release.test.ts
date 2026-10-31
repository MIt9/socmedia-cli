import { test, expect, beforeAll } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import pkg from "../package.json";

const ROOT = join(import.meta.dir, "..");
const V = `v${pkg.version}`;
const sh = (cmd: string, cwd: string, env: Record<string, string> = {}) =>
  spawnSync("sh", ["-c", cmd], { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", ...env } });

// Throwaway copy of the repo with a local bare "origin"; tests never touch the real repo, network or GitHub.
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "socmedia-rel-"));
  const repo = join(dir, "repo");
  mkdirSync(repo);
  expect(sh(`tar -C "${ROOT}" --exclude=.git --exclude=node_modules --exclude=dist -cf - . | tar -C "${repo}" -xf -`, dir).status).toBe(0);
  symlinkSync(join(ROOT, "node_modules"), join(repo, "node_modules"));
  const r = sh(`git init -q -b main && git add -A && git commit -qm c && git init -q --bare ../origin.git && git remote add origin ../origin.git && git push -q origin main && git tag ${V}`, repo);
  expect(r.status).toBe(0);
  // stub gh: logs every call; `release view` answers per $GH_VIEW (notfound|exists)
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), `#!/bin/sh
echo "$@" >> "${dir}/gh.log"
if [ "$1 $2" = "release view" ]; then
  [ "$GH_VIEW" = exists ] && { echo "v1 title"; exit 0; }
  echo "release not found" >&2; exit 1
fi
exit 0
`);
  chmodSync(join(bin, "gh"), 0o755);
  const sha = sh("git rev-parse HEAD", repo).stdout.trim();
  const hook = (env: Record<string, string> = {}, line = `refs/tags/${V} ${sha} refs/tags/${V} ${"0".repeat(40)}`) =>
    sh(`printf '%s\\n' "${line}" | sh .githooks/pre-push origin url`, repo, { PATH: `${bin}:${process.env.PATH}`, GH_VIEW: "notfound", ...env });
  return { dir, repo, sha, hook, ghLog: () => (existsSync(join(dir, "gh.log")) ? readFileSync(join(dir, "gh.log"), "utf8") : "") };
}
const STUBS = { RELEASE_TEST_CMD: "true", RELEASE_TYPECHECK_CMD: "true" };

test("hook and install-hooks.sh exist, are executable, and install-hooks sets core.hooksPath", () => {
  for (const f of [".githooks/pre-push", "scripts/install-hooks.sh"]) expect((statSync(join(ROOT, f)).mode & 0o111) !== 0).toBe(true);
  const t = makeRepo();
  try {
    expect(sh("sh scripts/install-hooks.sh", t.repo).status).toBe(0);
    expect(sh("git config core.hooksPath", t.repo).stdout.trim()).toBe(".githooks");
  } finally { rmSync(t.dir, { recursive: true, force: true }); }
});

test("dry run: real host build, sha verified, prints gh command with ONLY release artifacts and the tagged sha", () => {
  const t = makeRepo();
  try {
    const r = t.hook({ ...STUBS, RELEASE_DRY_RUN: "1" });
    expect(r.status).toBe(0);
    const arch = process.arch === "arm64" ? "arm64" : "x64";
    expect(r.stderr).toContain(`built arches: ${arch}`);
    const line = r.stderr.split("\n").find((l) => l.includes("would run:"))!;
    expect(line).toContain(`release create ${V} --target ${t.sha}`);
    expect(line).toContain(`dist/socmedia-${pkg.version}-darwin-${arch}.tar.gz`);
    expect(line).toContain(`dist/extension-${pkg.version}.tar.gz`);
    expect(line).toContain("dist/latest.json");
    expect(line).toContain("dist/install.sh");
    expect(line).not.toContain("dist/*");
    expect(line).not.toMatch(/dist\/socmedia(\s|$)/);
    expect(t.ghLog()).not.toContain("release create");
  } finally { rmSync(t.dir, { recursive: true, force: true }); }
}, 120000);

test("publish runs gh release create exactly once (stub gh), no dry run", () => {
  const t = makeRepo();
  try {
    const r = t.hook({ ...STUBS, RELEASE_BUILD_CMD: stubBuild(t.repo) });
    expect(r.status).toBe(0);
    const creates = t.ghLog().split("\n").filter((l) => l.startsWith("release create"));
    expect(creates).toHaveLength(1);
    expect(creates[0]).toContain(`--target ${t.sha}`);
  } finally { rmSync(t.dir, { recursive: true, force: true }); }
});

// Writes a minimal consistent dist/ without compiling (fast); `tamper` corrupts the binary archive afterwards.
function stubBuild(repo: string, tamper = false) {
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const js = `const fs=require("fs"),c=require("crypto");fs.rmSync("dist",{recursive:true,force:true});fs.mkdirSync("dist");
const s=(b)=>c.createHash("sha256").update(b).digest("hex");
const bin="socmedia-${pkg.version}-darwin-${arch}.tar.gz",ext="extension-${pkg.version}.tar.gz";
fs.writeFileSync("dist/"+bin,"bin");fs.writeFileSync("dist/"+ext,"ext");fs.writeFileSync("dist/install.sh","#!/bin/sh");fs.writeFileSync("dist/socmedia","bare");
fs.writeFileSync("dist/latest.json",JSON.stringify({version:"${pkg.version}",binaries:{"darwin-${arch}":{url:bin,sha256:s("bin")}},extension:{url:ext,sha256:s("ext")}}));
${tamper ? 'fs.appendFileSync("dist/"+bin,"x");' : ""}`;
  writeFileSync(join(repo, "..", "stub-build.js"), js);
  return `bun ${join(repo, "..", "stub-build.js")}`;
}

test("refuses (non-zero, clear message) in every failure case and never calls gh release create", () => {
  const t = makeRepo();
  try {
    sh("git tag v9.9.9", t.repo);
    const base = { ...STUBS, RELEASE_BUILD_CMD: stubBuild(t.repo) };
    const cases: [string, ReturnType<typeof t.hook>, RegExp][] = [
      ["release exists", t.hook({ ...base, GH_VIEW: "exists" }), /already exists/],
      ["sha mismatch", t.hook({ ...base, RELEASE_BUILD_CMD: stubBuild(t.repo, true) }), /SHA256 mismatch/],
      ["gh missing", t.hook({ ...base, RELEASE_GH: "no-such-gh-binary" }), /gh \(GitHub CLI\) is not installed/],
      ["tests fail", t.hook({ ...base, RELEASE_TEST_CMD: "false" }), /tests failed/],
      ["bad targets", t.hook({ ...base, RELEASE_TARGETS: "x" }), /RELEASE_TARGETS/],
      ["tag != version", t.hook(base, `refs/tags/v9.9.9 ${t.sha} refs/tags/v9.9.9 ${"0".repeat(40)}`), /does not match package.json/],
    ];
    for (const [name, r, re] of cases) { expect(r.status, name).not.toBe(0); expect(r.stderr, name).toMatch(re); }

    // HEAD is not the tagged commit
    sh("git commit -q --allow-empty -m next", t.repo);
    const moved = t.hook(base);
    expect(moved.status).not.toBe(0);
    expect(moved.stderr).toMatch(/HEAD is/);
    // dirty tree
    sh("git reset -q --hard HEAD~1 && echo x >> README.md", t.repo);
    const dirty = t.hook(base);
    expect(dirty.status).not.toBe(0);
    expect(dirty.stderr).toMatch(/not clean/);
    expect(t.ghLog()).not.toContain("release create");
  } finally { rmSync(t.dir, { recursive: true, force: true }); }
}, 60000);

test("SKIP_RELEASE=1 and non-tag pushes do nothing", () => {
  const t = makeRepo();
  try {
    expect(t.hook({ SKIP_RELEASE: "1", RELEASE_TEST_CMD: "false" }).status).toBe(0);
    const branch = t.hook({ RELEASE_TEST_CMD: "false" }, `refs/heads/main ${t.sha} refs/heads/main ${"0".repeat(40)}`);
    expect(branch.status).toBe(0);
    expect(branch.stderr).toBe("");
    expect(t.ghLog()).toBe("");
  } finally { rmSync(t.dir, { recursive: true, force: true }); }
});
