import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";

const run = async (env: Record<string, string> = {}, ...args: string[]) => {
  const cli = Bun.spawn(["bun", "run", "src/cli.ts", ...args], {
    cwd: import.meta.dir + "/..",
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(cli.stdout).text(),
    new Response(cli.stderr).text(),
    cli.exited,
  ]);
  return { stdout, stderr, exit };
};

test("CLI format defaults to JSON when piped, respects --text, --json, and SOCMEDIA_CLI_FORMAT", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "socmedia-format-"));
  const env = { SOCMEDIA_STATE_DIR: stateDir, SOCMEDIA_EXTENSION_PORT: "0" };
  try {
    // Piped output without flags defaults to JSON
    const piped = await run(env, "service", "status");
    expect(piped.exit).toBe(0);
    expect(() => JSON.parse(piped.stdout)).not.toThrow();
    const json = JSON.parse(piped.stdout);
    expect(json.running).toBe(false);

    // --text flag forces text format
    const textFlag = await run(env, "service", "status", "--text");
    expect(textFlag.exit).toBe(0);
    expect(textFlag.stdout).toContain("Service: stopped");

    // --json flag forces json format
    const jsonFlag = await run(env, "service", "status", "--json");
    expect(jsonFlag.exit).toBe(0);
    expect(() => JSON.parse(jsonFlag.stdout)).not.toThrow();

    // SOCMEDIA_CLI_FORMAT=text forces text even when piped
    const envText = await run({ ...env, SOCMEDIA_CLI_FORMAT: "text" }, "service", "status");
    expect(envText.exit).toBe(0);
    expect(envText.stdout).toContain("Service: stopped");

    // SOCMEDIA_CLI_FORMAT=json forces json
    const envJson = await run({ ...env, SOCMEDIA_CLI_FORMAT: "json" }, "service", "status");
    expect(envJson.exit).toBe(0);
    expect(() => JSON.parse(envJson.stdout)).not.toThrow();
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("structured errors: stderr has JSON in json mode, Error/Hint in text mode", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "socmedia-err-"));
  const env = { SOCMEDIA_STATE_DIR: stateDir, SOCMEDIA_EXTENSION_PORT: "0" };
  try {
    // Piped defaults to json format for errors too
    const errJson = await run(env, "tabs", "use", "invalid-id");
    expect(errJson.exit).not.toBe(0);
    expect(() => JSON.parse(errJson.stderr)).not.toThrow();
    const parsed = JSON.parse(errJson.stderr);
    expect(parsed.error).toContain("Tab ID must be a non-negative integer");

    // Text mode prints Error: ...
    const errText = await run(env, "tabs", "use", "invalid-id", "--text");
    expect(errText.exit).not.toBe(0);
    expect(errText.stderr).toContain("Error: Tab ID must be a non-negative integer");
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("help supports --json and command registry matches implemented commands", async () => {
  const fullHelp = await run({}, "--help", "--json");
  expect(fullHelp.exit).toBe(0);
  const registry = JSON.parse(fullHelp.stdout);
  expect(Array.isArray(registry)).toBe(true);
  const commandNames = registry.map((c: { name: string }) => c.name);
  expect(commandNames).toContain("service");
  expect(commandNames).toContain("queue");
  expect(commandNames).toContain("extension");
  expect(commandNames).toContain("tabs");
  expect(commandNames).toContain("page");
  expect(commandNames).toContain("browser");
  expect(commandNames).toContain("screenshot");
  expect(commandNames).toContain("search");
  expect(commandNames).toContain("post");
  expect(commandNames).toContain("profile");
  expect(commandNames).toContain("contacts");
  expect(commandNames).toContain("inbox");
  expect(commandNames).toContain("message");
  expect(commandNames).toContain("youtube");
  expect(commandNames).toContain("config");

  // Specific command help with --json
  const serviceHelp = await run({}, "service", "--help", "--json");
  expect(serviceHelp.exit).toBe(0);
  const serviceParsed = JSON.parse(serviceHelp.stdout);
  expect(serviceParsed.name).toBe("service");
  expect(serviceParsed.commands).toBeDefined();
});

test("service status reports pinnedId, port and detects PORT_IN_USE when foreign server binds port", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "socmedia-status-ext-"));
  const foreignServer = createServer();
  await new Promise<void>((resolve) => foreignServer.listen(0, "127.0.0.1", resolve));
  const occupiedPort = (foreignServer.address() as { port: number }).port;
  const env = { SOCMEDIA_STATE_DIR: stateDir, SOCMEDIA_EXTENSION_PORT: String(occupiedPort) };

  try {
    const statusRes = await run(env, "service", "status", "--json");
    expect(statusRes.exit).toBe(0);
    const parsed = JSON.parse(statusRes.stdout);
    expect(parsed.running).toBe(false);
    expect(parsed.pinnedId).toBe("ingpbbhdgldgomideaihffffiinjgifj");
    expect(parsed.port).toBe(occupiedPort);
    expect(parsed.portInUse).toBe(true);
    expect(parsed.code).toBe("PORT_IN_USE");
  } finally {
    foreignServer.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});
