import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
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
