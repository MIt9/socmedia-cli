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

test("socmedia doctor reports PORT_IN_USE when foreign server binds configured port", async () => {
  const { createServer } = await import("node:net");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const stateDir = await mkdtemp(join(tmpdir(), "socmedia-doc-port-"));
  const foreignServer = createServer();
  await new Promise<void>((resolve) => foreignServer.listen(0, "127.0.0.1", resolve));
  const occupiedPort = (foreignServer.address() as { port: number }).port;

  try {
    const res = spawnSync(process.execPath, [CLI_PATH, "doctor", "--json"], {
      encoding: "utf8",
      env: { ...process.env, SOCMEDIA_STATE_DIR: stateDir, SOCMEDIA_EXTENSION_PORT: String(occupiedPort), SOCMEDIA_CLI_FORMAT: "json" },
    });

    const parsed = JSON.parse(res.stdout);
    expect(parsed.ok).toBe(false);
    const portCheck = parsed.checks.find((c: any) => c.check === "port");
    expect(portCheck).toBeDefined();
    expect(portCheck.ok).toBe(false);
    expect(portCheck.code).toBe("PORT_IN_USE");
    expect(portCheck.message).toContain("PORT_IN_USE");
  } finally {
    foreignServer.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("socmedia update refuses to update while jobs are actively running in queue", async () => {
  const { mkdtemp, rm, mkdir } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { Database } = await import("bun:sqlite");
  const stateDir = await mkdtemp(join(tmpdir(), "socmedia-update-running-"));
  await mkdir(stateDir, { recursive: true });

  const db = new Database(join(stateDir, "state.sqlite"));
  db.run("CREATE TABLE IF NOT EXISTS jobs (id INTEGER PRIMARY KEY, data TEXT NOT NULL)");
  db.run("INSERT INTO jobs (id, data) VALUES (1, ?)", [
    JSON.stringify({ id: 1, action: "readPage", status: "running" }),
  ]);
  db.close();

  try {
    const res = spawnSync(process.execPath, [CLI_PATH, "update", "--json"], {
      encoding: "utf8",
      env: { ...process.env, SOCMEDIA_STATE_DIR: stateDir, SOCMEDIA_CLI_FORMAT: "json" },
    });

    expect(res.status).not.toBe(0);
    const errObj = JSON.parse(res.stderr);
    expect(errObj.error).toContain("Cannot update while");
    expect(errObj.error).toContain("actively running in the queue");
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
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
    expect(content).toContain("scripts/build.ts");
    expect(content).toContain("SHA256 mismatch");
    expect(content).toContain("gh release create");
  });
});
