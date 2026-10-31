import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(import.meta.dir, "../scripts/new-command.ts");
const gen = (...args: string[]) => Bun.spawnSync(["bun", script, ...args], { stdout: "pipe", stderr: "pipe" });

test("new-command scaffolds a module and a test, prints the checklist, and refuses to overwrite", () => {
  const dir = mkdtempSync(join(tmpdir(), "socmedia-newcmd-"));
  try {
    const first = gen("widget", "--root", dir);
    expect(first.exitCode).toBe(0);
    expect(first.stdout.toString()).toContain("Remaining checklist");
    expect(first.stdout.toString()).toContain("COMMANDS.md");
    const modulePath = join(dir, "src/commands/widget.ts");
    const testPath = join(dir, "tests/widget.test.ts");
    expect(readFileSync(modulePath, "utf8")).toContain('name: "widget"');
    expect(existsSync(testPath)).toBe(true);

    const before = readFileSync(modulePath, "utf8");
    const second = gen("widget", "--root", dir);
    expect(second.exitCode).toBe(1);
    expect(second.stderr.toString()).toContain("Refusing to overwrite");
    expect(readFileSync(modulePath, "utf8")).toBe(before);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("new-command rejects bad names and writes nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "socmedia-newcmd-"));
  try {
    for (const bad of ["Bad", "a-b", "../x", ""]) {
      const r = gen(bad, "--root", dir);
      expect(r.exitCode).toBe(2);
    }
    expect(existsSync(join(dir, "src"))).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("new-command accepts --root before the name", () => {
  const dir = mkdtempSync(join(tmpdir(), "socmedia-newcmd-"));
  try {
    expect(gen("--root", dir, "gadget").exitCode).toBe(0);
    expect(existsSync(join(dir, "src/commands/gadget.ts"))).toBe(true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
