import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { runInNewContext } from "node:vm";
import { createHmac, randomBytes, webcrypto } from "node:crypto";

async function authenticateMock(ws: WebSocket, token: string) {
  const nonce = randomBytes(32).toString("hex");
  const sign = (role: string, serverNonce: string) => createHmac("sha256", Buffer.from(token, "hex")).update(`${role}:${nonce}:${serverNonce}:0.1.0`).digest("hex");
  return new Promise<{ ack: any; proof: string; nonce: string }>((resolve, reject) => {
    let proof = "";
    ws.onopen = () => ws.send(JSON.stringify({ type: "hello", version: "0.1.0", clientNonce: nonce }));
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
        runtime: { getManifest: () => ({ version: "0.1.0" }), onStartup: ignore },
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
    badToken.send(JSON.stringify({ type: "hello", version: "0.1.0", clientNonce: randomBytes(32).toString("hex") }));
    await badClosed;
    expect((await run("service", "status", "--json")).extension.connected).toBe(false);
    socket = new WebSocket(url, { headers: { Origin: `chrome-extension://${extensionId}` } } as unknown as string[]);
    const authenticated = await authenticateMock(socket, pairing.token);
    expect(authenticated.ack).toMatchObject({ type: "hello", version: "0.1.0", compatible: true });
    expect((await run("service", "status", "--json")).extension).toMatchObject({ connected: true, version: "0.1.0", compatible: true });
    const replay = new WebSocket(url, { headers: { Origin: `chrome-extension://${extensionId}` } } as unknown as string[]);
    await new Promise<void>((resolve, reject) => { replay.onopen = () => resolve(); replay.onerror = () => reject(new Error("connect failed")); });
    const replayClosed = new Promise<void>((resolve) => { replay.onclose = () => resolve(); });
    replay.onmessage = () => replay.send(JSON.stringify({ type: "authenticate", proof: authenticated.proof }));
    replay.send(JSON.stringify({ type: "hello", version: "0.1.0", clientNonce: authenticated.nonce }));
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
      cwd: import.meta.dir + "/..", env: { ...process.env, SOCMEDIA_STATE_DIR: stateDir },
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
      cwd: import.meta.dir + "/..", env: { ...process.env, SOCMEDIA_STATE_DIR: stateDir },
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
      cwd: import.meta.dir + "/..", env: { ...process.env, SOCMEDIA_STATE_DIR: stateDir },
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
      cwd: import.meta.dir + "/..", env: { ...process.env, SOCMEDIA_STATE_DIR: stateDir },
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
      cwd: import.meta.dir + "/..", env: { ...process.env, SOCMEDIA_STATE_DIR: stateDir },
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
      cwd: import.meta.dir + "/..", env: { ...process.env, SOCMEDIA_STATE_DIR: stateDir },
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
  expect(output).toContain("--json");
});

test("service stop stops the service and remains safe to repeat", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "socmedia-stop-"));
  const run = async (...args: string[]) => {
    const cli = Bun.spawn(["bun", "run", "src/cli.ts", ...args], {
      cwd: import.meta.dir + "/..", env: { ...process.env, SOCMEDIA_STATE_DIR: stateDir },
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
      env: { ...process.env, SOCMEDIA_STATE_DIR: stateDir },
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
      cwd: import.meta.dir + "/..", env: { ...process.env, SOCMEDIA_STATE_DIR: stateDir },
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
      env: { ...process.env, SOCMEDIA_STATE_DIR: stateDir },
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
      cwd: import.meta.dir + "/..", env: { ...process.env, SOCMEDIA_STATE_DIR: stateDir },
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
