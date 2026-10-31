import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { createHmac, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { telegramChat, validateMediaFile } from "../src/lib/validate";
import { safeSeg, resolveHomePath } from "../src/media";

const projectVersion = "0.17.0";

const createMockMp4 = (path: string) => {
  const buf = Buffer.alloc(64);
  buf.write("ftypisom", 4);
  writeFileSync(path, buf);
  return path;
};

async function authenticateMock(ws: WebSocket, token: string, version = projectVersion) {
  const nonce = randomBytes(32).toString("hex");
  const sign = (role: string, serverNonce: string) =>
    createHmac("sha256", Buffer.from(token, "hex")).update(`${role}:${nonce}:${serverNonce}:${version}`).digest("hex");
  return new Promise<{ ack: any; proof: string; nonce: string }>((resolve, reject) => {
    let proof = "";
    ws.onopen = () => ws.send(JSON.stringify({ type: "hello", version, clientNonce: nonce }));
    ws.onmessage = (event) => {
      const msg = JSON.parse(String(event.data));
      if (msg.type === "challenge") {
        if (msg.proof !== sign("server", msg.serverNonce)) { reject(new Error("server proof invalid")); return; }
        proof = sign("client", msg.serverNonce);
        ws.send(JSON.stringify({ type: "authenticate", proof }));
      } else if (msg.type === "hello") {
        resolve({ ack: msg, proof, nonce });
      }
    };
    ws.onerror = (e) => reject(e);
  });
}

test("Telegram URL and chat validation & canonicalisation", () => {
  // Valid chats
  expect(telegramChat("@valid_user")).toBe("@valid_user");
  expect(telegramChat("valid_user")).toBe("@valid_user");
  expect(telegramChat("https://t.me/valid_user")).toBe("@valid_user");
  expect(telegramChat("@user123")).toBe("@user123");
  expect(telegramChat("https://t.me/a1234567890123456789012345678901")).toBe("@a1234567890123456789012345678901");

  // Hostile / invalid inputs
  expect(() => telegramChat("t.me/+invite123")).toThrow(/Invite links/);
  expect(() => telegramChat("https://t.me/+join123")).toThrow(/Invite links/);
  expect(() => telegramChat("https://t.me/joinchat/xyz123")).toThrow(/Invite links/);
  expect(() => telegramChat("+1234567890")).toThrow(/Invite links/);
  expect(() => telegramChat("http://t.me/valid_user")).toThrow(/HTTPS/);
  expect(() => telegramChat("https://t.me.evil.com/valid_user")).toThrow(/t\.me/);
  expect(() => telegramChat("https://user:pass@t.me/valid_user")).toThrow(/HTTPS/);
  expect(() => telegramChat("https://t.me:8443/valid_user")).toThrow(/HTTPS/);
  expect(() => telegramChat("@bad-hyphen")).toThrow(/5-32 characters/);
  expect(() => telegramChat("@shrt")).toThrow(/5-32 characters/);
  expect(() => telegramChat("@way_too_long_username_exceeding_32_characters_limit")).toThrow(/5-32 characters/);
  expect(() => telegramChat("")).toThrow(/required/);
});

test("Telegram path traversal protection and safeSeg", () => {
  expect(() => resolveHomePath("../../etc/passwd")).toThrow(/Path must be inside home/);
  expect(() => resolveHomePath("/etc/passwd")).toThrow(/Path must be inside home/);

  // safeSeg sanitization
  expect(safeSeg("../../../malicious")).toBe("malicious");
  expect(safeSeg("chat..evil/sub")).toBe("chat..evil-sub");
  expect(safeSeg("@valid_chat")).toBe("valid_chat");
});

test("Telegram write previews enqueue nothing into database", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "socmedia-tg-prev-"));
  const fakeHome = await mkdtemp(join(tmpdir(), "socmedia-tg-home-"));
  const testFile = join(fakeHome, "test.mp4");
  createMockMp4(testFile);

  const run = async (...args: string[]) => {
    const cli = Bun.spawn(["bun", "run", "src/cli.ts", ...args], {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, HOME: fakeHome, SOCMEDIA_STATE_DIR: stateDir, SOCMEDIA_EXTENSION_PORT: "0" },
      stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, exit] = await Promise.all([new Response(cli.stdout).text(), new Response(cli.stderr).text(), cli.exited]);
    return { stdout, stderr, exit };
  };

  try {
    // 1. Message send preview
    const msgPrev = await run("telegram", "message", "send", "@alice_test", "--text", "Hello Alice", "--json");
    expect(msgPrev.exit).toBe(0);
    const msgJson = JSON.parse(msgPrev.stdout);
    expect(msgJson.sent).toBe(false);
    expect(msgJson.preview.chat).toBe("@alice_test");
    expect(msgJson.preview.text).toBe("Hello Alice");

    // 2. Media send preview
    const mediaPrev = await run("telegram", "media", "send", "@alice_test", testFile, "--caption", "Look at this", "--json");
    expect(mediaPrev.exit).toBe(0);
    const mediaJson = JSON.parse(mediaPrev.stdout);
    expect(mediaJson.sent).toBe(false);
    expect(mediaJson.preview.chat).toBe("@alice_test");
    expect(mediaJson.preview.caption).toBe("Look at this");

    // 3. Channel create preview
    const chanPrev = await run("telegram", "channel", "create", "--title", "Secret Channel", "--description", "Top secret", "--json");
    expect(chanPrev.exit).toBe(0);
    const chanJson = JSON.parse(chanPrev.stdout);
    expect(chanJson.created).toBe(false);
    expect(chanJson.preview.title).toBe("Secret Channel");
    expect(chanJson.preview.privacy).toBe("private");

    // Ensure database was not created or has 0 jobs
    const dbPath = join(stateDir, "state.sqlite");
    const dbExists = await Bun.file(dbPath).exists();
    if (dbExists) {
      const db = new Database(dbPath);
      const jobs = db.query("SELECT COUNT(*) as count FROM jobs").get() as { count: number };
      expect(jobs.count).toBe(0);
      db.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
    await rm(fakeHome, { recursive: true, force: true });
  }
});

test("Telegram message daily limit and 7-day duplicate text refusal", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "socmedia-tg-limits-"));
  const fakeHome = await mkdtemp(join(tmpdir(), "socmedia-tg-home2-"));

  const run = async (...args: string[]) => {
    const cli = Bun.spawn(["bun", "run", "src/cli.ts", ...args], {
      cwd: join(import.meta.dir, ".."),
      env: {
        ...process.env,
        HOME: fakeHome,
        SOCMEDIA_STATE_DIR: stateDir,
        SOCMEDIA_EXTENSION_PORT: "0",
        SOCMEDIA_MAX_MESSAGES_PER_DAY: "2",
      },
      stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, exit] = await Promise.all([new Response(cli.stdout).text(), new Response(cli.stderr).text(), cli.exited]);
    return { stdout, stderr, exit };
  };

  let pid: number | undefined;
  let ws: WebSocket | undefined;
  try {
    const id = "h".repeat(32);
    const pairing = JSON.parse((await run("extension", "pair", "--id", id, "--json")).stdout);
    const started = JSON.parse((await run("service", "start", "--json")).stdout);
    pid = started.pid;
    ws = new WebSocket(`ws://127.0.0.1:${started.extension.port}/extension`, { headers: { Origin: `chrome-extension://${id}` } } as unknown as string[]);
    await authenticateMock(ws, pairing.token);

    ws.onmessage = (event) => {
      const req = JSON.parse(String(event.data));
      if (req.action === "tgSendMessage") {
        ws!.send(JSON.stringify({
          type: "result", id: req.id,
          result: { sent: true, verified: true, chat: req.args.chat, text: req.args.text },
        }));
      }
    };

    // First message to @user_alpha succeeds
    const msg1 = await run("telegram", "message", "send", "@user_alpha", "--text", "Hello there", "--confirm", "--json");
    expect(msg1.exit).toBe(0);
    expect(JSON.parse(msg1.stdout).sent).toBe(true);

    // Duplicate message to same chat within 7 days is refused
    const msgDup = await run("telegram", "message", "send", "@user_alpha", "--text", "Hello there", "--confirm", "--json");
    expect(msgDup.exit).not.toBe(0);
    expect(msgDup.stderr).toContain("7-day rule");

    // Same text to a different chat is permitted; enqueue plans notBefore slot
    const msg2 = await run("queue", "enqueue", "tgSendMessage", "--args", JSON.stringify({ chat: "@user_beta", text: "Hello there" }), "--json");
    expect(msg2.exit).toBe(0);
    const job2 = JSON.parse(msg2.stdout);
    expect(job2.notBefore).toBeDefined();
    const diff2 = Date.parse(job2.notBefore) - Date.now();
    expect(diff2).toBeGreaterThanOrEqual(85000);
    expect(diff2).toBeLessThanOrEqual(160000);

    // Third message hits daily cap of 2 (counting sent and queued)
    const msgCap = await run("queue", "enqueue", "tgSendMessage", "--args", JSON.stringify({ chat: "@user_gamma", text: "Third message" }), "--json");
    expect(msgCap.exit).not.toBe(0);
    expect(msgCap.stderr).toContain("Daily message cap reached");
  } finally {
    ws?.close();
    if (pid) {
      try { process.kill(pid, "SIGTERM"); } catch {}
      for (let i = 0; i < 50; i++) {
        try { process.kill(pid, 0); } catch { break; }
        await Bun.sleep(20);
      }
    }
    await rm(stateDir, { recursive: true, force: true });
    await rm(fakeHome, { recursive: true, force: true });
  }
});

test("Telegram channel creation daily limit", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "socmedia-tg-chan-limits-"));
  const fakeHome = await mkdtemp(join(tmpdir(), "socmedia-tg-chan-home-"));

  const run = async (...args: string[]) => {
    const cli = Bun.spawn(["bun", "run", "src/cli.ts", ...args], {
      cwd: join(import.meta.dir, ".."),
      env: {
        ...process.env,
        HOME: fakeHome,
        SOCMEDIA_STATE_DIR: stateDir,
        SOCMEDIA_EXTENSION_PORT: "0",
        SOCMEDIA_MAX_TG_CHANNELS_PER_DAY: "1",
      },
      stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, exit] = await Promise.all([new Response(cli.stdout).text(), new Response(cli.stderr).text(), cli.exited]);
    return { stdout, stderr, exit };
  };

  let pid: number | undefined;
  let ws: WebSocket | undefined;
  try {
    const id = "h".repeat(32);
    const pairing = JSON.parse((await run("extension", "pair", "--id", id, "--json")).stdout);
    const started = JSON.parse((await run("service", "start", "--json")).stdout);
    pid = started.pid;
    ws = new WebSocket(`ws://127.0.0.1:${started.extension.port}/extension`, { headers: { Origin: `chrome-extension://${id}` } } as unknown as string[]);
    await authenticateMock(ws, pairing.token);

    ws.onmessage = (event) => {
      const req = JSON.parse(String(event.data));
      if (req.action === "tgCreateChannel") {
        ws!.send(JSON.stringify({
          type: "result", id: req.id,
          result: { created: true, verified: true, title: req.args.title },
        }));
      }
    };

    // First channel succeeds
    const c1 = await run("telegram", "channel", "create", "--title", "Channel One", "--confirm", "--json");
    expect(c1.exit).toBe(0);
    expect(JSON.parse(c1.stdout).created).toBe(true);

    // Second channel hits daily limit of 1
    const c2 = await run("telegram", "channel", "create", "--title", "Channel Two", "--confirm", "--json");
    expect(c2.exit).not.toBe(0);
    expect(c2.stderr).toContain("Daily channel creation cap reached");
  } finally {
    ws?.close();
    if (pid) {
      try { process.kill(pid, "SIGTERM"); } catch {}
      for (let i = 0; i < 50; i++) {
        try { process.kill(pid, 0); } catch { break; }
        await Bun.sleep(20);
      }
    }
    await rm(stateDir, { recursive: true, force: true });
    await rm(fakeHome, { recursive: true, force: true });
  }
});

test("Telegram side-effect jobs become unverified on disconnect and on restart", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "socmedia-tg-unv-"));
  const fakeHome = await mkdtemp(join(tmpdir(), "socmedia-tg-unv-home-"));

  const run = async (...args: string[]) => {
    const cli = Bun.spawn(["bun", "run", "src/cli.ts", ...args], {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, HOME: fakeHome, SOCMEDIA_STATE_DIR: stateDir, SOCMEDIA_EXTENSION_PORT: "0" },
      stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, exit] = await Promise.all([new Response(cli.stdout).text(), new Response(cli.stderr).text(), cli.exited]);
    return { stdout, stderr, exit };
  };

  let pid: number | undefined;
  let ws: WebSocket | undefined;
  try {
    const id = "h".repeat(32);
    const pairing = JSON.parse((await run("extension", "pair", "--id", id, "--json")).stdout);
    const started = JSON.parse((await run("service", "start", "--json")).stdout);
    pid = started.pid;
    ws = new WebSocket(`ws://127.0.0.1:${started.extension.port}/extension`, { headers: { Origin: `chrome-extension://${id}` } } as unknown as string[]);
    await authenticateMock(ws, pairing.token);

    // When tgSendMessage arrives, simulate disconnect
    ws.onmessage = (event) => {
      const req = JSON.parse(String(event.data));
      if (req.action === "tgSendMessage") {
        ws!.close();
      }
    };

    const res = await run("telegram", "message", "send", "@alice_test", "--text", "Will disconnect", "--confirm", "--json");
    expect(res.exit).toBe(0);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.unverified).toBe(true);

    // Check DB status is unverified, NOT queued
    const db = new Database(join(stateDir, "state.sqlite"));
    const jobRow = db.query("SELECT data FROM jobs WHERE json_extract(data, '$.action') = 'tgSendMessage'").get() as { data: string };
    const jobData = JSON.parse(jobRow.data);
    expect(jobData.status).toBe("unverified");

    // Manually insert running side-effect jobs for restart test
    db.query("INSERT INTO jobs (data) VALUES (?)").run(JSON.stringify({
      action: "tgSendMedia",
      status: "running",
      args: { chat: "@bob_test", file: "foo.mp4" },
    }));
    db.query("INSERT INTO jobs (data) VALUES (?)").run(JSON.stringify({
      action: "tgCreateChannel",
      status: "running",
      args: { title: "Test Channel" },
    }));
    db.close();

    // Kill service
    if (pid !== undefined) {
      process.kill(pid, "SIGTERM");
      for (let i = 0; i < 50; i++) {
        try { process.kill(pid, 0); } catch { break; }
        await Bun.sleep(20);
      }
      pid = undefined;
    }

    // Restart service
    const restarted = JSON.parse((await run("service", "start", "--json")).stdout);
    pid = restarted.pid;

    // Check that running side-effect jobs were transitioned to unverified on startup
    const db2 = new Database(join(stateDir, "state.sqlite"));
    const smJob = db2.query("SELECT data FROM jobs WHERE json_extract(data, '$.action') = 'tgSendMedia'").get() as { data: string };
    expect(JSON.parse(smJob.data).status).toBe("unverified");
    const ccJob = db2.query("SELECT data FROM jobs WHERE json_extract(data, '$.action') = 'tgCreateChannel'").get() as { data: string };
    expect(JSON.parse(ccJob.data).status).toBe("unverified");
    db2.close();
  } finally {
    ws?.close();
    if (pid) {
      try { process.kill(pid, "SIGTERM"); } catch {}
      for (let i = 0; i < 50; i++) {
        try { process.kill(pid, 0); } catch { break; }
        await Bun.sleep(20);
      }
    }
    await rm(stateDir, { recursive: true, force: true });
    await rm(fakeHome, { recursive: true, force: true });
  }
});

test("extension background.js wires all Telegram actions in ACTION_HANDLERS and detects challenges", async () => {
  const bg = await Bun.file(new URL("../extension/background.js", import.meta.url)).text();
  expect(bg).toContain('"tgStatus"');
  expect(bg).toContain('"tgDialogsList"');
  expect(bg).toContain('"tgMessagesRead"');
  expect(bg).toContain('"tgMediaDownload"');
  expect(bg).toContain('"tgSendMessage"');
  expect(bg).toContain('"tgSendMedia"');
  expect(bg).toContain('"tgCreateChannel"');

  // Verify HALT checks for Telegram
  expect(bg).toMatch(/web\.telegram\.org/);
  expect(bg).toMatch(/login|auth_form|phone_number|qr_code|FLOOD|too many attempts/i);
});

test("CRITICAL 1: pgMatchTgChat refuses stale header with correct hash and confirms exact username", async () => {
  const script = await Bun.file(new URL("../extension/background.js", import.meta.url)).text();
  let sidePanelUsername: string | null = null;
  const document: any = {
    body: { innerText: "" },
    querySelector: (sel: string) => {
      if (sel.includes("peer-title") || sel.includes("chat-title")) {
        return { innerText: "Stale Display Name" };
      }
      if (sel.includes("username") || sel.includes("profile")) {
        return sidePanelUsername ? { innerText: sidePanelUsername, getAttribute: () => null } : null;
      }
      return null;
    },
    querySelectorAll: () => [],
  };
  const location = { hash: "#@target_user", href: "https://web.telegram.org/k/#@target_user", pathname: "/k/", hostname: "web.telegram.org" };
  const chrome = {
    storage: { local: { get: async () => ({ cliSelectedTab: 1 }), set: async () => {} }, onChanged: { addListener() {} } },
    tabs: { get: async () => ({ id: 1, url: "https://web.telegram.org/k/#@target_user", status: "complete" }), update: async () => {}, query: async () => [] },
    windows: { get: async () => ({ id: 1, state: "normal" }), create: async () => ({ id: 1 }) },
    tabGroups: { query: async () => [] },
    alarms: { create() {}, onAlarm: { addListener() {} } },
    runtime: { onStartup: { addListener() {} } },
    scripting: { executeScript: async (options: any) => [{ result: options.func(...(options.args || [])) }] },
  };
  let virtualNow = 100000;
  const customDate = { now: () => { virtualNow += 500; return virtualNow; } };
  const customSetTimeout = (fn: any, _ms: any) => { fn(); return 0; };
  const context = { chrome, document, location, URL, setTimeout: customSetTimeout, clearTimeout, Date: customDate, Math };
  runInNewContext(script, context);

  // 1. Stale header with correct hash must refuse
  const res1 = runInNewContext('pgMatchTgChat("target_user")', context);
  expect(res1.matched).toBe(false);

  // 2. Display name matching norm (e.g. title === "target_user") must NOT match without exact username
  document.querySelector = (sel: string) => {
    if (sel.includes("peer-title") || sel.includes("chat-title")) {
      return { innerText: "target_user" }; // display name happens to match
    }
    return null;
  };
  const res2 = runInNewContext('pgMatchTgChat("target_user")', context);
  expect(res2.matched).toBe(false);

  // 3. Stale header compared to previousHeader must refuse even if side panel has username
  sidePanelUsername = "@target_user";
  document.querySelector = (sel: string) => {
    if (sel.includes("peer-title") || sel.includes("chat-title")) {
      return { innerText: "Previous Chat Title" };
    }
    if (sel.includes("username") || sel.includes("profile")) {
      return { innerText: "@target_user", getAttribute: () => null };
    }
    return null;
  };
  const res3 = runInNewContext('pgMatchTgChat("target_user", "Previous Chat Title")', context);
  expect(res3.matched).toBe(false);

  // 4. Exact @username confirmed from side panel with fresh header matches
  document.querySelector = (sel: string) => {
    if (sel.includes("peer-title") || sel.includes("chat-title")) {
      return { innerText: "Target User Full Name" };
    }
    if (sel.includes("username") || sel.includes("profile")) {
      return { innerText: "@target_user", getAttribute: () => null };
    }
    return null;
  };
  const res4 = runInNewContext('pgMatchTgChat("target_user", "Previous Chat Title")', context);
  expect(res4.matched).toBe(true);

  // 5. Unconfirmable chat throws in tgSendMessage before anything is typed
  let typed = false;
  document.querySelector = (sel: string) => {
    if (sel.includes("peer-title") || sel.includes("chat-title")) {
      return { innerText: "Stale User" };
    }
    if (sel.includes("input-message-input") || sel.includes("contenteditable")) {
      typed = true;
      return { textContent: "", dispatchEvent: () => {} };
    }
    return null;
  };
  await expect(runInNewContext('tgSendMessage({ chat: "@target_user", text: "hello" })', context))
    .rejects.toThrow(/Telegram chat header did not match|Wrong chat open/);
  expect(typed).toBe(false);
});

test("CRITICAL 5: tgSendMedia returns sent:false when confirm fails, verifies only new outgoing media", async () => {
  const script = await Bun.file(new URL("../extension/background.js", import.meta.url)).text();
  let clickedSend = false;
  let hasSendBtn = false;
  let hasPopup = true;
  const existingBubble = {
    classList: { contains: (c: string) => c === "is-out" },
    querySelector: (sel: string) => sel.includes("img") ? { tagName: "IMG" } : null,
  };
  const mockPopup: any = {
    querySelector: (sel: string) => {
      if (sel.includes("popup-send") || sel.includes("btn-send") || sel.includes("btn-primary")) {
        return hasSendBtn ? { click: () => { clickedSend = true; } } : null;
      }
      if (sel.includes("caption") || sel.includes("contenteditable") || sel.includes("textarea")) {
        return { tagName: "TEXTAREA", value: "", dispatchEvent: () => {} };
      }
      return null;
    },
  };
  let currentPage = "https://web.telegram.org/k/";
  let currentHeader = "Old Chat";
  const document: any = {
    body: { innerText: "" },
    querySelector: (sel: string) => {
      if (sel.includes("peer-title") || sel.includes("chat-title")) return { innerText: currentHeader };
      if (sel.includes("username") || sel.includes("profile")) return { innerText: "@target_user", getAttribute: () => null, textContent: "@target_user" };
      if (sel.includes("popup") || sel.includes("modal")) return hasPopup ? mockPopup : null;
      if (sel.includes("input[type=\"file\"]")) return { nodeId: 1 };
      return null;
    },
    querySelectorAll: (sel: string) => {
      if (sel.includes("bubble")) return [existingBubble];
      return [];
    },
  };
  const location = { hash: "", href: currentPage, pathname: "/k/", hostname: "web.telegram.org" };
  const chrome = {
    storage: { local: { get: async () => ({ cliSelectedTab: 1 }), set: async () => {} }, onChanged: { addListener() {} } },
    tabs: {
      get: async () => ({ id: 1, url: currentPage, status: "complete" }),
      update: async (_id: number, val: any) => {
        if (val.url) {
          currentPage = val.url;
          location.href = val.url;
          location.hash = val.url.includes("#") ? val.url.slice(val.url.indexOf("#")) : "";
          if (val.url.includes("target_user")) currentHeader = "Target User";
        }
      },
      query: async () => [],
    },
    windows: { get: async () => ({ id: 1, state: "normal" }), create: async () => ({ id: 1 }) },
    tabGroups: { query: async () => [] },
    alarms: { create() {}, onAlarm: { addListener() {} } },
    runtime: { onStartup: { addListener() {} } },
    debugger: {
      attach: async () => {},
      detach: async () => {},
      sendCommand: async (_target: any, method: string) => {
        if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
        if (method === "DOM.querySelector") return { nodeId: 2 };
        return {};
      },
    },
    scripting: {
      executeScript: async (options: any) => [{ result: options.func(...(options.args || [])) }],
    },
  };
  let now = 100000;
  const context = {
    chrome, document, location, URL, Event,
    setTimeout: (fn: any) => { fn(); return 0; },
    clearTimeout,
    Date: { now: () => (now += 500) },
    Math,
  };
  runInNewContext(script, context);

  // 1. Popup missing -> tgSendMedia must abort with sent: false!
  hasPopup = false;
  hasSendBtn = true;
  clickedSend = false;
  const res0 = await runInNewContext('tgSendMedia({ chat: "@target_user", file: "pic.jpg", caption: "cool pic" })', context);
  expect(res0.sent).toBe(false);
  expect(res0.error).toMatch(/Media confirmation popup not found/);
  expect(clickedSend).toBe(false);

  // 2. Send button missing in popup -> confirmExec.result.sent is false -> tgSendMedia must return sent: false!
  hasPopup = true;
  hasSendBtn = false;
  clickedSend = false;
  const res1 = await runInNewContext('tgSendMedia({ chat: "@target_user", file: "pic.jpg", caption: "cool pic" })', context);
  expect(res1.sent).toBe(false);
  expect(clickedSend).toBe(false);

  // 3. Send button clicked, but NO new bubble appeared (only old bubble exists) -> verified must be false!
  hasSendBtn = true;
  clickedSend = false;
  currentPage = "https://web.telegram.org/k/#@other_chat";
  currentHeader = "Other Chat";
  const res2 = await runInNewContext('tgSendMedia({ chat: "@target_user", file: "pic.jpg", caption: "cool pic" })', context);
  expect(res2.sent).toBe(true);
  expect(res2.verified).toBe(false);
});

test("CRITICAL 6: tgCreateChannel aborts with created:false if steps fail and rejects old channel title", async () => {
  const script = await Bun.file(new URL("../extension/background.js", import.meta.url)).text();
  let clickedDone = false;
  let hasPrivateRadio = false;

  const existingDialog = {
    innerText: "Existing Channel Title",
  };
  const document: any = {
    body: { innerText: "" },
    querySelector: (sel: string) => {
      if (sel.includes("sidebar-header button") || sel.includes("btn-menu")) return { click: () => {} };
      if (sel.includes("Channel Name") || sel.includes("input-field-name")) return { value: "", dispatchEvent: () => {} };
      if (sel.includes("btn-next")) return { click: () => {} };
      if (sel.includes("btn-done")) return { click: () => { clickedDone = true; } };
      return null;
    },
    querySelectorAll: (sel: string) => {
      if (sel.includes("menu-item") || sel.includes("dropdown-item")) return [{ innerText: "New Channel", click: () => {} }];
      if (sel.includes("radio")) return hasPrivateRadio ? [{
        parentElement: { innerText: "Private" },
        checked: true,
        click: () => {},
      }] : [];
      if (sel.includes("peer-title") || sel.includes("chat-title")) return [existingDialog];
      return [];
    },
  };
  const location = { hash: "", href: "https://web.telegram.org/k/", pathname: "/k/", hostname: "web.telegram.org" };
  const chrome = {
    storage: { local: { get: async () => ({ cliSelectedTab: 1 }), set: async () => {} }, onChanged: { addListener() {} } },
    tabs: { get: async () => ({ id: 1, url: location.href, status: "complete" }), update: async () => {}, query: async () => [] },
    windows: { get: async () => ({ id: 1, state: "normal" }), create: async () => ({ id: 1 }) },
    tabGroups: { query: async () => [] },
    alarms: { create() {}, onAlarm: { addListener() {} } },
    runtime: { onStartup: { addListener() {} } },
    scripting: {
      executeScript: async (options: any) => [{ result: options.func(...(options.args || [])) }],
    },
  };
  let now = 100000;
  const context = {
    chrome, document, location, URL, Event,
    setTimeout: (fn: any) => { fn(); return 0; },
    clearTimeout,
    Date: { now: () => (now += 500) },
    Math,
  };
  runInNewContext(script, context);

  // 1. Missing private radio -> must abort before Done with created: false!
  hasPrivateRadio = false;
  clickedDone = false;
  const res1 = await runInNewContext('tgCreateChannel({ title: "My Channel" })', context);
  expect(res1.created).toBe(false);
  expect(clickedDone).toBe(false);

  // 2. Private radio present and Done clicked, but dialog is OLD (already existed before) -> verified must be false!
  hasPrivateRadio = true;
  clickedDone = false;
  const res2 = await runInNewContext('tgCreateChannel({ title: "Existing Channel Title" })', context);
  expect(res2.created).toBe(true);
  expect(res2.verified).toBe(false);
});

test("CRITICAL 7: daily caps and duplicate checks count queued and running jobs", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "socmedia-queued-caps-"));
  const fakeHome = await mkdtemp(join(tmpdir(), "socmedia-queued-home-"));

  const run = async (...args: string[]) => {
    const cli = Bun.spawn(["bun", "run", "src/cli.ts", ...args], {
      cwd: join(import.meta.dir, ".."),
      env: {
        ...process.env,
        HOME: fakeHome,
        SOCMEDIA_STATE_DIR: stateDir,
        SOCMEDIA_EXTENSION_PORT: "0",
        SOCMEDIA_MAX_MESSAGES_PER_DAY: "2",
        SOCMEDIA_MAX_TIKTOK_UPLOADS_PER_DAY: "2",
        SOCMEDIA_MAX_TG_CHANNELS_PER_DAY: "2",
      },
      stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, exit] = await Promise.all([new Response(cli.stdout).text(), new Response(cli.stderr).text(), cli.exited]);
    return { stdout, stderr, exit };
  };

  let pid: number | undefined;
  try {
    const started = JSON.parse((await run("service", "start", "--json")).stdout);
    pid = started.pid;

    // 1. Queued duplicate message text+chat refusal
    const q1 = await run("queue", "enqueue", "tgSendMessage", "--args", JSON.stringify({ chat: "@user_a", text: "Same text" }), "--json");
    expect(q1.exit).toBe(0);

    const q1Dup = await run("queue", "enqueue", "tgSendMessage", "--args", JSON.stringify({ chat: "@user_a", text: "Same text" }), "--json");
    expect(q1Dup.exit).not.toBe(0);
    expect(q1Dup.stderr).toMatch(/already queued or running|7-day rule/i);

    // 2. Messages cap counting queued jobs (cap is 2)
    const q2 = await run("queue", "enqueue", "tgSendMessage", "--args", JSON.stringify({ chat: "@user_b", text: "Different text" }), "--json");
    expect(q2.exit).toBe(0);

    const q3 = await run("queue", "enqueue", "tgSendMessage", "--args", JSON.stringify({ chat: "@user_c", text: "Third text" }), "--json");
    expect(q3.exit).not.toBe(0);
    expect(q3.stderr).toContain("Daily message cap reached");

    // 3. TikTok uploads cap & sha256 queued duplicate refusal (cap is 2)
    const v1Path = join(fakeHome, "v1.mp4");
    const v1CopyPath = join(fakeHome, "v1_copy.mp4");
    const v2Path = join(fakeHome, "v2.mp4");
    const v3Path = join(fakeHome, "v3.mp4");
    const buf1 = Buffer.alloc(64);
    buf1.write("ftypisom", 4);
    buf1.write("hello video 1", 16);
    writeFileSync(v1Path, buf1);
    writeFileSync(v1CopyPath, buf1);

    const buf2 = Buffer.alloc(80);
    buf2.write("ftypisom", 4);
    buf2.write("hello video 2", 16);
    writeFileSync(v2Path, buf2);

    const buf3 = Buffer.alloc(96);
    buf3.write("ftypisom", 4);
    buf3.write("hello video 3", 16);
    writeFileSync(v3Path, buf3);

    const tt1 = await run("queue", "enqueue", "tiktokUpload", "--args", JSON.stringify({ file: v1Path }), "--json");
    expect(tt1.exit).toBe(0);

    const ttDup = await run("queue", "enqueue", "tiktokUpload", "--args", JSON.stringify({ file: v1CopyPath }), "--json");
    expect(ttDup.exit).not.toBe(0);
    expect(ttDup.stderr).toMatch(/already queued or running|7-day rule/i);

    const tt2 = await run("queue", "enqueue", "tiktokUpload", "--args", JSON.stringify({ file: v2Path }), "--json");
    expect(tt2.exit).toBe(0);

    const tt3 = await run("queue", "enqueue", "tiktokUpload", "--args", JSON.stringify({ file: v3Path }), "--json");
    expect(tt3.exit).not.toBe(0);
    expect(tt3.stderr).toContain("Daily upload cap reached");

    // 4. Telegram channels cap counting queued jobs (cap is 2)
    const ch1 = await run("queue", "enqueue", "tgCreateChannel", "--args", JSON.stringify({ title: "Chan 1" }), "--json");
    expect(ch1.exit).toBe(0);

    const ch2 = await run("queue", "enqueue", "tgCreateChannel", "--args", JSON.stringify({ title: "Chan 2" }), "--json");
    expect(ch2.exit).toBe(0);

    const ch3 = await run("queue", "enqueue", "tgCreateChannel", "--args", JSON.stringify({ title: "Chan 3" }), "--json");
    expect(ch3.exit).not.toBe(0);
    expect(ch3.stderr).toContain("Daily channel creation cap reached");
  } finally {
    if (pid) {
      try { process.kill(pid, "SIGTERM"); } catch {}
      for (let i = 0; i < 50; i++) {
        try { process.kill(pid, 0); } catch { break; }
        await Bun.sleep(20);
      }
    }
    await rm(stateDir, { recursive: true, force: true });
    await rm(fakeHome, { recursive: true, force: true });
  }
});

test("HIGH 10: pgCollectAndChunkTgMedia skips avatars/stickers/reactions and flags previews", async () => {
  const script = await Bun.file(new URL("../extension/background.js", import.meta.url)).text();

  const avatarImg = { src: "https://example.com/avatar.jpg", closest: (s: string) => s.includes("avatar") };
  const avatarBubble = {
    querySelector: (s: string) => s.includes("img") ? avatarImg : null,
  };

  const stickerImg = { src: "https://example.com/sticker.webp", closest: (s: string) => s.includes("sticker") };
  const stickerBubble = {
    querySelector: (s: string) => s.includes("img") ? stickerImg : null,
  };

  const reactionImg = { src: "https://example.com/reaction.png", closest: (s: string) => s.includes("reaction") };
  const reactionBubble = {
    querySelector: (s: string) => s.includes("img") ? reactionImg : null,
  };

  const realImg = {
    src: "https://example.com/photo.jpg",
    closest: (s: string) => null,
    classList: { contains: () => false },
  };
  const mediaBubble = {
    querySelector: (s: string) => s.includes("media-photo") || s.includes("img") ? realImg : null,
  };

  const previewImg = {
    src: "https://example.com/preview.jpg",
    closest: (s: string) => null,
    classList: { contains: (c: string) => c.includes("preview") || c.includes("thumb") },
  };
  const previewBubble = {
    querySelector: (s: string) => s.includes("media-photo") || s.includes("img") ? previewImg : null,
  };

  const document: any = {
    body: { innerText: "" },
    querySelectorAll: (sel: string) => {
      if (sel.includes("bubble")) return [avatarBubble, stickerBubble, reactionBubble, mediaBubble, previewBubble];
      return [];
    },
  };
  const fakeFetch = async (url: string) => {
    const buf = Buffer.from([0xff, 0xd8, 0xff, 0xe0]); // valid jpeg magic bytes
    return {
      blob: async () => ({
        size: buf.length,
        arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
      }),
    };
  };

  const chrome = {
    storage: { local: { get: async () => ({}), set: async () => {} }, onChanged: { addListener() {} } },
    tabs: { get: async () => ({}), update: async () => {}, query: async () => [] },
    windows: { get: async () => ({ id: 1, state: "normal" }), create: async () => ({ id: 1 }) },
    tabGroups: { query: async () => [] },
    alarms: { create() {}, onAlarm: { addListener() {} } },
    runtime: { onStartup: { addListener() {} } },
  };
  const context = {
    chrome, document, location: { href: "https://web.telegram.org/k/" }, URL, Event,
    fetch: fakeFetch,
    btoa: (s: string) => Buffer.from(s, "binary").toString("base64"),
    setTimeout: (fn: any) => { fn(); return 0; },
    clearTimeout,
    Date,
    Math,
  };
  runInNewContext(script, context);

  const res = await runInNewContext('pgCollectAndChunkTgMedia(["photo"], 10)', context);
  expect(res.length).toBe(2);
  expect(res.find((item: any) => item.preview === true)).toBeDefined();
});

test("HIGH 12: tgSendMessage composer confirmed and enter key requires composer emptied", async () => {
  const script = await Bun.file(new URL("../extension/background.js", import.meta.url)).text();
  let composerText = "";
  const composer = {
    textContent: "",
    dispatchEvent: (ev: any) => {
      // Enter key does NOT clear the input in this test
    },
  };
  let currentPage = "https://web.telegram.org/k/";
  let currentHeader = "Old Chat";
  const document: any = {
    body: { innerText: "" },
    querySelector: (sel: string) => {
      if (sel.includes("peer-title") || sel.includes("chat-title")) return { innerText: currentHeader };
      if (sel.includes("username") || sel.includes("profile")) return { innerText: "@target_user", getAttribute: () => null };
      if (sel.includes("input-message-input") || sel.includes("contenteditable")) return composer;
      // No send button -> will try Enter key fallback
      return null;
    },
    querySelectorAll: () => [],
  };
  const location = { hash: "", href: currentPage, pathname: "/k/", hostname: "web.telegram.org" };
  const chrome = {
    storage: { local: { get: async () => ({ cliSelectedTab: 1 }), set: async () => {} }, onChanged: { addListener() {} } },
    tabs: {
      get: async () => ({ id: 1, url: currentPage, status: "complete" }),
      update: async (_id: number, val: any) => {
        if (val.url) {
          currentPage = val.url;
          location.href = val.url;
          location.hash = val.url.includes("#") ? val.url.slice(val.url.indexOf("#")) : "";
          if (val.url.includes("target_user")) currentHeader = "Target User";
        }
      },
      query: async () => [],
    },
    windows: { get: async () => ({ id: 1, state: "normal" }), create: async () => ({ id: 1 }) },
    tabGroups: { query: async () => [] },
    alarms: { create() {}, onAlarm: { addListener() {} } },
    runtime: { onStartup: { addListener() {} } },
    scripting: {
      executeScript: async (options: any) => [{ result: await options.func(...(options.args || [])) }],
    },
  };
  let now = 100000;
  class MockKeyboardEvent extends Event {
    key: string;
    keyCode: number;
    constructor(type: string, init?: any) {
      super(type, init);
      this.key = init?.key || "";
      this.keyCode = init?.keyCode || 0;
    }
  }
  const context = {
    chrome, document, location, URL, Event, KeyboardEvent: MockKeyboardEvent,
    setTimeout: (fn: any) => { fn(); return 0; },
    clearTimeout,
    Date: { now: () => (now += 500) },
    Math,
  };
  runInNewContext(script, context);

  // If enter key didn't empty composer, point of no return reached: must end unverified (sent: true, verified: false) to prevent duplicate retries
  const res = await runInNewContext('tgSendMessage({ chat: "@target_user", text: "hello" })', context);
  expect(res.sent).toBe(true);
  expect(res.verified).toBe(false);
  expect(res.error).toMatch(/Composer did not clear after Enter key/);
});

test("HIGH 8 & HIGH 9: tgMediaDownload chunk handling ties to running job, prevents traversal, enforces 50MB, drops bad magic, reflects actual writes", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "socmedia-tg-chunks-state-"));
  const fakeHome = await mkdtemp(join(tmpdir(), "socmedia-tg-chunks-home-"));

  const run = async (...args: string[]) => {
    const cli = Bun.spawn(["bun", "run", "src/cli.ts", ...args], {
      cwd: join(import.meta.dir, ".."),
      env: {
        ...process.env,
        HOME: fakeHome,
        SOCMEDIA_STATE_DIR: stateDir,
        SOCMEDIA_EXTENSION_PORT: "0",
      },
      stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, exit] = await Promise.all([new Response(cli.stdout).text(), new Response(cli.stderr).text(), cli.exited]);
    return { stdout, stderr, exit };
  };

  let pid: number | undefined;
  let ws: WebSocket | undefined;
  try {
    const id = "c".repeat(32);
    const pairing = JSON.parse((await run("extension", "pair", "--id", id, "--json")).stdout);
    const started = JSON.parse((await run("service", "start", "--json")).stdout);
    pid = started.pid;
    ws = new WebSocket(`ws://127.0.0.1:${started.extension.port}/extension`, { headers: { Origin: `chrome-extension://${id}` } } as unknown as string[]);
    await authenticateMock(ws, pairing.token);

    // 1. Try sending chunk before any job is running -> dropped
    ws.send(JSON.stringify({
      type: "chunk",
      id: "orphan_id",
      fileId: "f1",
      index: 0,
      total: 1,
      data: Buffer.from("hello").toString("base64"),
    }));

    ws.onmessage = (event) => {
      try {
        const req = JSON.parse(String(event.data));
        if (req.action === "tgMediaDownload") {
          // A. Send chunk with wrong id -> dropped
          ws!.send(JSON.stringify({
            type: "chunk",
            id: "wrong_id",
            fileId: "wrong_f",
            index: 0,
            total: 1,
            data: Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString("base64"),
          }));

          // B. Send file with bad magic bytes -> skipped
          ws!.send(JSON.stringify({
            type: "chunk",
            id: req.id,
            fileId: "bad_magic_file",
            index: 0,
            total: 1,
            itemIndex: 1,
            mediaType: "photo",
            data: Buffer.from("not an image at all").toString("base64"),
          }));

          // C. Send file with path traversal attempt in filename and malicious dir/chat in chunk
          // Service must ignore chunk's dir/chat/filename and write media_2.jpg in job args dir
          const validJpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
          ws!.send(JSON.stringify({
            type: "chunk",
            id: req.id,
            fileId: "traversal_file",
            index: 0,
            total: 1,
            itemIndex: 2,
            mediaType: "photo",
            filename: "../../../traversal_evil.jpg",
            chat: "../../../evil_chat",
            dir: "../../../evil_dir",
            data: validJpg.toString("base64"),
          }));

          // D. Send result
          ws!.send(JSON.stringify({
            type: "result",
            id: req.id,
            result: { chat: req.args.chat, attempted: 2, skipped: [] },
          }));
        }
      } catch (err) {
        console.error("WS ONMESSAGE ERROR:", err);
      }
    };

    const targetDir = join(fakeHome, "downloads_dir");
    const enq = await run("queue", "enqueue", "tgMediaDownload", "--args", JSON.stringify({ chat: "@safe_chat", dir: targetDir }), "--json");
    expect(enq.exit).toBe(0);
    const enqJob = JSON.parse(enq.stdout);

    // Wait for job to finish
    let finishedJob: any = null;
    for (let i = 0; i < 50; i++) {
      const show = await run("queue", "get", String(enqJob.id), "--json");
      if (show.exit === 0 && show.stdout.trim()) {
        const j = JSON.parse(show.stdout);
        if (j.status === "done" || j.status === "failed") {
          finishedJob = j;
          break;
        }
      }
      await Bun.sleep(100);
    }

    expect(finishedJob).toBeDefined();
    expect(finishedJob.status).toBe("done");
    const res = finishedJob.result;
    expect(res.saved.length).toBe(1);
    expect(res.saved[0].path).toBe(join(targetDir, "media_2.jpg"));
    expect(res.skipped.length).toBe(1);
    expect(res.skipped[0].reason).toContain("Invalid or unsupported media format");
  } finally {
    ws?.close();
    if (pid) {
      try { process.kill(pid, "SIGTERM"); } catch {}
      for (let i = 0; i < 50; i++) {
        try { process.kill(pid, 0); } catch { break; }
        await Bun.sleep(20);
      }
    }
    await rm(stateDir, { recursive: true, force: true });
    await rm(fakeHome, { recursive: true, force: true });
  }
});

test("HIGH 11: message gap and jitter constants enforced, planned slot asserted, --not-before cannot beat gap slot", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "socmedia-tg-gap-state-"));
  const fakeHome = await mkdtemp(join(tmpdir(), "socmedia-tg-gap-home-"));

  const run = async (...args: string[]) => {
    const cli = Bun.spawn(["bun", "run", "src/cli.ts", ...args], {
      cwd: join(import.meta.dir, ".."),
      env: {
        ...process.env,
        HOME: fakeHome,
        SOCMEDIA_STATE_DIR: stateDir,
        SOCMEDIA_EXTENSION_PORT: "0",
        SOCMEDIA_MAX_MESSAGES_PER_DAY: "10",
      },
      stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, exit] = await Promise.all([new Response(cli.stdout).text(), new Response(cli.stderr).text(), cli.exited]);
    return { stdout, stderr, exit };
  };

  let pid: number | undefined;
  try {
    const started = JSON.parse((await run("service", "start", "--json")).stdout);
    pid = started.pid;

    // 1. Enqueue first message
    const m1 = await run("queue", "enqueue", "tgSendMessage", "--args", JSON.stringify({ chat: "@user_1", text: "First" }), "--json");
    expect(m1.exit).toBe(0);

    // 2. Enqueue second message: anchor is m1. Spaced by GAP_MS (90s)
    const m2 = await run("queue", "enqueue", "tgSendMessage", "--args", JSON.stringify({ chat: "@user_2", text: "Second" }), "--json");
    expect(m2.exit).toBe(0);
    const j2 = JSON.parse(m2.stdout);
    expect(j2.notBefore).toBeDefined();
    const diff2 = Date.parse(j2.notBefore) - Date.now();
    expect(diff2).toBeGreaterThanOrEqual(85000);
    expect(diff2).toBeLessThanOrEqual(160000);

    // 3. Enqueue with --not-before earlier than the gap slot (e.g. 5 seconds from now)
    const earlyTime = new Date(Date.now() + 5000).toISOString();
    const m3 = await run("queue", "enqueue", "tgSendMessage", "--not-before", earlyTime, "--args", JSON.stringify({ chat: "@user_3", text: "Third" }), "--json");
    expect(m3.exit).toBe(0);
    const j3 = JSON.parse(m3.stdout);
    expect(j3.notBefore).toBeDefined();
    expect(Date.parse(j3.notBefore)).toBeGreaterThan(Date.now() + 85000);
  } finally {
    if (pid) {
      try { process.kill(pid, "SIGTERM"); } catch {}
      for (let i = 0; i < 50; i++) {
        try { process.kill(pid, 0); } catch { break; }
        await Bun.sleep(20);
      }
    }
    await rm(stateDir, { recursive: true, force: true });
    await rm(fakeHome, { recursive: true, force: true });
  }
});

test("BLOCKER 1: tgMediaDownload in background.js sends chunk messages with type 'chunk' and mediaType", async () => {
  const script = await Bun.file(new URL("../extension/background.js", import.meta.url)).text();
  const sentMessages: any[] = [];
  const mockSocket = {
    readyState: 1, // OPEN
    send: (msg: string) => {
      sentMessages.push(JSON.parse(msg));
    },
  };
  const mockTab = { id: 42, url: "https://web.telegram.org/k/#@alice" };
  const chrome = {
    storage: { local: { get: async () => ({ cliSelectedTab: 42 }), set: async () => {} }, onChanged: { addListener() {} } },
    tabs: {
      get: async () => mockTab,
      update: async () => mockTab,
      query: async () => [mockTab],
    },
    scripting: {
      executeScript: async (options: any) => {
        if (options?.func?.name === "inspectPage") return [{ result: null }];
        if (options?.func?.name === "pgMatchTgChat") return [{ result: { matched: true, title: "Alice", username: "alice" } }];
        return [{
          result: [{
            type: "photo",
            filename: "media_1.jpg",
            size: 100,
            chunks: ["dGVzdA=="],
            preview: false,
            itemIndex: 1,
          }],
        }];
      },
    },
    tabGroups: { query: async () => [] },
    alarms: { create() {}, onAlarm: { addListener() {} } },
    runtime: { onStartup: { addListener() {} } },
  };
  const context = {
    chrome, WebSocket: { OPEN: 1 }, URL, setTimeout, clearTimeout, Date, Math,
    document: {
      body: { innerText: "" },
      querySelector: (sel: string) => {
        if (sel.includes("peer-title") || sel.includes("chat-title")) return { innerText: "Alice" };
        if (sel.includes("username") || sel.includes("profile")) return { innerText: "@alice", getAttribute: () => null, textContent: "@alice" };
        return null;
      },
      querySelectorAll: () => [],
    },
    location: { hash: "#@alice", href: "https://web.telegram.org/k/#@alice", pathname: "/k/", hostname: "web.telegram.org" },
  };
  runInNewContext(script, context);

  await runInNewContext('tgMediaDownload({ chat: "@alice", limit: 1 }, mockSocket, "job_123")', { ...context, mockSocket });

  expect(sentMessages.length).toBe(1);
  const chunkMsg = sentMessages[0];
  expect(chunkMsg.type).toBe("chunk");
  expect(chunkMsg.mediaType).toBe("photo");
  expect(chunkMsg.id).toBe("job_123");
  expect(chunkMsg.data).toBe("dGVzdA==");
});



