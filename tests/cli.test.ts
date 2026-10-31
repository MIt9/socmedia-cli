import { expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { runInNewContext } from "node:vm";
import { createHash, createHmac, randomBytes, webcrypto } from "node:crypto";
import packageInfo from "../package.json";
import manifest from "../extension/manifest.json";

const projectVersion = packageInfo.version;

test("port configuration honors env over saved setting and reports running endpoint", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "socmedia-port-config-"));
  const { SOCMEDIA_EXTENSION_PORT: _inheritedPort, ...baseEnv } = process.env;
  const run = async (override: Record<string, string>, ...args: string[]) => {
    const cli = Bun.spawn(["bun", "run", "src/cli.ts", ...args], { cwd: import.meta.dir + "/..", env: { ...baseEnv, SOCMEDIA_STATE_DIR: stateDir, ...override }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exit] = await Promise.all([new Response(cli.stdout).text(), new Response(cli.stderr).text(), cli.exited]);
    return { stdout, stderr, exit };
  };
  let pid: number | undefined;
  try {
    const help = await run({}, "config", "--help");
    expect(help.stdout).toContain("get"); expect(help.stdout).toContain("set"); expect(help.stdout).toContain("unset");
    expect(JSON.parse((await run({}, "config", "get", "port", "--json")).stdout)).toMatchObject({ port: 47842, source: "default" });
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const address = probe.address(); if (!address || typeof address === "string") throw new Error("no test port");
    const selectedPort = address.port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    expect((await run({}, "config", "set", "port", String(selectedPort), "--json")).exit).toBe(0);
    expect(JSON.parse((await run({}, "config", "get", "port", "--json")).stdout)).toMatchObject({ port: selectedPort, source: "config" });
    const started = JSON.parse((await run({}, "service", "start", "--json")).stdout); pid = started.pid;
    expect(started.extension.port).toBe(selectedPort); expect(started.portSource).toBe("config");
    expect(started.extensionUrl).toBe(`ws://127.0.0.1:${selectedPort}/extension`);
    expect((await run({}, "config", "set", "port", "0", "--json")).exit).not.toBe(0);
    const override = JSON.parse((await run({ SOCMEDIA_EXTENSION_PORT: "0" }, "config", "get", "port", "--json")).stdout);
    expect(override).toMatchObject({ port: 0, source: "environment" });
    expect((await run({}, "config", "unset", "port", "--json")).exit).toBe(0);
    expect(JSON.parse((await run({}, "config", "get", "port", "--json")).stdout)).toMatchObject({ port: 47842, source: "default" });
    const running = JSON.parse((await run({}, "service", "status", "--json")).stdout);
    expect(running.extension.port).toBe(selectedPort); expect(running.portSource).toBe("config");
    expect((await run({}, "service", "stop", "--json")).exit).toBe(0);
    const envStarted = JSON.parse((await run({ SOCMEDIA_EXTENSION_PORT: "0" }, "service", "start", "--json")).stdout);
    pid = envStarted.pid;
    expect(envStarted.portSource).toBe("environment");
    expect(envStarted.extensionUrl).toBe(`ws://127.0.0.1:${envStarted.extension.port}/extension`);
  } finally {
    if (pid) { try { process.kill(pid, "SIGTERM"); } catch {} for (let i = 0; i < 100; i++) { try { process.kill(pid, 0); } catch { break; } await Bun.sleep(20); } }
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("popup saves port and background reconnects without altering token", async () => {
  const background = await Bun.file(new URL("../extension/background.js", import.meta.url)).text();
  const popup = await Bun.file(new URL("../extension/popup.js", import.meta.url)).text();
  const values: Record<string, any> = { token: "ab".repeat(32), port: 47842 };
  const listeners: Array<(changes: any, area: string) => void> = [];
  const urls: string[] = [];
  class FakeSocket {
    static OPEN = 1; static CONNECTING = 0;
    readyState = 0;
    constructor(url: string) { urls.push(url); }
    close() { this.readyState = 3; }
  }
  const handlers: Record<string, () => Promise<void>> = {};
  const elements: Record<string, any> = {
    token: { value: "" }, message: { textContent: "" }, port: { value: "" },
    save: { addEventListener: (_: string, fn: () => Promise<void>) => { handlers.token = fn; } },
    "save-port": { addEventListener: (_: string, fn: () => Promise<void>) => { handlers.port = fn; } },
    "port-message": { textContent: "" },
  };
  const ignore = { addListener() {} };
  const chrome = {
    storage: { local: {
      get: async (keys: string | string[]) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, values[key]])),
      set: async (items: Record<string, unknown>) => { const changes: Record<string, unknown> = {}; for (const [key, val] of Object.entries(items)) { changes[key] = { oldValue: values[key], newValue: val }; values[key] = val; } for (const fn of listeners) fn(changes, "local"); },
    }, onChanged: { addListener: (fn: (changes: any, area: string) => void) => listeners.push(fn) } },
    alarms: { create() {}, onAlarm: ignore }, runtime: { onStartup: ignore, getManifest: () => ({ version: projectVersion }) },
  };
  const context = { chrome, WebSocket: FakeSocket, crypto: webcrypto, TextEncoder, Uint8Array, console, document: { getElementById: (id: string) => elements[id] } };
  runInNewContext(background, context); runInNewContext(popup, context);
  for (let i = 0; i < 100 && urls.length < 1; i++) await Bun.sleep(10);
  expect(urls[0]).toBe("ws://127.0.0.1:47842/extension");
  elements.port.value = "47843"; await handlers.port!();
  for (let i = 0; i < 100 && urls.length < 2; i++) await Bun.sleep(10);
  expect(urls[1]).toBe("ws://127.0.0.1:47843/extension");
  expect(values.port).toBe(47843); expect(values.token).toBe("ab".repeat(32));
  elements.port.value = "65536"; await handlers.port!();
  expect(values.port).toBe(47843); expect(urls).toHaveLength(2);
});

test("extension install uses a stable path and public-key ID without changing pairing", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "socmedia-install-"));
  const run = async (...args: string[]) => {
    const cli = Bun.spawn(["bun", "run", "src/cli.ts", ...args], { cwd: import.meta.dir + "/..", env: { ...process.env, SOCMEDIA_STATE_DIR: stateDir, SOCMEDIA_EXTENSION_PORT: "0" }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exit] = await Promise.all([new Response(cli.stdout).text(), new Response(cli.stderr).text(), cli.exited]);
    expect(exit).toBe(0); return { stdout, stderr };
  };
  try {
    const help = await run("extension", "--help");
    expect(help.stdout).toContain("install"); expect(help.stdout).toContain("path"); expect(help.stdout).toContain("--json");
    const path = JSON.parse((await run("extension", "path", "--json")).stdout).path;
    expect(path).toBe(join(stateDir, "extension"));
    const marker = "pairing unchanged";
    await writeFile(join(stateDir, "extension-pairing.json"), marker);
    const first = JSON.parse((await run("extension", "install", "--json")).stdout);
    expect(first.path).toBe(path);
    expect(first.steps).toHaveLength(3);
    const installed = JSON.parse(await readFile(join(path, "manifest.json"), "utf8"));
    expect(installed.version).toBe(projectVersion);
    const hash = createHash("sha256").update(Buffer.from(installed.key, "base64")).digest("hex").slice(0, 32);
    const expectedId = [...hash].map((nibble) => String.fromCharCode(97 + parseInt(nibble, 16))).join("");
    expect(first.id).toBe(expectedId);
    await writeFile(join(path, "stale-file"), "stale");
    const second = JSON.parse((await run("extension", "install", "--json")).stdout);
    expect(second.path).toBe(path); expect(second.id).toBe(expectedId);
    expect(await readFile(join(stateDir, "extension-pairing.json"), "utf8")).toBe(marker);
    expect(await readdir(path)).not.toContain("stale-file");
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});

test("real extension detects login, checkpoint and captcha before reading", async () => {
  const script = await Bun.file(new URL("../extension/background.js", import.meta.url)).text();
  const stored: Record<string, unknown> = { cliSelectedTab: 42 };
  const tab = { id: 42, windowId: 4, active: true, url: "https://www.instagram.com/challenge/" };
  const ignore = { addListener() {} };
  const chrome = {
    storage: { local: { get: async (keys: string | string[]) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, stored[key]])), set: async (v: Record<string, unknown>) => Object.assign(stored, v) }, onChanged: ignore },
    tabs: { get: async () => tab, query: async () => [] }, tabGroups: { query: async () => [] },
    scripting: { executeScript: async () => [{ result: "captcha challenge" }] },
    alarms: { create() {}, onAlarm: ignore }, runtime: { onStartup: ignore },
  };
  const context = { chrome, WebSocket, console, URL };
  runInNewContext(script, context);
  for (const path of ["/challenge/", "/checkpoint/", "/accounts/login/", "/login/", "/suspended/"]) {
    tab.url = `https://www.instagram.com${path}`;
    await expect(runInNewContext("readPage({})", context)).rejects.toMatchObject({ code: "HALT" });
  }
  tab.url = "https://www.instagram.com/example/";
  await expect(runInNewContext("readPage({})", context)).rejects.toMatchObject({ code: "HALT", reason: "captcha challenge" });
  const pageContext = {
    ...context, location: { pathname: "/example/", hostname: "www.instagram.com" },
    document: {
      body: { innerText: "" },
      querySelectorAll: (selector: string) => selector === "iframe" ? [{ src: "https://www.google.com/recaptcha/", getBoundingClientRect: () => ({ width: 300, height: 100 }) }] : [],
      querySelector: (_selector: string): any => null,
    },
  };
  runInNewContext(script, pageContext);
  expect(runInNewContext("inspectPage()", pageContext)).toBe("captcha challenge");
  pageContext.document.querySelectorAll = () => [];
  pageContext.document.querySelector = (selector: string) => selector === "form#loginForm" ? {} as any : null;
  expect(runInNewContext("inspectPage()", pageContext)).toContain("not logged in");
});

test("HALT pauses later jobs across restart until explicit service resume", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "socmedia-halt-"));
  const run = async (...args: string[]) => {
    const cli = Bun.spawn(["bun", "run", "src/cli.ts", ...args], { cwd: import.meta.dir + "/..", env: { ...process.env, SOCMEDIA_STATE_DIR: stateDir, SOCMEDIA_EXTENSION_PORT: "0" }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exit] = await Promise.all([new Response(cli.stdout).text(), new Response(cli.stderr).text(), cli.exited]);
    expect(exit).toBe(0); return JSON.parse(stdout);
  };
  let pid: number | undefined;
  let ws: WebSocket | undefined;
  try {
    const id = "g".repeat(32);
    const pairing = await run("extension", "pair", "--id", id, "--json");
    let started = await run("service", "start", "--json"); pid = started.pid;
    const connect = async () => {
      const socket = new WebSocket(`ws://127.0.0.1:${started.extension.port}/extension`, { headers: { Origin: `chrome-extension://${id}` } } as unknown as string[]);
      let requests: any[] = [];
      socket.addEventListener("message", (event) => { const message = JSON.parse(String(event.data)); if (message.type === "request") requests.push(message); });
      await authenticateMock(socket, pairing.token);
      return { socket, take: async () => { for (let i = 0; i < 100 && !requests.length; i++) await Bun.sleep(10); if (!requests.length) throw new Error("request timeout"); return requests.shift(); }, requests };
    };
    let link = await connect(); ws = link.socket;
    const first = await run("queue", "enqueue", "readPage", "--json");
    const request = await link.take();
    const second = await run("queue", "enqueue", "readPage", "--json");
    ws.send(JSON.stringify({ type: "result", id: request.id, error: { code: "HALT", reason: "captcha challenge" } }));
    let status: any;
    for (let i = 0; i < 40; i++) { status = await run("service", "status", "--json"); if (status.halted) break; await Bun.sleep(20); }
    expect(status.halted).toEqual({ code: "HALT", reason: "captcha challenge" });
    expect((await run("queue", "get", String(second.id), "--json")).status).toBe("queued");
    expect((await run("queue", "get", String(first.id), "--json")).status).toBe("failed");
    expect((await run("service", "stop", "--json")).running).toBe(false); ws.close();
    started = await run("service", "start", "--json"); pid = started.pid;
    expect((await run("service", "status", "--json")).halted).toEqual({ code: "HALT", reason: "captcha challenge" });
    link = await connect(); ws = link.socket;
    await Bun.sleep(100); expect(link.requests).toHaveLength(0);
    expect((await run("service", "resume", "--json")).halted).toBeNull();
    const resumed = await link.take();
    ws.send(JSON.stringify({ type: "result", id: resumed.id, result: { url: "https://www.instagram.com/", text: "ok", lines: ["ok"] } }));
    let result: any;
    for (let i = 0; i < 40; i++) { result = await run("queue", "get", String(second.id), "--json"); if (result.status === "done") break; await Bun.sleep(20); }
    expect(result.status).toBe("done");
  } finally {
    ws?.close();
    if (pid) { try { process.kill(pid, "SIGTERM"); } catch {} for (let i = 0; i < 100; i++) { try { process.kill(pid, 0); } catch { break; } await Bun.sleep(20); } }
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("extension readPage reads the selected allowed tab through scripting", async () => {
  const script = await Bun.file(new URL("../extension/background.js", import.meta.url)).text();
  const ignore = { addListener() {} };
  const stored: Record<string, unknown> = { cliSelectedTab: 42 };
  let input: any;
  const tab = { id: 42, windowId: 4, active: true, url: "https://www.instagram.com/example/" };
  const chrome = {
    storage: { local: { get: async (keys: string | string[]) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, stored[key]])), set: async (v: Record<string, unknown>) => Object.assign(stored, v) }, onChanged: ignore },
    tabs: { get: async () => tab, query: async () => [] },
    tabGroups: { query: async () => [] },
    scripting: { executeScript: async (options: any) => { if (options.func.name === "inspectPage") return [{ result: null }]; input = options; return [{ result: ["First", "Second"] }]; } },
    alarms: { create() {}, onAlarm: ignore }, runtime: { onStartup: ignore },
  };
  const context = { chrome, WebSocket, console, URL };
  runInNewContext(script, context);
  expect(await runInNewContext("readPage({ maxLines: 2 })", context)).toEqual({ url: tab.url, text: "First\nSecond", lines: ["First", "Second"] });
  expect(input.target.tabId).toBe(42); expect(input.args).toEqual([2]);
});

test("queued readPage executes once, requeues on disconnect and stores its result", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "socmedia-read-page-"));
  const run = async (...args: string[]) => {
    const cli = Bun.spawn(["bun", "run", "src/cli.ts", ...args], { cwd: import.meta.dir + "/..", env: { ...process.env, SOCMEDIA_STATE_DIR: stateDir, SOCMEDIA_EXTENSION_PORT: "0" }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exit] = await Promise.all([new Response(cli.stdout).text(), new Response(cli.stderr).text(), cli.exited]);
    expect(exit).toBe(0); return JSON.parse(stdout);
  };
  let pid: number | undefined;
  let ws: WebSocket | undefined;
  try {
    const extId = "e".repeat(32);
    const pairing = await run("extension", "pair", "--id", extId, "--json");
    const started = await run("service", "start", "--json"); pid = started.pid;
    const connect = async () => {
      const socket = new WebSocket(`ws://127.0.0.1:${started.extension.port}/extension`, { headers: { Origin: `chrome-extension://${extId}` } } as unknown as string[]);
      await authenticateMock(socket, pairing.token); return socket;
    };
    ws = await connect();
    let requested: (request: any) => void = () => {};
    let next = new Promise<any>((resolve) => { requested = resolve; });
    ws.onmessage = (event) => requested(JSON.parse(String(event.data)));
    const job = await run("queue", "enqueue", "readPage", "--args", '{"maxLines":2}', "--json");
    const first = await Promise.race([next, Bun.sleep(1500).then(() => { throw new Error("extension request timeout"); })]);
    expect(first.action).toBe("readPage"); expect(first.args).toEqual({ maxLines: 2 });
    expect((await run("queue", "get", String(job.id), "--json")).status).toBe("running");
    const second = await run("queue", "enqueue", "readPage", "--json");
    expect((await run("queue", "get", String(second.id), "--json")).status).toBe("queued");
    expect((await run("queue", "cancel", String(second.id), "--json")).status).toBe("cancelled");
    ws.close();
    for (let i = 0; i < 50; i++) { if ((await run("queue", "get", String(job.id), "--json")).status === "queued") break; await Bun.sleep(20); }
    expect((await run("queue", "get", String(job.id), "--json")).status).toBe("queued");
    ws = await connect();
    next = new Promise<any>((resolve) => { requested = resolve; });
    ws.onmessage = (event) => requested(JSON.parse(String(event.data)));
    const retry = await Promise.race([next, Bun.sleep(1500).then(() => { throw new Error("extension retry timeout"); })]);
    ws.send(JSON.stringify({ type: "result", id: retry.id, result: { url: "https://www.instagram.com/example/", text: "Hello", lines: ["Hello"] } }));
    let result: any;
    for (let i = 0; i < 50; i++) { result = await run("queue", "get", String(job.id), "--json"); if (result.status === "done") break; await Bun.sleep(20); }
    expect(result).toMatchObject({ status: "done", result: { text: "Hello", lines: ["Hello"] } });
  } finally {
    ws?.close();
    if (pid) { try { process.kill(pid, "SIGTERM"); } catch {} for (let i = 0; i < 100; i++) { try { process.kill(pid, 0); } catch { break; } await Bun.sleep(20); } }
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("an interrupted readPage recovers on service restart and persists extension errors", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "socmedia-read-restart-"));
  const run = async (...args: string[]) => {
    const cli = Bun.spawn(["bun", "run", "src/cli.ts", ...args], { cwd: import.meta.dir + "/..", env: { ...process.env, SOCMEDIA_STATE_DIR: stateDir, SOCMEDIA_EXTENSION_PORT: "0" }, stdout: "pipe", stderr: "pipe" });
    const [stdout, exit] = await Promise.all([new Response(cli.stdout).text(), cli.exited]);
    expect(exit).toBe(0); return JSON.parse(stdout);
  };
  let pid: number | undefined;
  let ws: WebSocket | undefined;
  try {
    const extId = "f".repeat(32);
    const pairing = await run("extension", "pair", "--id", extId, "--json");
    let started = await run("service", "start", "--json"); pid = started.pid;
    const connect = async () => {
      const socket = new WebSocket(`ws://127.0.0.1:${started.extension.port}/extension`, { headers: { Origin: `chrome-extension://${extId}` } } as unknown as string[]);
      const request = new Promise<any>((resolve) => socket.addEventListener("message", (event) => { const msg = JSON.parse(String(event.data)); if (msg.type === "request") resolve(msg); }));
      await authenticateMock(socket, pairing.token); return { socket, request };
    };
    let link = await connect(); ws = link.socket;
    const inert = await run("queue", "enqueue", "getProfile", "--args", "{}", "--json");
    const job = await run("queue", "enqueue", "readPage", "--json");
    await Promise.race([link.request, Bun.sleep(1500).then(() => { throw new Error("request timeout"); })]);
    expect((await run("queue", "get", String(inert.id), "--json")).status).toBe("queued");
    expect((await run("queue", "get", String(job.id), "--json")).status).toBe("running");
    process.kill(pid!, "SIGKILL"); ws.close();
    for (let i = 0; i < 100; i++) { if (!(await run("service", "status", "--json")).running) break; await Bun.sleep(20); }
    started = await run("service", "start", "--json"); pid = started.pid;
    expect((await run("queue", "get", String(job.id), "--json")).status).toBe("queued");
    link = await connect(); ws = link.socket;
    const request = await Promise.race([link.request, Bun.sleep(1500).then(() => { throw new Error("retry timeout"); })]);
    ws.send(JSON.stringify({ type: "result", id: request.id, error: "No work tab" }));
    let result: any;
    for (let i = 0; i < 50; i++) { result = await run("queue", "get", String(job.id), "--json"); if (result.status === "failed") break; await Bun.sleep(20); }
    expect(result).toMatchObject({ status: "failed", error: "No work tab" });
  } finally {
    ws?.close();
    if (pid) { try { process.kill(pid, "SIGTERM"); } catch {} for (let i = 0; i < 100; i++) { try { process.kill(pid, 0); } catch { break; } await Bun.sleep(20); } }
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("real extension selects only live allowed tabs and clears its isolated selection", async () => {
  const script = await Bun.file(new URL("../extension/background.js", import.meta.url)).text();
  const stored: Record<string, any> = { selectedTab: 99 };
  const tabs = [{ id: 42, windowId: 4, url: "https://www.instagram.com/example/", title: "Example", active: true }, { id: 43, windowId: 4, url: "https://instagram.com.evil.test/", title: "Other", active: false }];
  const ignore = { addListener() {} };
  const chrome = {
    storage: { local: {
      get: async (keys: string | string[]) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, stored[key]])),
      set: async (values: Record<string, unknown>) => Object.assign(stored, values),
      remove: async (key: string) => { delete stored[key]; },
    }, onChanged: ignore },
    tabs: { get: async (id: number) => { const tab = tabs.find((item) => item.id === id); if (!tab) throw new Error("closed"); return tab; }, query: async () => [] },
    tabGroups: { get: async () => { throw new Error("missing"); }, query: async () => [] },
    alarms: { create() {}, onAlarm: ignore }, runtime: { onStartup: ignore },
  };
  const context = { chrome, WebSocket, console };
  runInNewContext(script, context);
  expect(await runInNewContext("useTab({ tabId: 42 })", context)).toEqual({ ok: true, selected: 42 });
  expect(stored.cliSelectedTab).toBe(42); expect(stored.selectedTab).toBe(99);
  expect(await runInNewContext("listTabs()", context)).toMatchObject([{ tabId: 42, selected: true }]);
  await expect(runInNewContext("useTab({ tabId: 43 })", context)).rejects.toThrow();
  await expect(runInNewContext("useTab({ tabId: 44 })", context)).rejects.toThrow();
  expect(stored.cliSelectedTab).toBe(42);
  expect(await runInNewContext("useTab({ tabId: null })", context)).toEqual({ ok: true, selected: null });
  expect(stored.cliSelectedTab).toBeUndefined();
});

test("tabs use and clear route through the authenticated service", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "socmedia-tabs-use-"));
  const run = async (...args: string[]) => {
    const cli = Bun.spawn(["bun", "run", "src/cli.ts", ...args], {
      cwd: import.meta.dir + "/..", env: { ...process.env, SOCMEDIA_STATE_DIR: stateDir, SOCMEDIA_EXTENSION_PORT: "0" }, stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, exit] = await Promise.all([new Response(cli.stdout).text(), new Response(cli.stderr).text(), cli.exited]);
    return { stdout, stderr, exit };
  };
  let pid: number | undefined;
  let ws: WebSocket | undefined;
  try {
    const help = await run("tabs", "--help");
    expect(help.stdout).toContain("use <tabId>"); expect(help.stdout).toContain("clear"); expect(help.stdout).toContain("--json");
    const id = "d".repeat(32);
    const pairing = JSON.parse((await run("extension", "pair", "--id", id, "--json")).stdout);
    const started = JSON.parse((await run("service", "start", "--json")).stdout); pid = started.pid;
    ws = new WebSocket(`ws://127.0.0.1:${started.extension.port}/extension`, { headers: { Origin: `chrome-extension://${id}` } } as unknown as string[]);
    await authenticateMock(ws, pairing.token);
    ws.onmessage = (event) => {
      const request = JSON.parse(String(event.data));
      ws!.send(JSON.stringify(request.args.tabId === 43 ? { type: "result", id: request.id, error: "Tab 43 is not an open social media tab" } : { type: "result", id: request.id, result: { ok: true, selected: request.args.tabId } }));
    };
    const chosen = await run("tabs", "use", "42", "--json");
    expect(chosen.exit).toBe(0); expect(JSON.parse(chosen.stdout)).toEqual({ ok: true, selected: 42 });
    const cleared = await run("tabs", "clear", "--json");
    expect(cleared.exit).toBe(0); expect(JSON.parse(cleared.stdout)).toEqual({ ok: true, selected: null });
    const rejected = await run("tabs", "use", "43", "--json");
    expect(rejected.exit).not.toBe(0); expect(rejected.stderr).toContain("Tab 43");
    expect((await run("tabs", "use", "-1", "--json")).exit).not.toBe(0);
  } finally {
    ws?.close();
    if (pid) { try { process.kill(pid, "SIGTERM"); } catch {} for (let i = 0; i < 100; i++) { try { process.kill(pid, 0); } catch { break; } await Bun.sleep(20); } }
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("extension work tabs use their own group, window and storage without adopting the old bridge", async () => {
  const script = await Bun.file(new URL("../extension/background.js", import.meta.url)).text();
  const stored: Record<string, any> = { groupId: 7, workTabId: 71, workWindowId: 70, selectedTab: 71 };
  const groups = [{ id: 7, title: "Social bot" }];
  const tabs = [{ id: 71, windowId: 70, groupId: 7, url: "https://www.instagram.com/old/", title: "Old", active: true }];
  let createdWindow = 0;
  const ignore = { addListener() {} };
  const chrome = {
    storage: { local: {
      get: async (keys: string | string[]) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, stored[key]])),
      set: async (values: Record<string, unknown>) => Object.assign(stored, values),
    }, onChanged: ignore },
    tabGroups: {
      get: async (id: number) => { const group = groups.find((g) => g.id === id); if (!group) throw new Error("not found"); return group; },
      query: async ({ title }: { title: string }) => groups.filter((group) => group.title === title),
      update: async (id: number, values: { title: string }) => Object.assign(groups.find((group) => group.id === id)!, values),
    },
    windows: {
      get: async () => { throw new Error("not found"); },
      create: async (options: { focused: boolean; state: string }) => {
        expect(options.focused).toBe(false); expect(options.state).toBe("normal"); createdWindow++;
        const tab = { id: 81, windowId: 80, groupId: -1, url: "about:blank", title: "New", active: true };
        tabs.push(tab); return { id: 80, tabs: [tab] };
      },
    },
    tabs: {
      get: async (id: number) => { const tab = tabs.find((t) => t.id === id); if (!tab) throw new Error("not found"); return tab; },
      query: async ({ groupId }: { groupId: number }) => tabs.filter((tab) => tab.groupId === groupId),
      group: async ({ tabIds }: { tabIds: number }) => { const id = 8; groups.push({ id, title: "" }); tabs.find((tab) => tab.id === tabIds)!.groupId = id; return id; },
      update: async () => {},
    },
    alarms: { create() {}, onAlarm: ignore }, runtime: { onStartup: ignore },
  };
  const context = { chrome, WebSocket, console };
  runInNewContext(script, context);
  expect(await runInNewContext("listTabs()", context)).toEqual([]);
  expect(await runInNewContext("getWorkTab()", context)).toEqual({ tabId: 81, windowId: 80 });
  expect(createdWindow).toBe(1);
  expect(groups.find((group) => group.id === 7)?.title).toBe("Social bot");
  expect(groups.find((group) => group.id === 8)?.title).toBe("Socmedia CLI");
  expect(stored.groupId).toBe(7); expect(stored.workTabId).toBe(71);
  expect(await runInNewContext("listTabs()", context)).toEqual([{ tabId: 81, windowId: 80, url: "about:blank", title: "New", active: true, selected: false, work: true }]);
});

async function authenticateMock(ws: WebSocket, token: string, version = projectVersion) {
  const nonce = randomBytes(32).toString("hex");
  const sign = (role: string, serverNonce: string) => createHmac("sha256", Buffer.from(token, "hex")).update(`${role}:${nonce}:${serverNonce}:${version}`).digest("hex");
  return new Promise<{ ack: any; proof: string; nonce: string }>((resolve, reject) => {
    let proof = "";
    ws.onopen = () => ws.send(JSON.stringify({ type: "hello", version, clientNonce: nonce }));
    ws.onmessage = (event) => {
      const msg = JSON.parse(String(event.data));
      if (msg.type === "challenge") {
        if (msg.proof !== sign("server", msg.serverNonce)) { reject(new Error("server proof invalid")); return; }
        proof = sign("client", msg.serverNonce);
        ws.send(JSON.stringify({ type: "authenticate", proof }));
      } else if (msg.type === "hello") resolve({ ack: msg, proof, nonce });
    };
    ws.onerror = () => reject(new Error("WebSocket connection failed"));
  });
}

test("service reports full versions and accepts only matching major and minor", async () => {
  expect(manifest.version).toBe(projectVersion);
  const stateDir = await mkdtemp(join(tmpdir(), "socmedia-versions-"));
  const run = async (...args: string[]) => {
    const cli = Bun.spawn(["bun", "run", "src/cli.ts", ...args], {
      cwd: import.meta.dir + "/..", env: { ...process.env, SOCMEDIA_STATE_DIR: stateDir, SOCMEDIA_EXTENSION_PORT: "0" },
      stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, exit] = await Promise.all([new Response(cli.stdout).text(), new Response(cli.stderr).text(), cli.exited]);
    return { stdout, stderr, exit };
  };
  let pid: number | undefined;
  let ws: WebSocket | undefined;
  try {
    const cliVersion = await run("--version");
    expect(cliVersion.exit).toBe(0);
    expect(cliVersion.stdout.trim()).toBe(projectVersion);
    const id = "c".repeat(32);
    const pairing = JSON.parse((await run("extension", "pair", "--id", id, "--json")).stdout);
    const started = JSON.parse((await run("service", "start", "--json")).stdout);
    pid = started.pid;
    expect(started.version).toBe(projectVersion);
    const [major, minor, patch] = projectVersion.split(".").map(Number) as [number, number, number];
    for (const [version, compatible] of [[`${major}.${minor}.${patch + 1}`, true], [`${major}.${minor + 1}.0`, false], [`${major + 1}.0.0`, false]] as const) {
      ws?.close();
      ws = new WebSocket(`ws://127.0.0.1:${started.extension.port}/extension`, { headers: { Origin: `chrome-extension://${id}` } } as unknown as string[]);
      const authenticated = await authenticateMock(ws, pairing.token, version);
      expect(authenticated.ack).toMatchObject({ version: projectVersion, compatible });
      const status = JSON.parse((await run("service", "status", "--json")).stdout);
      expect(status.version).toBe(projectVersion);
      expect(status.extension).toMatchObject({ version, compatible });
      if (compatible) {
        ws.onmessage = (event) => { const request = JSON.parse(String(event.data)); ws!.send(JSON.stringify({ type: "result", id: request.id, result: [] })); };
        expect((await run("tabs", "list", "--json")).exit).toBe(0);
      } else {
        const denied = await run("tabs", "list", "--json");
        expect(denied.exit).not.toBe(0); expect(denied.stderr).toContain("incompatible");
      }
    }
  } finally {
    ws?.close();
    if (pid) { try { process.kill(pid, "SIGTERM"); } catch {} for (let i = 0; i < 100; i++) { try { process.kill(pid, 0); } catch { break; } await Bun.sleep(20); } }
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("extension does not reveal its pairing secret to an impersonating local server", async () => {
  const token = "ab".repeat(32);
  const received: string[] = [];
  const fake = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request, server) { if (!server.upgrade(request)) return new Response("upgrade required", { status: 400 }); },
    websocket: { message(ws, data) {
      received.push(String(data));
      ws.send(JSON.stringify({ type: "challenge", serverNonce: "cd".repeat(32), proof: "ef".repeat(32) }));
    } },
  });
  const script = await Bun.file(new URL("../extension/background.js", import.meta.url)).text();
  class RedirectSocket extends WebSocket {
    constructor(_url: string) { super(`ws://127.0.0.1:${fake.port}/extension`); }
  }
  const ignore = { addListener() {} };
  try {
    runInNewContext(script, {
      WebSocket: RedirectSocket, crypto: webcrypto, TextEncoder, Uint8Array, console,
      chrome: {
        storage: { local: { get: async () => ({ token }) }, onChanged: ignore },
        alarms: { create() {}, onAlarm: ignore },
        runtime: { getManifest: () => ({ version: projectVersion }), onStartup: ignore },
      },
    });
    for (let i = 0; i < 100 && received.length === 0; i++) await Bun.sleep(10);
    expect(received.length).toBeGreaterThan(0);
    await Bun.sleep(100);
    expect(received.join(" ")).not.toContain(token);
    expect(received.filter((message) => JSON.parse(message).type === "authenticate")).toHaveLength(0);
  } finally { fake.stop(true); }
});

test("tabs list talks to the paired extension and handles disconnect and timeout", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "socmedia-tabs-"));
  const run = async (...args: string[]) => {
    const cli = Bun.spawn(["bun", "run", "src/cli.ts", ...args], {
      cwd: import.meta.dir + "/..", env: { ...process.env, SOCMEDIA_STATE_DIR: stateDir, SOCMEDIA_EXTENSION_PORT: "0", SOCMEDIA_EXTENSION_TIMEOUT_MS: "100" },
      stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, exit] = await Promise.all([new Response(cli.stdout).text(), new Response(cli.stderr).text(), cli.exited]);
    return { stdout, stderr, exit };
  };
  let pid: number | undefined;
  let ws: WebSocket | undefined;
  try {
    const help = await run("tabs", "list", "--help");
    expect(help.stdout).toContain("list"); expect(help.stdout).toContain("--json");
    const id = "b".repeat(32);
    const pairing = JSON.parse((await run("extension", "pair", "--id", id, "--json")).stdout);
    const started = JSON.parse((await run("service", "start", "--json")).stdout);
    pid = started.pid;
    const missing = await run("tabs", "list", "--json");
    expect(missing.exit).not.toBe(0); expect(missing.stderr).toContain("Extension not connected");
    ws = new WebSocket(`ws://127.0.0.1:${started.extension.port}/extension`, { headers: { Origin: `chrome-extension://${id}` } } as unknown as string[]);
    await authenticateMock(ws, pairing.token);
    const expected = [{ tabId: 3, windowId: 2, url: "https://www.instagram.com/", title: "Instagram", active: true, selected: false, work: true }];
    ws.onmessage = (event) => { const message = JSON.parse(String(event.data)); ws!.send(JSON.stringify({ type: "result", id: message.id, result: expected })); };
    const result = await run("tabs", "list", "--json");
    expect(result.exit).toBe(0); expect(JSON.parse(result.stdout)).toEqual(expected);
    ws.onmessage = () => {};
    const timeout = await run("tabs", "list", "--json");
    expect(timeout.exit).not.toBe(0); expect(timeout.stderr).toContain("timed out");
    ws.onmessage = () => ws!.close();
    const disconnect = await run("tabs", "list", "--json");
    expect(disconnect.exit).not.toBe(0); expect(disconnect.stderr).toContain("disconnected");
  } finally {
    ws?.close();
    if (pid) { try { process.kill(pid, "SIGTERM"); } catch {} for (let i = 0; i < 100; i++) { try { process.kill(pid, 0); } catch { break; } await Bun.sleep(20); } }
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("extension handshake reports its connection and version through service status", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "socmedia-extension-"));
  const run = async (...args: string[]) => {
    const cli = Bun.spawn(["bun", "run", "src/cli.ts", ...args], {
      cwd: import.meta.dir + "/..", env: { ...process.env, SOCMEDIA_STATE_DIR: stateDir, SOCMEDIA_EXTENSION_PORT: "0" },
      stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, exit] = await Promise.all([new Response(cli.stdout).text(), new Response(cli.stderr).text(), cli.exited]);
    expect(exit).toBe(0);
    return JSON.parse(stdout);
  };
  let pid: number | undefined;
  let socket: WebSocket | undefined;
  try {
    const extensionId = "a".repeat(32);
    const pairing = await run("extension", "pair", "--id", extensionId, "--json");
    const started = await run("service", "start", "--json");
    pid = started.pid;
    expect(started.extension.connected).toBe(false);
    const url = `ws://127.0.0.1:${started.extension.port}/extension`;
    const wrongOrigin = new WebSocket(url, { headers: { Origin: "https://example.org" } } as unknown as string[]);
    await new Promise<void>((resolve) => { wrongOrigin.onclose = () => resolve(); wrongOrigin.onerror = () => resolve(); });
    expect((await run("service", "status", "--json")).extension.connected).toBe(false);
    const badToken = new WebSocket(url, { headers: { Origin: `chrome-extension://${extensionId}` } } as unknown as string[]);
    await new Promise<void>((resolve, reject) => { badToken.onopen = () => resolve(); badToken.onerror = () => reject(new Error("connect failed")); });
    const badClosed = new Promise<void>((resolve) => { badToken.onclose = () => resolve(); });
    badToken.onmessage = () => badToken.send(JSON.stringify({ type: "authenticate", proof: "ff".repeat(32) }));
    badToken.send(JSON.stringify({ type: "hello", version: projectVersion, clientNonce: randomBytes(32).toString("hex") }));
    await badClosed;
    expect((await run("service", "status", "--json")).extension.connected).toBe(false);
    socket = new WebSocket(url, { headers: { Origin: `chrome-extension://${extensionId}` } } as unknown as string[]);
    const authenticated = await authenticateMock(socket, pairing.token);
    expect(authenticated.ack).toMatchObject({ type: "hello", version: projectVersion, compatible: true });
    expect((await run("service", "status", "--json")).extension).toMatchObject({ connected: true, version: projectVersion, compatible: true });
    const replay = new WebSocket(url, { headers: { Origin: `chrome-extension://${extensionId}` } } as unknown as string[]);
    await new Promise<void>((resolve, reject) => { replay.onopen = () => resolve(); replay.onerror = () => reject(new Error("connect failed")); });
    const replayClosed = new Promise<void>((resolve) => { replay.onclose = () => resolve(); });
    replay.onmessage = () => replay.send(JSON.stringify({ type: "authenticate", proof: authenticated.proof }));
    replay.send(JSON.stringify({ type: "hello", version: projectVersion, clientNonce: authenticated.nonce }));
    await replayClosed;
    expect((await run("service", "status", "--json")).extension.connected).toBe(true);
  } finally {
    socket?.close();
    if (pid) {
      try { process.kill(pid, "SIGTERM"); } catch { /* already exited */ }
      for (let i = 0; i < 100; i++) { try { process.kill(pid, 0); } catch { break; } await Bun.sleep(20); }
    }
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("enqueue keys are idempotent across restarts and reject conflicting jobs", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "socmedia-queue-key-"));
  const run = async (...args: string[]) => {
    const cli = Bun.spawn(["bun", "run", "src/cli.ts", ...args], {
      cwd: import.meta.dir + "/..", env: { ...process.env, SOCMEDIA_STATE_DIR: stateDir, SOCMEDIA_EXTENSION_PORT: "0" },
      stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, exit] = await Promise.all([new Response(cli.stdout).text(), new Response(cli.stderr).text(), cli.exited]);
    return { stdout, stderr, exit };
  };
  let pid: number | undefined;
  try {
    pid = JSON.parse((await run("service", "start", "--json")).stdout).pid;
    const params = ["queue", "enqueue", "getProfile", "--args", '{"url":"https://www.instagram.com/example/"}', "--key", "same", "--json"];
    const created = await run(...params);
    expect(created.exit).toBe(0);
    const job = JSON.parse(created.stdout);
    expect(JSON.parse((await run(...params)).stdout)).toEqual(job);
    expect((await run("service", "stop", "--json")).exit).toBe(0);
    pid = JSON.parse((await run("service", "start", "--json")).stdout).pid;
    expect(JSON.parse((await run(...params)).stdout)).toEqual(job);
    const differentAction = await run("queue", "enqueue", "getPost", "--args", '{"url":"https://www.instagram.com/example/"}', "--key", "same", "--json");
    expect(differentAction.exit).not.toBe(0);
    expect(differentAction.stderr).toContain("key conflict");
    const differentArgs = await run("queue", "enqueue", "getProfile", "--args", '{"url":"https://www.instagram.com/other/"}', "--key", "same", "--json");
    expect(differentArgs.exit).not.toBe(0);
    expect(differentArgs.stderr).toContain("key conflict");
    expect(JSON.parse((await run("queue", "list", "--json")).stdout)).toEqual({ jobs: [job] });
    expect((await run("queue", "enqueue", "--help")).stdout).toContain("conflict");
  } finally {
    if (pid) {
      try { process.kill(pid, "SIGTERM"); } catch { /* already exited */ }
      for (let i = 0; i < 100; i++) { try { process.kill(pid, 0); } catch { break; } await Bun.sleep(20); }
    }
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("cancel marks a queued job cancelled and remains idempotent after restart", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "socmedia-cancel-job-"));
  const run = async (...args: string[]) => {
    const cli = Bun.spawn(["bun", "run", "src/cli.ts", ...args], {
      cwd: import.meta.dir + "/..", env: { ...process.env, SOCMEDIA_STATE_DIR: stateDir, SOCMEDIA_EXTENSION_PORT: "0" },
      stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, exit] = await Promise.all([new Response(cli.stdout).text(), new Response(cli.stderr).text(), cli.exited]);
    expect(exit).toBe(0);
    return JSON.parse(stdout);
  };
  let pid: number | undefined;
  try {
    pid = (await run("service", "start", "--json")).pid;
    const job = await run("queue", "enqueue", "getProfile", "--args", '{"url":"https://www.instagram.com/example/"}', "--json");
    const cancelled = await run("queue", "cancel", String(job.id), "--json");
    expect(cancelled).toEqual({ ...job, status: "cancelled" });
    expect(await run("queue", "cancel", String(job.id), "--json")).toEqual(cancelled);
    await run("service", "stop", "--json");
    pid = (await run("service", "start", "--json")).pid;
    expect(await run("queue", "get", String(job.id), "--json")).toEqual(cancelled);
    expect((await run("queue", "list", "--json")).jobs).toContainEqual(cancelled);
  } finally {
    if (pid) {
      try { process.kill(pid, "SIGTERM"); } catch { /* already exited */ }
      for (let i = 0; i < 100; i++) { try { process.kill(pid, 0); } catch { break; } await Bun.sleep(20); }
    }
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("queue enqueue persists a validated job across service restart", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "socmedia-enqueue-"));
  const run = async (...args: string[]) => {
    const cli = Bun.spawn(["bun", "run", "src/cli.ts", ...args], {
      cwd: import.meta.dir + "/..", env: { ...process.env, SOCMEDIA_STATE_DIR: stateDir, SOCMEDIA_EXTENSION_PORT: "0" },
      stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, exit] = await Promise.all([new Response(cli.stdout).text(), new Response(cli.stderr).text(), cli.exited]);
    return { stdout, stderr, exit };
  };
  let pid: number | undefined;
  try {
    pid = JSON.parse((await run("service", "start", "--json")).stdout).pid;
    const help = await run("queue", "enqueue", "--help");
    expect(help.stdout).toContain("enqueue <action>");
    expect(help.stdout).toContain("--args");
    expect((await run("queue", "enqueue", "unknown", "--json")).exit).not.toBe(0);
    expect((await run("queue", "enqueue", "getProfile", "--args", "not-json", "--json")).exit).not.toBe(0);
    const created = await run("queue", "enqueue", "getProfile", "--args", '{"url":"https://www.instagram.com/example/"}', "--json");
    expect(created.exit).toBe(0);
    const job = JSON.parse(created.stdout);
    expect(job).toMatchObject({ id: 1, action: "getProfile", args: { url: "https://www.instagram.com/example/" }, status: "queued" });
    expect((await run("service", "stop", "--json")).exit).toBe(0);
    pid = JSON.parse((await run("service", "start", "--json")).stdout).pid;
    expect(JSON.parse((await run("queue", "get", "1", "--json")).stdout)).toEqual(job);
    expect(JSON.parse((await run("queue", "list", "--json")).stdout)).toEqual({ jobs: [job] });
  } finally {
    if (pid) {
      try { process.kill(pid, "SIGTERM"); } catch { /* already exited */ }
      for (let i = 0; i < 100; i++) { try { process.kill(pid, 0); } catch { break; } await Bun.sleep(20); }
    }
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("queue cancel reports a missing job and documents its ID argument", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "socmedia-queue-cancel-"));
  const run = async (...args: string[]) => {
    const cli = Bun.spawn(["bun", "run", "src/cli.ts", ...args], {
      cwd: import.meta.dir + "/..", env: { ...process.env, SOCMEDIA_STATE_DIR: stateDir, SOCMEDIA_EXTENSION_PORT: "0" },
      stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, exit] = await Promise.all([
      new Response(cli.stdout).text(), new Response(cli.stderr).text(), cli.exited,
    ]);
    return { stdout, stderr, exit };
  };
  let pid: number | undefined;
  try {
    const started = await run("service", "start", "--json");
    expect(started.exit).toBe(0);
    pid = JSON.parse(started.stdout).pid;
    const help = await run("queue", "cancel", "--help");
    expect(help.exit).toBe(0);
    expect(help.stdout).toContain("cancel <id>");
    expect(help.stdout).toContain("--json");
    const result = await run("queue", "cancel", "42", "--json");
    expect(result.exit).not.toBe(0);
    expect(result.stderr).toContain("Job 42 not found");
  } finally {
    if (pid) {
      try { process.kill(pid, "SIGTERM"); } catch { /* already exited */ }
      for (let i = 0; i < 100; i++) {
        try { process.kill(pid, 0); } catch { break; }
        await Bun.sleep(20);
      }
    }
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("queue get reports a missing job and documents its ID argument", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "socmedia-queue-get-"));
  const run = async (...args: string[]) => {
    const cli = Bun.spawn(["bun", "run", "src/cli.ts", ...args], {
      cwd: import.meta.dir + "/..", env: { ...process.env, SOCMEDIA_STATE_DIR: stateDir, SOCMEDIA_EXTENSION_PORT: "0" },
      stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, exit] = await Promise.all([
      new Response(cli.stdout).text(), new Response(cli.stderr).text(), cli.exited,
    ]);
    return { stdout, stderr, exit };
  };
  let pid: number | undefined;
  try {
    const started = await run("service", "start", "--json");
    expect(started.exit).toBe(0);
    pid = JSON.parse(started.stdout).pid;
    const help = await run("queue", "get", "--help");
    expect(help.exit).toBe(0);
    expect(help.stdout).toContain("get <id>");
    expect(help.stdout).toContain("--json");
    const result = await run("queue", "get", "42", "--json");
    expect(result.exit).not.toBe(0);
    expect(result.stderr).toContain("Job 42 not found");
  } finally {
    if (pid) {
      try { process.kill(pid, "SIGTERM"); } catch { /* already exited */ }
      for (let i = 0; i < 100; i++) {
        try { process.kill(pid, 0); } catch { break; }
        await Bun.sleep(20);
      }
    }
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("queue list shows an empty queue on a fresh service and is documented", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "socmedia-queue-"));
  const run = async (...args: string[]) => {
    const cli = Bun.spawn(["bun", "run", "src/cli.ts", ...args], {
      cwd: import.meta.dir + "/..", env: { ...process.env, SOCMEDIA_STATE_DIR: stateDir, SOCMEDIA_EXTENSION_PORT: "0" },
      stdout: "pipe", stderr: "pipe",
    });
    const output = await new Response(cli.stdout).text();
    expect(await cli.exited).toBe(0);
    return output;
  };
  let pid: number | undefined;
  try {
    pid = JSON.parse(await run("service", "start", "--json")).pid;
    const help = await run("queue", "--help");
    expect(help).toContain("list");
    expect(help).toContain("--json");
    expect(JSON.parse(await run("queue", "list", "--json"))).toEqual({ jobs: [] });
  } finally {
    if (pid) {
      try { process.kill(pid, "SIGTERM"); } catch { /* already exited */ }
      for (let i = 0; i < 100; i++) {
        try { process.kill(pid, 0); } catch { break; }
        await Bun.sleep(20);
      }
    }
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("the CLI displays its usage when asked for help", async () => {
  const cli = Bun.spawn(["bun", "run", "src/cli.ts", "--help"], {
    cwd: import.meta.dir + "/..",
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = await new Response(cli.stdout).text();

  expect(await cli.exited).toBe(0);
  expect(output).toContain("Usage: socmedia");
});

test("service help describes both commands and their JSON option", async () => {
  const cli = Bun.spawn(["bun", "run", "src/cli.ts", "service", "--help"], {
    cwd: import.meta.dir + "/..", stdout: "pipe", stderr: "pipe",
  });
  const output = await new Response(cli.stdout).text();
  expect(await cli.exited).toBe(0);
  expect(output).toContain("start");
  expect(output).toContain("status");
  expect(output).toContain("stop");
  expect(output).toContain("resume");
  expect(output).toContain("--json");
});

test("service stop stops the service and remains safe to repeat", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "socmedia-stop-"));
  const run = async (...args: string[]) => {
    const cli = Bun.spawn(["bun", "run", "src/cli.ts", ...args], {
      cwd: import.meta.dir + "/..", env: { ...process.env, SOCMEDIA_STATE_DIR: stateDir, SOCMEDIA_EXTENSION_PORT: "0" },
      stdout: "pipe", stderr: "pipe",
    });
    const output = await new Response(cli.stdout).text();
    expect(await cli.exited).toBe(0);
    return JSON.parse(output);
  };
  let pid: number | undefined;
  try {
    pid = (await run("service", "start", "--json")).pid;
    expect(pid).toBeDefined();
    expect(await run("service", "stop", "--json")).toEqual({ running: false });
    expect(await run("service", "status", "--json")).toEqual({ running: false });
    expect(await run("service", "stop", "--json")).toEqual({ running: false });
  } finally {
    if (pid) {
      try { process.kill(pid, "SIGTERM"); } catch { /* already exited */ }
      for (let i = 0; i < 100; i++) {
        try { process.kill(pid, 0); } catch { break; }
        await Bun.sleep(20);
      }
    }
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("service status reports an absent service without starting it", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "socmedia-status-"));
  try {
    const cli = Bun.spawn(["bun", "run", "src/cli.ts", "service", "status", "--json"], {
      cwd: import.meta.dir + "/..",
      env: { ...process.env, SOCMEDIA_STATE_DIR: stateDir, SOCMEDIA_EXTENSION_PORT: "0" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(cli.stdout).text();

    expect(await cli.exited).toBe(0);
    expect(JSON.parse(output)).toEqual({ running: false });
    expect(await readdir(stateDir)).toEqual([]);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("service status does not identify an unrelated socket as socmedia", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "socmedia-foreign-"));
  const server = createServer((socket) => socket.end('{"identity":"other","pid":123}\n'));
  await new Promise<void>((resolve) => server.listen(join(stateDir, "service.sock"), resolve));
  try {
    const cli = Bun.spawn(["bun", "run", "src/cli.ts", "service", "status", "--json"], {
      cwd: import.meta.dir + "/..", env: { ...process.env, SOCMEDIA_STATE_DIR: stateDir, SOCMEDIA_EXTENSION_PORT: "0" },
      stdout: "pipe", stderr: "pipe",
    });
    const output = await new Response(cli.stdout).text();
    expect(await cli.exited).toBe(0);
    expect(JSON.parse(output)).toEqual({ running: false });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("service start launches one identifiable service and repeated starts reuse it", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "socmedia-start-"));
  const run = async (...args: string[]) => {
    const cli = Bun.spawn(["bun", "run", "src/cli.ts", ...args], {
      cwd: import.meta.dir + "/..",
      env: { ...process.env, SOCMEDIA_STATE_DIR: stateDir, SOCMEDIA_EXTENSION_PORT: "0" },
      stdout: "pipe", stderr: "pipe",
    });
    const output = await new Response(cli.stdout).text();
    expect(await cli.exited).toBe(0);
    return JSON.parse(output);
  };
  let pid: number | undefined;
  try {
    const started = await run("service", "start", "--json");
    pid = started.pid;
    expect(started.running).toBe(true);
    expect(typeof pid).toBe("number");
    expect(await run("service", "status", "--json")).toMatchObject({ running: true, pid });
    expect(await run("service", "start", "--json")).toMatchObject({ running: true, pid });
  } finally {
    if (pid) {
      try { process.kill(pid, "SIGTERM"); } catch { /* already exited */ }
      for (let i = 0; i < 100; i++) {
        try { process.kill(pid, 0); } catch { break; }
        await Bun.sleep(20);
      }
    }
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("simultaneous starts recover a service killed without cleanup", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "socmedia-recover-"));
  const run = async (...args: string[]) => {
    const cli = Bun.spawn(["bun", "run", "src/cli.ts", ...args], {
      cwd: import.meta.dir + "/..", env: { ...process.env, SOCMEDIA_STATE_DIR: stateDir, SOCMEDIA_EXTENSION_PORT: "0" },
      stdout: "pipe", stderr: "pipe",
    });
    const output = await new Response(cli.stdout).text();
    expect(await cli.exited).toBe(0);
    return JSON.parse(output);
  };
  let pid: number | undefined;
  try {
    pid = (await run("service", "start", "--json")).pid;
    if (!pid) throw new Error("missing service pid");
    process.kill(pid, "SIGKILL");
    for (let i = 0; i < 100 && (await run("service", "status", "--json")).running; i++) await Bun.sleep(20);
    const [first, second] = await Promise.all([run("service", "start", "--json"), run("service", "start", "--json")]);
    pid = first.pid;
    expect(first.running).toBe(true);
    expect(second).toEqual(first);
    expect(await run("service", "status", "--json")).toEqual(first);
  } finally {
    if (pid) {
      try { process.kill(pid, "SIGTERM"); } catch { /* already exited */ }
      for (let i = 0; i < 100; i++) {
        try { process.kill(pid, 0); } catch { break; }
        await Bun.sleep(20);
      }
    }
    await rm(stateDir, { recursive: true, force: true });
  }
});
