import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, chmodSync, statSync } from "node:fs";
import { join } from "node:path";

const CLI_PATH = join(import.meta.dir, "../src/cli.ts");

test("socmedia doctor returns structured checks in json mode and human readable in text mode", () => {
  // Test JSON mode
  const resJson = spawnSync(process.execPath, [CLI_PATH, "doctor", "--json"], {
    encoding: "utf8",
    env: { ...process.env, SOCMEDIA_CLI_FORMAT: "json" },
  });

  const parsed = JSON.parse(resJson.stdout);
  expect(typeof parsed.ok).toBe("boolean");
  expect(Array.isArray(parsed.checks)).toBe(true);

  const checkNames = parsed.checks.map((c: any) => c.check);
  expect(checkNames).toContain("chrome");
  expect(checkNames).toContain("bun");
  expect(checkNames).toContain("stateDir");
  expect(checkNames).toContain("database");
  expect(checkNames).toContain("port");
  expect(checkNames).toContain("service");
  expect(checkNames).toContain("extension");

  // Every check must have check, ok, and fix if not ok
  for (const c of parsed.checks) {
    expect(typeof c.check).toBe("string");
    expect(typeof c.ok).toBe("boolean");
    if (!c.ok) {
      expect(typeof c.fix).toBe("string");
      expect(c.fix.length).toBeGreaterThan(0);
    }
  }

  // Test Text mode
  const resText = spawnSync(process.execPath, [CLI_PATH, "doctor", "--text"], {
    encoding: "utf8",
    env: { ...process.env, SOCMEDIA_CLI_FORMAT: "text" },
  });

  expect(resText.stdout).toContain("socmedia doctor:");
  expect(resText.stdout).toMatch(/\[(✓|✗)\] chrome/);
  expect(resText.stdout).toMatch(/\[(✓|✗)\] stateDir/);
  expect(resText.stdout).toMatch(/Result:/);
});

test("socmedia update --check returns version info and hints", () => {
  const res = spawnSync(process.execPath, [CLI_PATH, "update", "--check", "--json"], {
    encoding: "utf8",
    env: { ...process.env, SOCMEDIA_CLI_FORMAT: "json" },
  });

  expect(res.status).toBe(0);
  const parsed = JSON.parse(res.stdout);
  expect(parsed.current).toBe("0.16.0");
  expect(typeof parsed.checkOnly).toBe("boolean");
  expect(parsed.checkOnly).toBe(true);
});

test("git release hook .githooks/pre-push is executable and validates version parity and clean tree", () => {
  const hookPath = join(import.meta.dir, "../.githooks/pre-push");
  expect(existsSync(hookPath)).toBe(true);

  const stat = statSync(hookPath);
  // Executable by owner
  expect((stat.mode & 0o111) !== 0).toBe(true);

  const hookContent = Bun.file(hookPath).text();
  return hookContent.then((content) => {
    expect(content).toContain("package.json");
    expect(content).toContain("manifest.json");
    expect(content).toContain("bun test");
    expect(content).toContain("typecheck");
  });
});
