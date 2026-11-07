import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { createHmac, randomBytes } from "node:crypto";
import { symlinkSync, writeFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { isMediaHost } from "../src/media";
import { tiktokProfileUrl, tiktokVideoUrl, validateJob } from "../src/lib/validate";

const projectVersion = "0.20.0";

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

test("TikTok URL validation and canonicalisation", () => {
  // Profile URL
  expect(tiktokProfileUrl("https://www.tiktok.com/@creator")).toBe("https://www.tiktok.com/@creator");
  expect(tiktokProfileUrl("https://www.tiktok.com/@user.name_123")).toBe("https://www.tiktok.com/@user.name_123");

  // Hostile / invalid profile inputs
  expect(() => tiktokProfileUrl("http://www.tiktok.com/@user")).toThrow(/HTTPS/);
  expect(() => tiktokProfileUrl("https://tiktok.com.evil.com/@user")).toThrow(/www\.tiktok\.com/);
  expect(() => tiktokProfileUrl("https://user:pass@www.tiktok.com/@user")).toThrow(/HTTPS/);
  expect(() => tiktokProfileUrl("https://www.tiktok.com:8443/@user")).toThrow(/HTTPS/);
  expect(() => tiktokProfileUrl("https://www.tiktok.com/notaprofile")).toThrow(/@user/);

  // Video URL
  const vid = tiktokVideoUrl("https://www.tiktok.com/@creator/video/7123456789012345678");
  expect(vid.url).toBe("https://www.tiktok.com/@creator/video/7123456789012345678");
  expect(vid.author).toBe("creator");
  expect(vid.id).toBe("7123456789012345678");

  // Hostile / invalid video inputs
  expect(() => tiktokVideoUrl("http://www.tiktok.com/@creator/video/12345")).toThrow(/HTTPS/);
  expect(() => tiktokVideoUrl("https://www.tiktok.com/@creator/photo/12345")).toThrow(/video/);
  expect(() => tiktokVideoUrl("https://www.tiktok.com/@creator/video/notanumber")).toThrow(/video\/1234567890/);
});

test("isMediaHost recognizes valid TikTok CDN host suffixes and rejects malicious hosts", () => {
  expect(isMediaHost("v16-webapp-prime.tiktokcdn.com")).toBe(true);
  expect(isMediaHost("p16-sign.tiktokcdn-us.com")).toBe(true);
  expect(isMediaHost("sf16-ies-music.byteoversea.com")).toBe(true);
  expect(isMediaHost("v16-cold.ibytedtos.com")).toBe(true);

  // Malicious domains trying to spoof
  expect(isMediaHost("tiktokcdn.com.evil.com")).toBe(false);
  expect(isMediaHost("eviltiktokcdn.com")).toBe(false);
  expect(isMediaHost("localhost")).toBe(false);
  expect(isMediaHost("127.0.0.1")).toBe(false);
});

test("tiktok upload preview enqueues nothing into database", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "socmedia-tt-prev-"));
  const fakeHome = await mkdtemp(join(tmpdir(), "socmedia-home-"));
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
    const prev = await run("tiktok", "upload", testFile, "--caption", "Cool video", "--json");
    expect(prev.exit).toBe(0);
    const parsed = JSON.parse(prev.stdout);
    expect(parsed.uploaded).toBe(false);
    expect(parsed.preview.caption).toBe("Cool video");
    expect(parsed.preview.privacy).toBe("private");

    // Ensure database was not touched with enqueued jobs
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

test("tiktok upload rejects missing files, symlinks, and invalid formats", async () => {
  const fakeHome = await mkdtemp(join(tmpdir(), "socmedia-tt-files-"));
  const textFile = join(fakeHome, "test.txt");
  await Bun.write(textFile, "hello world this is text");
  const symlinkFile = join(fakeHome, "symlink.mp4");
  const validFile = join(fakeHome, "valid.mp4");
  createMockMp4(validFile);
  symlinkSync(validFile, symlinkFile);

  const run = async (...args: string[]) => {
    const cli = Bun.spawn(["bun", "run", "src/cli.ts", ...args], {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, HOME: fakeHome, SOCMEDIA_EXTENSION_PORT: "0" },
      stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, exit] = await Promise.all([new Response(cli.stdout).text(), new Response(cli.stderr).text(), cli.exited]);
    return { stdout, stderr, exit };
  };

  try {
    const missingRes = await run("tiktok", "upload", join(fakeHome, "missing.mp4"), "--json");
    expect(missingRes.exit).not.toBe(0);
    expect(missingRes.stderr).toContain("File not found");

    const symlinkRes = await run("tiktok", "upload", symlinkFile, "--json");
    expect(symlinkRes.exit).not.toBe(0);
    expect(symlinkRes.stderr).toContain("Symlinks are not allowed");

    const textRes = await run("tiktok", "upload", textFile, "--json");
    expect(textRes.exit).not.toBe(0);
    expect(textRes.stderr).toContain("media type is not supported");
  } finally {
    await rm(fakeHome, { recursive: true, force: true });
  }
});

test("tiktok upload enforces daily cap and duplicate sha256 within 7 days", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "socmedia-tt-limits-"));
  const fakeHome = await mkdtemp(join(tmpdir(), "socmedia-tt-home-"));
  const testFile1 = join(fakeHome, "v1.mp4");
  createMockMp4(testFile1);

  const run = async (...args: string[]) => {
    const cli = Bun.spawn(["bun", "run", "src/cli.ts", ...args], {
      cwd: join(import.meta.dir, ".."),
      env: {
        ...process.env,
        HOME: fakeHome,
        SOCMEDIA_STATE_DIR: stateDir,
        SOCMEDIA_EXTENSION_PORT: "0",
        SOCMEDIA_MAX_TIKTOK_UPLOADS_PER_DAY: "2",
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
      if (req.action === "tiktokUpload") {
        ws!.send(JSON.stringify({
          type: "result", id: req.id,
          result: { posted: true, verified: true, url: "https://www.tiktok.com/@creator/video/1111111111" },
        }));
      }
    };

    // First upload succeeds
    const up1 = await run("tiktok", "upload", testFile1, "--confirm", "--json");
    expect(up1.exit).toBe(0);
    expect(JSON.parse(up1.stdout).posted).toBe(true);

    // Duplicate sha256 within 7 days is refused
    const upDup = await run("tiktok", "upload", testFile1, "--confirm", "--json");
    expect(upDup.exit).not.toBe(0);
    expect(upDup.stderr).toContain("7-day rule");

    // Upload different file
    const testFile2 = join(fakeHome, "v2.mp4");
    const buf2 = Buffer.alloc(80);
    buf2.write("ftypisom", 4);
    buf2.write("different content", 16);
    writeFileSync(testFile2, buf2);

    const up2 = await run("tiktok", "upload", testFile2, "--confirm", "--json");
    expect(up2.exit).toBe(0);

    // Third upload hits daily cap of 2
    const testFile3 = join(fakeHome, "v3.mp4");
    const buf3 = Buffer.alloc(96);
    buf3.write("ftypisom", 4);
    buf3.write("third file content", 16);
    writeFileSync(testFile3, buf3);

    const upCap = await run("tiktok", "upload", testFile3, "--confirm", "--json");
    expect(upCap.exit).not.toBe(0);
    expect(upCap.stderr).toContain("Daily upload cap reached");
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

test("tiktokUpload side-effect job becomes unverified on disconnect and on restart", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "socmedia-tt-unv-"));
  const fakeHome = await mkdtemp(join(tmpdir(), "socmedia-tt-home2-"));
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

  let pid: number | undefined;
  let ws: WebSocket | undefined;
  try {
    const id = "h".repeat(32);
    const pairing = JSON.parse((await run("extension", "pair", "--id", id, "--json")).stdout);
    const started = JSON.parse((await run("service", "start", "--json")).stdout);
    pid = started.pid;
    ws = new WebSocket(`ws://127.0.0.1:${started.extension.port}/extension`, { headers: { Origin: `chrome-extension://${id}` } } as unknown as string[]);
    await authenticateMock(ws, pairing.token);

    // When tiktokUpload request arrives, close websocket immediately to simulate disconnect
    ws.onmessage = (event) => {
      const req = JSON.parse(String(event.data));
      if (req.action === "tiktokUpload") {
        ws!.close();
      }
    };

    const res = await run("tiktok", "upload", testFile, "--confirm", "--json");
    expect(res.exit).toBe(0);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.unverified).toBe(true);

    // Verify job in database has status unverified, NOT queued
    const db = new Database(join(stateDir, "state.sqlite"));
    const jobRow = db.query("SELECT data FROM jobs WHERE json_extract(data, '$.action') = 'tiktokUpload'").get() as { data: string };
    const jobData = JSON.parse(jobRow.data);
    expect(jobData.status).toBe("unverified");

    // Test restart: insert a running tiktokUpload job manually, simulate restart
    db.query("INSERT INTO jobs (data) VALUES (?)").run(JSON.stringify({
      action: "tiktokUpload",
      status: "running",
      args: { file: testFile, sha256: "dummy" },
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

    // Start service again
    const restarted = JSON.parse((await run("service", "start", "--json")).stdout);
    pid = restarted.pid;

    // Verify that running tiktokUpload was marked unverified, NOT queued
    const db2 = new Database(join(stateDir, "state.sqlite"));
    const rows = db2.query("SELECT data FROM jobs WHERE json_extract(data, '$.action') = 'tiktokUpload'").all() as { data: string }[];
    for (const r of rows) {
      const j = JSON.parse(r.data);
      expect(j.status).toBe("unverified");
    }
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

test("extension background.js wires all TikTok actions in ACTION_HANDLERS and detects challenges", async () => {
  const bg = await Bun.file(new URL("../extension/background.js", import.meta.url)).text();
  expect(bg).toContain('"tiktokProfile"');
  expect(bg).toContain('"tiktokPosts"');
  expect(bg).toContain('"tiktokVideo"');
  expect(bg).toContain('"tiktokComments"');
  expect(bg).toContain('"tiktokSearch"');
  expect(bg).toContain('"tiktokInbox"');
  expect(bg).toContain('"tiktokUpload"');

  // Verify HALT checks for TikTok
  expect(bg).toMatch(/tiktok\.com/);
  expect(bg).toMatch(/captcha_verify_container|tiktok-verify-ele|slider/i);
});

test("CRITICAL 2: tiktokUpload aborts without posting if privacy or caption cannot be confirmed", async () => {
  const script = await Bun.file(new URL("../extension/background.js", import.meta.url)).text();
  let clickedPost = false;
  let postDisabled = false;
  const postBtn = {
    tagName: "BUTTON",
    innerText: "Post",
    get disabled() { return postDisabled; },
    getAttribute: (attr: string) => attr === "aria-disabled" ? (postDisabled ? "true" : "false") : null,
    classList: { contains: () => false },
    click: () => { clickedPost = true; },
  };
  let captionValue = "";
  const captionEl = {
    tagName: "TEXTAREA",
    value: "",
    textContent: "",
    dispatchEvent: () => {},
  };
  let radioChecked = false;
  let hasPrivacyRadio = false;
  const privacyRadio = {
    tagName: "INPUT",
    type: "radio",
    value: "private",
    get checked() { return radioChecked; },
    getAttribute: (attr: string) => attr === "aria-checked" ? (radioChecked ? "true" : "false") : null,
    classList: { contains: (c: string) => c === "checked" && radioChecked },
    click: () => { radioChecked = true; },
  };

  const document = {
    body: { innerText: "" },
    querySelector: (sel: string) => {
      if (sel.includes("contenteditable") || sel.includes("textarea")) return captionEl;
      if (sel.includes("input[type=\"file\"]")) return { nodeId: 1 };
      if (sel.includes("upload-error")) return null;
      if (sel.includes("progress")) return null;
      return null;
    },
    querySelectorAll: (sel: string) => {
      if (sel.includes("button")) return [postBtn];
      if (sel.includes("radio")) return hasPrivacyRadio ? [privacyRadio] : [];
      return [];
    },
  };
  const location = { href: "https://www.tiktok.com/tiktokstudio/upload", pathname: "/tiktokstudio/upload", hostname: "www.tiktok.com" };
  const chrome = {
    storage: { local: { get: async () => ({ cliSelectedTab: 1 }), set: async () => {} }, onChanged: { addListener() {} } },
    tabs: { get: async () => ({ id: 1, url: location.href, status: "complete" }), update: async () => {}, query: async () => [] },
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

  // 1. Missing privacy radio -> abort without clicking post
  hasPrivacyRadio = false;
  clickedPost = false;
  const res1 = await runInNewContext('tiktokUpload({ file: "video.mp4", caption: "my caption", privacy: "private" })', context);
  expect(res1.posted).toBe(false);
  expect(clickedPost).toBe(false);

  // 2. Privacy radio present but cannot confirm checked -> abort without clicking post
  hasPrivacyRadio = true;
  privacyRadio.click = () => {}; // clicking doesn't check it
  radioChecked = false;
  clickedPost = false;
  const res2 = await runInNewContext('tiktokUpload({ file: "video.mp4", caption: "my caption", privacy: "private" })', context);
  expect(res2.posted).toBe(false);
  expect(clickedPost).toBe(false);

  // Restore radio click behavior
  privacyRadio.click = () => { radioChecked = true; };

  // 3. Caption input missing -> abort without clicking post
  document.querySelector = (sel: string) => {
    if (sel.includes("input[type=\"file\"]")) return { nodeId: 1 };
    return null;
  };
  clickedPost = false;
  const res3 = await runInNewContext('tiktokUpload({ file: "video.mp4", caption: "my caption", privacy: "private" })', context);
  expect(res3.posted).toBe(false);
  expect(clickedPost).toBe(false);
});

test("CRITICAL 2 (privacy container disambiguation): tiktokUpload picks correct radio when parent contains multiple options", async () => {
  const script = await Bun.file(new URL("../extension/background.js", import.meta.url)).text();
  let clickedPost = false;
  const postBtn = {
    tagName: "BUTTON",
    innerText: "Post",
    disabled: false,
    getAttribute: () => "false",
    classList: { contains: () => false },
    click: () => { clickedPost = true; },
  };
  const captionEl = {
    tagName: "TEXTAREA",
    value: "Some Caption",
    textContent: "Some Caption",
    dispatchEvent: () => {},
  };

  let selectedRadio = "public";
  let radioPublic: any;
  let radioFriends: any;
  let radioPrivate: any;

  const sharedParent = {
    innerText: "Everyone Friends Only you",
    querySelectorAll: (sel: string) => [radioPublic, radioFriends, radioPrivate],
  };

  radioPublic = {
    tagName: "INPUT",
    type: "radio",
    value: "1",
    parentElement: sharedParent,
    nextElementSibling: { tagName: "SPAN", innerText: "Everyone" },
    get checked() { return selectedRadio === "public"; },
    getAttribute: (attr: string) => attr === "aria-checked" ? (selectedRadio === "public" ? "true" : "false") : null,
    classList: { contains: (c: string) => c === "checked" && selectedRadio === "public" },
    click: () => { selectedRadio = "public"; },
  };
  radioFriends = {
    tagName: "INPUT",
    type: "radio",
    value: "2",
    parentElement: sharedParent,
    nextElementSibling: { tagName: "SPAN", innerText: "Friends" },
    get checked() { return selectedRadio === "friends"; },
    getAttribute: (attr: string) => attr === "aria-checked" ? (selectedRadio === "friends" ? "true" : "false") : null,
    classList: { contains: (c: string) => c === "checked" && selectedRadio === "friends" },
    click: () => { selectedRadio = "friends"; },
  };
  radioPrivate = {
    tagName: "INPUT",
    type: "radio",
    value: "3",
    parentElement: sharedParent,
    nextElementSibling: { tagName: "SPAN", innerText: "Only you" },
    get checked() { return selectedRadio === "private"; },
    getAttribute: (attr: string) => attr === "aria-checked" ? (selectedRadio === "private" ? "true" : "false") : null,
    classList: { contains: (c: string) => c === "checked" && selectedRadio === "private" },
    click: () => { selectedRadio = "private"; },
  };

  const document = {
    body: { innerText: "" },
    querySelector: (sel: string) => {
      if (sel.includes("contenteditable") || sel.includes("textarea")) return captionEl;
      if (sel.includes("input[type=\"file\"]")) return { nodeId: 1 };
      return null;
    },
    querySelectorAll: (sel: string) => {
      if (sel.includes("button")) return [postBtn];
      if (sel.includes("radio")) return [radioPublic, radioFriends, radioPrivate];
      return [];
    },
  };
  const location = { href: "https://www.tiktok.com/tiktokstudio/upload", pathname: "/tiktokstudio/upload", hostname: "www.tiktok.com" };
  const chrome = {
    storage: { local: { get: async () => ({ cliSelectedTab: 1 }), set: async () => {} }, onChanged: { addListener() {} } },
    tabs: { get: async () => ({ id: 1, url: location.href, status: "complete" }), update: async () => {}, query: async () => [] },
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

  // Upload requesting privacy = "private".
  // Even though radioPublic's parent contains "Only you", it must NOT select radioPublic.
  // It MUST select radioPrivate ("Only you")!
  const res = await runInNewContext('tiktokUpload({ file: "video.mp4", caption: "my caption", privacy: "private" })', context);
  expect(selectedRadio).toBe("private");
  expect(clickedPost).toBe(true);
});

test("CRITICAL 3: tiktokUpload verifies item is new and matches caption, refuses old video link", async () => {
  const script = await Bun.file(new URL("../extension/background.js", import.meta.url)).text();
  const existingVideoLink = "https://www.tiktok.com/@creator/video/9999999999";
  let currentPage = "https://www.tiktok.com/tiktokstudio/upload";

  const postBtn = {
    tagName: "BUTTON",
    innerText: "Post",
    disabled: false,
    getAttribute: () => "false",
    classList: { contains: () => false },
    click: () => {},
  };
  const captionEl = {
    tagName: "TEXTAREA",
    value: "Brand New Video Caption",
    textContent: "Brand New Video Caption",
    dispatchEvent: () => {},
  };
  const privacyRadio = {
    tagName: "INPUT",
    type: "radio",
    value: "private",
    checked: true,
    getAttribute: (attr: string) => attr === "aria-checked" ? "true" : null,
    classList: { contains: () => true },
    click: () => {},
  };

  const document = {
    body: { innerText: "Your video has been uploaded" },
    querySelector: (sel: string) => {
      if (sel.includes("contenteditable") || sel.includes("textarea")) return captionEl;
      if (sel.includes("input[type=\"file\"]")) return { nodeId: 1 };
      if (sel.includes("upload-error")) return null;
      if (sel.includes("progress")) return null;
      if (sel.includes("/video/")) {
        // Return existing video only (not new)
        return { tagName: "A", href: existingVideoLink, getAttribute: () => existingVideoLink, innerText: "Old Video Without Match" };
      }
      return null;
    },
    querySelectorAll: (sel: string) => {
      if (sel.includes("button")) return [postBtn];
      if (sel.includes("radio")) return [privacyRadio];
      if (sel.includes("/video/") || sel.includes("content-item")) {
        return [{
          tagName: "A",
          href: existingVideoLink,
          getAttribute: () => existingVideoLink,
          innerText: "Old Video Description",
          querySelector: () => ({ href: existingVideoLink, getAttribute: () => existingVideoLink }),
        }];
      }
      return [];
    },
  };
  const location = { href: currentPage, pathname: "/tiktokstudio/upload", hostname: "www.tiktok.com" };
  const chrome = {
    storage: { local: { get: async () => ({ cliSelectedTab: 1 }), set: async () => {} }, onChanged: { addListener() {} } },
    tabs: {
      get: async () => ({ id: 1, url: currentPage, status: "complete" }),
      update: async (_id: number, val: any) => { if (val.url) { currentPage = val.url; location.href = val.url; } },
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

  const res = await runInNewContext('tiktokUpload({ file: "video.mp4", caption: "Brand New Video Caption", privacy: "private" })', context);
  // Post succeeded (point of no return reached), but because the only video is an old one, verified must be FALSE!
  expect(res.posted).toBe(true);
  expect(res.verified).toBe(false);
});

test("CRITICAL 4: tiktokUpload returns unverified (posted: true, verified: false) on error after Post click", async () => {
  const script = await Bun.file(new URL("../extension/background.js", import.meta.url)).text();
  let clickedPost = false;
  const postBtn = {
    tagName: "BUTTON",
    innerText: "Post",
    disabled: false,
    getAttribute: () => "false",
    classList: { contains: () => false },
    click: () => { clickedPost = true; },
  };
  const captionEl = {
    tagName: "TEXTAREA",
    value: "Some Caption",
    textContent: "Some Caption",
    dispatchEvent: () => {},
  };
  const privacyRadio = {
    tagName: "INPUT",
    type: "radio",
    value: "private",
    checked: true,
    getAttribute: () => "true",
    classList: { contains: () => true },
    click: () => {},
  };

  const document = {
    body: { innerText: "" },
    querySelector: (sel: string) => {
      if (sel.includes("contenteditable") || sel.includes("textarea")) return captionEl;
      if (sel.includes("input[type=\"file\"]")) return { nodeId: 1 };
      return null;
    },
    querySelectorAll: (sel: string) => {
      if (sel.includes("button")) return [postBtn];
      if (sel.includes("radio")) return [privacyRadio];
      return [];
    },
  };
  let currentPage = "https://www.tiktok.com/tiktokstudio/upload";
  const location = { href: currentPage, pathname: "/tiktokstudio/upload", hostname: "www.tiktok.com" };
  const chrome = {
    storage: { local: { get: async () => ({ cliSelectedTab: 1 }), set: async () => {} }, onChanged: { addListener() {} } },
    tabs: {
      get: async () => ({ id: 1, url: currentPage, status: "complete" }),
      update: async (_id: number, val: any) => {
        if (clickedPost) throw new Error("Simulated network crash after Post click");
        if (val.url) { currentPage = val.url; location.href = val.url; }
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

  // When post was clicked but post-verification threw, it must NOT throw or return posted: false.
  // It must return posted: true, verified: false!
  const res = await runInNewContext('tiktokUpload({ file: "video.mp4", caption: "Some Caption", privacy: "private" })', context);
  expect(res.posted).toBe(true);
  expect(res.verified).toBe(false);
});

test("tiktok studio list validates flags and returns video items", async () => {
  const fakeHome = await mkdtemp(join(tmpdir(), "socmedia-tt-studio-"));
  const stateDir = await mkdtemp(join(tmpdir(), "socmedia-tt-studio-state-"));

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
    const badRes = await run("tiktok", "studio", "list", "--limit", "9999", "--json");
    expect(badRes.exit).not.toBe(0);
    expect(badRes.stderr).toMatch(/Limit must be an integer from 1 to 500/i);

    const unknownRes = await run("tiktok", "studio", "list", "--badflag", "--json");
    expect(unknownRes.exit).not.toBe(0);

    const id = "a".repeat(32);
    const pairing = JSON.parse((await run("extension", "pair", "--id", id, "--json")).stdout);
    const started = JSON.parse((await run("service", "start", "--json")).stdout);
    pid = started.pid;
    ws = new WebSocket(`ws://127.0.0.1:${started.extension.port}/extension`, { headers: { Origin: `chrome-extension://${id}` } } as unknown as string[]);
    await authenticateMock(ws, pairing.token);

    ws.onmessage = (event) => {
      const req = JSON.parse(String(event.data));
      if (req.action === "tiktokStudioList") {
        ws!.send(JSON.stringify({
          type: "result", id: req.id,
          result: {
            videos: [
              { id: "7703059197751037204", caption: "Video 1", privacy: "Only me", reviewStatus: "published", date: "Nov 1, 6:43 AM" },
              { id: "7703059065957518612", caption: "Video 2", privacy: "Only me", reviewStatus: "Content under review", date: null },
            ],
          },
        }));
      }
    };

    const listRes = await run("tiktok", "studio", "list", "--limit", "10", "--json");
    expect(listRes.exit).toBe(0);
    const parsed = JSON.parse(listRes.stdout);
    expect(parsed.videos).toHaveLength(2);
    expect(parsed.videos[0].id).toBe("7703059197751037204");
  } finally {
    if (ws) ws.close();
    if (pid) {
      try { process.kill(pid, "SIGTERM"); } catch {}
    }
    await rm(fakeHome, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("tiktok privacy preview without --confirm enqueues nothing and validates input", async () => {
  const fakeHome = await mkdtemp(join(tmpdir(), "socmedia-tt-priv-home-"));
  const stateDir = await mkdtemp(join(tmpdir(), "socmedia-tt-priv-state-"));

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
    // Missing VIDEO argument
    const noVideo = await run("tiktok", "privacy", "--set", "friends", "--json");
    expect(noVideo.exit).not.toBe(0);

    // Missing --set flag
    const noSet = await run("tiktok", "privacy", "7703059197751037204", "--json");
    expect(noSet.exit).not.toBe(0);

    // Invalid privacy value
    const badPriv = await run("tiktok", "privacy", "7703059197751037204", "--set", "invalid", "--json");
    expect(badPriv.exit).not.toBe(0);

    // Preview without --confirm
    const prev = await run("tiktok", "privacy", "7703059197751037204", "--set", "friends", "--json");
    expect(prev.exit).toBe(0);
    const parsed = JSON.parse(prev.stdout);
    expect(parsed.changed).toBe(false);
    expect(parsed.preview.videoId).toBe("7703059197751037204");
    expect(parsed.preview.privacy).toBe("friends");

    // Ensure database was not created or touched
    const dbPath = join(stateDir, "state.sqlite");
    const dbExists = await Bun.file(dbPath).exists();
    if (dbExists) {
      const db = new Database(dbPath);
      const jobs = db.query("SELECT COUNT(*) as count FROM jobs").get() as { count: number };
      expect(jobs.count).toBe(0);
      db.close();
    }
  } finally {
    await rm(fakeHome, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("tiktok privacy --set public is refused unless SOCMEDIA_TIKTOK_ALLOW_PUBLIC=1", async () => {
  const fakeHome = await mkdtemp(join(tmpdir(), "socmedia-tt-pub-home-"));
  const stateDir = await mkdtemp(join(tmpdir(), "socmedia-tt-pub-state-"));

  const run = async (env: Record<string, string>, ...args: string[]) => {
    const cli = Bun.spawn(["bun", "run", "src/cli.ts", ...args], {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, HOME: fakeHome, SOCMEDIA_STATE_DIR: stateDir, SOCMEDIA_EXTENSION_PORT: "0", ...env },
      stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, exit] = await Promise.all([new Response(cli.stdout).text(), new Response(cli.stderr).text(), cli.exited]);
    return { stdout, stderr, exit };
  };

  let pid: number | undefined;
  let ws: WebSocket | undefined;
  try {
    const id = "b".repeat(32);
    const pairing = JSON.parse((await run({}, "extension", "pair", "--id", id, "--json")).stdout);
    const started = JSON.parse((await run({}, "service", "start", "--json")).stdout);
    pid = started.pid;
    ws = new WebSocket(`ws://127.0.0.1:${started.extension.port}/extension`, { headers: { Origin: `chrome-extension://${id}` } } as unknown as string[]);
    await authenticateMock(ws, pairing.token);

    // Refused by default (SOCMEDIA_TIKTOK_ALLOW_PUBLIC not set)
    const pubRefused = await run({}, "tiktok", "privacy", "7703059197751037204", "--set", "public", "--confirm", "--json");
    expect(pubRefused.exit).not.toBe(0);
    expect(pubRefused.stderr).toMatch(/public.*restricted|SOCMEDIA_TIKTOK_ALLOW_PUBLIC=1/i);
  } finally {
    if (ws) ws.close();
    if (pid) {
      try { process.kill(pid, "SIGTERM"); } catch {}
    }
    await rm(fakeHome, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("tiktok privacy enforces daily cap and duplicate queued checks", async () => {
  const fakeHome = await mkdtemp(join(tmpdir(), "socmedia-tt-cap-home-"));
  const stateDir = await mkdtemp(join(tmpdir(), "socmedia-tt-cap-state-"));

  const run = async (...args: string[]) => {
    const cli = Bun.spawn(["bun", "run", "src/cli.ts", ...args], {
      cwd: join(import.meta.dir, ".."),
      env: {
        ...process.env,
        HOME: fakeHome,
        SOCMEDIA_STATE_DIR: stateDir,
        SOCMEDIA_EXTENSION_PORT: "0",
        SOCMEDIA_MAX_TIKTOK_PRIVACY_PER_DAY: "2",
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

    ws.onmessage = (event) => {
      const req = JSON.parse(String(event.data));
      if (req.action === "tiktokSetPrivacy") {
        ws!.send(JSON.stringify({
          type: "result", id: req.id,
          result: { videoId: req.args.videoId, changed: true, verified: true, privacy: req.args.privacy },
        }));
      }
    };

    // 1st succeeds
    const res1 = await run("tiktok", "privacy", "7703059197751037201", "--set", "friends", "--confirm", "--json");
    expect(res1.exit).toBe(0);

    // 2nd succeeds
    const res2 = await run("tiktok", "privacy", "7703059197751037202", "--set", "friends", "--confirm", "--json");
    expect(res2.exit).toBe(0);

    // 3rd reaches daily cap of 2
    const res3 = await run("tiktok", "privacy", "7703059197751037203", "--set", "friends", "--confirm", "--json");
    expect(res3.exit).not.toBe(0);
    expect(res3.stderr).toMatch(/Daily privacy change cap reached/i);
  } finally {
    if (ws) ws.close();
    if (pid) {
      try { process.kill(pid, "SIGTERM"); } catch {}
    }
    await rm(fakeHome, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("extension background.js tiktokStudioList extracts video items from content table", async () => {
  const script = await Bun.file(new URL("../extension/background.js", import.meta.url)).text();

  const mockRows = [
    {
      tagName: "DIV",
      className: "table-row",
      querySelector: (sel: string) => {
        if (sel.includes("a[href*='/video/']")) return { href: "https://www.tiktok.com/@creator/video/1111111111", tagName: "A" };
        if (sel.includes("Only me") || sel.includes("button")) return { tagName: "BUTTON", innerText: "Only me" };
        return null;
      },
      querySelectorAll: () => [],
      innerText: "00:50\nFirst video caption #test\nNov 1, 6:43 AM\nOnly me\n0\n0\n0",
      parentElement: null,
    },
    {
      tagName: "DIV",
      className: "table-row",
      querySelector: (sel: string) => {
        if (sel.includes("a[href*='/video/']")) return { href: "https://www.tiktok.com/@creator/video/2222222222", tagName: "A" };
        if (sel.includes("Friends") || sel.includes("button")) return { tagName: "BUTTON", innerText: "Friends" };
        return null;
      },
      querySelectorAll: () => [],
      innerText: "00:45\nSecond video caption\nContent under review\nFriends\n0\n0\n0",
      parentElement: null,
    },
  ];

  const fakeContainer: any = {
    scrollHeight: 1000,
    clientHeight: 500,
    scrollTop: 0,
    dispatchEvent: () => true,
    parentElement: null,
  };
  mockRows[0].parentElement = fakeContainer;
  mockRows[1].parentElement = fakeContainer;

  const document: any = {
    body: { innerText: "Content Studio" },
    querySelector: (sel: string) => {
      if (sel.includes("a[href*='/video/']")) return mockRows[0].querySelector("a[href*='/video/']");
      return null;
    },
    querySelectorAll: (sel: string) => {
      if (sel === "iframe") return [];
      if (sel.includes("video") || sel.includes("item") || sel.includes("tr") || sel.includes("row")) {
        return mockRows;
      }
      return [];
    },
  };

  const chrome: any = {
    storage: { local: { get: async () => ({ cliSelectedTab: 1 }), set: async () => {} }, onChanged: { addListener() {} } },
    tabs: {
      get: async () => ({ id: 1, url: "https://www.tiktok.com/tiktokstudio/content", status: "complete" }),
      update: async () => {},
      query: async () => [{ id: 1, url: "https://www.tiktok.com/tiktokstudio/content" }],
    },
    windows: { get: async () => ({ id: 1, state: "normal" }), create: async () => ({ id: 1 }) },
    tabGroups: { query: async () => [{ id: 10, title: "Socmedia CLI" }] },
    alarms: { create() {}, onAlarm: { addListener() {} } },
    runtime: { onStartup: { addListener() {} } },
    scripting: {
      executeScript: async (options: any) => [{ result: await options.func(...(options.args || [])) }],
    },
  };

  let virtualNow = 100000;
  const context: any = {
    chrome, document, location: { href: "https://www.tiktok.com/tiktokstudio/content", pathname: "/tiktokstudio/content", hostname: "www.tiktok.com" },
    URL, Event, setTimeout: (fn: any) => { fn(); return 0; }, clearTimeout,
    Date: { now: () => { virtualNow += 5000; return virtualNow; } }, Math,
    getComputedStyle: () => ({ overflowY: "auto" }),
  };
  runInNewContext(script, context);

  const res = await runInNewContext('tiktokStudioList({ limit: 10 })', context);
  expect(res.videos).toHaveLength(2);
  expect(res.videos[0].id).toBe("1111111111");
  expect(res.videos[0].privacy).toBe("Only me");
  expect(res.videos[1].reviewStatus).toBe("Content under review");
});

test("tiktokStudioList extracts privacy and date when a is nested in DivItem within arco-table-tr", async () => {
  const script = await Bun.file(new URL("../extension/background.js", import.meta.url)).text();

  const mockRow: any = {
    tagName: "TR",
    className: "arco-table-tr",
    innerText: "Episode 23\nNov 1, 2026, 6:43 AM\nЛише я\n0\n0",
    parentElement: null,
    querySelectorAll: (sel: string) => [],
  };

  const innerDiv: any = {
    tagName: "DIV",
    className: "DivItemMedia",
    parentElement: mockRow,
    closest: (sel: string) => {
      if (sel.includes("arco-table-tr") || sel.includes("tr")) return mockRow;
      if (sel.includes("DivItem")) return innerDiv;
      return null;
    },
  };

  const linkEl: any = {
    tagName: "A",
    href: "https://www.tiktok.com/@creator/video/7703059197751037209",
    innerText: "Episode 23",
    parentElement: innerDiv,
    closest: (sel: string) => {
      if (sel.includes("arco-table-tr") || sel.includes("tr")) return mockRow;
      if (sel.includes("DivItem")) return innerDiv;
      return null;
    },
  };

  innerDiv.querySelector = (sel: string) => (sel.includes("/video/") ? linkEl : null);
  mockRow.querySelector = (sel: string) => (sel.includes("/video/") ? linkEl : null);

  const document: any = {
    body: { innerText: "" },
    querySelectorAll: (sel: string) => {
      if (sel.includes("video") || sel.includes("arco-table-tr")) return [linkEl];
      return [];
    },
    querySelector: () => null,
  };

  const chrome: any = {
    storage: { local: { get: async () => ({ cliSelectedTab: 1 }), set: async () => {} }, onChanged: { addListener() {} } },
    tabs: {
      get: async () => ({ id: 1, url: "https://www.tiktok.com/tiktokstudio/content", status: "complete" }),
      update: async () => {},
      query: async () => [{ id: 1, url: "https://www.tiktok.com/tiktokstudio/content" }],
    },
    windows: { get: async () => ({ id: 1, state: "normal" }), create: async () => ({ id: 1 }) },
    tabGroups: { query: async () => [{ id: 10, title: "Socmedia CLI" }] },
    alarms: { create() {}, onAlarm: { addListener() {} } },
    runtime: { onStartup: { addListener() {} } },
    scripting: {
      executeScript: async (options: any) => [{ result: await options.func(...(options.args || [])) }],
    },
  };

  const context: any = {
    chrome, document, location: { href: "https://www.tiktok.com/tiktokstudio/content", pathname: "/tiktokstudio/content", hostname: "www.tiktok.com" },
    URL, Event, setTimeout: (fn: any) => { fn(); return 0; }, clearTimeout,
    Date: { now: () => 100000 }, Math,
    getComputedStyle: () => ({ overflowY: "auto" }),
  };
  runInNewContext(script, context);

  const res = await runInNewContext("tiktokStudioList({ limit: 5 })", context);
  expect(res.videos).toHaveLength(1);
  expect(res.videos[0].id).toBe("7703059197751037209");
  expect(res.videos[0].privacy).toBe("Only me");
  expect(res.videos[0].date).toBe("Nov 1, 2026, 6:43 AM");
});

test("extension background.js tiktokSetPrivacy changes privacy and returns unverified on failure", async () => {
  const script = await Bun.file(new URL("../extension/background.js", import.meta.url)).text();

  let privacyText = "Only me";
  let optionClicked = false;
  let clickedPrivacyBtn = false;

  const mockPrivacyBtn: any = {
    tagName: "BUTTON",
    innerText: "Only me",
    click: () => { clickedPrivacyBtn = true; },
    querySelectorAll: () => [],
  };

  const mockOption: any = {
    tagName: "DIV",
    innerText: "Friends",
    click: () => {
      optionClicked = true;
      privacyText = "Friends";
      mockPrivacyBtn.innerText = "Friends";
    },
  };

  const mockRow: any = {
    querySelector: (sel: string) => {
      if (sel.includes("a[href*='/video/']")) return { href: "https://www.tiktok.com/@creator/video/1111111111" };
      if (sel.includes("button") || sel.includes("Only me") || sel.includes("Friends")) return mockPrivacyBtn;
      return null;
    },
    querySelectorAll: (sel: string) => {
      if (sel.includes("button")) return [mockPrivacyBtn];
      return [];
    },
    get innerText() {
      return `First video\n${privacyText}`;
    },
  };

  const mockVideoLink: any = {
    tagName: "A",
    href: "https://www.tiktok.com/@creator/video/1111111111",
    closest: () => mockRow,
    parentElement: mockRow,
  };

  const document: any = {
    body: { innerText: "TikTok Studio" },
    querySelector: (sel: string) => {
      if (sel.includes("1111111111")) return mockVideoLink;
      return null;
    },
    querySelectorAll: (sel: string) => {
      if (sel === "iframe") return [];
      if (sel.includes("Friends") || sel.includes("option") || sel.includes("item") || sel.includes("menu")) {
        return [mockOption];
      }
      if (sel.includes("a[href*='/video/']")) {
        return [mockVideoLink];
      }
      return [mockRow];
    },
  };

  const chrome: any = {
    storage: { local: { get: async () => ({ cliSelectedTab: 1 }), set: async () => {} }, onChanged: { addListener() {} } },
    tabs: {
      get: async () => ({ id: 1, url: "https://www.tiktok.com/tiktokstudio/content", status: "complete" }),
      update: async () => {},
      query: async () => [{ id: 1, url: "https://www.tiktok.com/tiktokstudio/content" }],
    },
    windows: { get: async () => ({ id: 1, state: "normal" }), create: async () => ({ id: 1 }) },
    tabGroups: { query: async () => [{ id: 10, title: "Socmedia CLI" }] },
    alarms: { create() {}, onAlarm: { addListener() {} } },
    runtime: { onStartup: { addListener() {} } },
    scripting: {
      executeScript: async (options: any) => [{ result: await options.func(...(options.args || [])) }],
    },
  };

  let virtualNow = 100000;
  const context: any = {
    chrome, document, location: { href: "https://www.tiktok.com/tiktokstudio/content", pathname: "/tiktokstudio/content", hostname: "www.tiktok.com" },
    URL, Event, setTimeout: (fn: any) => { fn(); return 0; }, clearTimeout,
    Date: { now: () => { virtualNow += 5000; return virtualNow; } }, Math,
    getComputedStyle: () => ({ overflowY: "auto" }),
  };
  runInNewContext(script, context);

  // 1. Changing to same privacy is a no-op:
  const noop = await runInNewContext('tiktokSetPrivacy({ videoId: "1111111111", privacy: "private" })', context);
  expect(noop.changed).toBe(false);
  expect(clickedPrivacyBtn).toBe(false);

  // 2. Changing to friends:
  const changed = await runInNewContext('tiktokSetPrivacy({ videoId: "1111111111", privacy: "friends" })', context);
  expect(changed.changed).toBe(true);
  expect(changed.verified).toBe(true);
  expect(optionClicked).toBe(true);

  // 3. Prefix/substring ID must not match longer ID:
  const prefixMatch = await runInNewContext('tiktokSetPrivacy({ videoId: "11111", privacy: "friends" })', context);
  expect(prefixMatch.changed).toBe(false);
  expect(prefixMatch.verified).toBe(false);
  expect(prefixMatch.error).toContain("not found");
});

function studioContext(script: string, rowText: string, buttons: any[], options: any[]) {
  const link: any = { tagName: "A", href: "https://www.tiktok.com/@creator/video/1111111111", parentElement: null };
  const row: any = {
    tagName: "DIV",
    innerText: rowText,
    querySelector: (sel: string) => (sel.includes("/video/") ? link : null),
    querySelectorAll: (sel: string) => (sel.includes("button") ? buttons : []),
  };
  link.closest = () => row;
  const document: any = {
    body: { innerText: "TikTok Studio", dispatchEvent: () => true },
    querySelector: () => null,
    querySelectorAll: (sel: string) => {
      if (sel === "iframe") return [];
      if (sel === "a[href*='/video/']") return [link];
      if (sel.includes("[role='option']")) return options;
      return [row];
    },
  };
  const tab = { id: 1, url: "https://www.tiktok.com/tiktokstudio/content", status: "complete" };
  const chrome: any = {
    storage: { local: { get: async () => ({ cliSelectedTab: 1 }), set: async () => {} }, onChanged: { addListener() {} } },
    tabs: { get: async () => tab, update: async () => {}, query: async () => [tab] },
    windows: { get: async () => ({ id: 1, state: "normal" }), create: async () => ({ id: 1 }) },
    tabGroups: { query: async () => [{ id: 10, title: "Socmedia CLI" }] },
    alarms: { create() {}, onAlarm: { addListener() {} } },
    runtime: { onStartup: { addListener() {} } },
    scripting: { executeScript: async (o: any) => [{ result: await o.func(...(o.args || [])) }] },
  };
  let virtualNow = 100000;
  const context: any = {
    chrome, document, location: { href: tab.url, pathname: "/tiktokstudio/content", hostname: "www.tiktok.com" },
    URL, Event, setTimeout: (fn: any) => { fn(); return 0; }, clearTimeout,
    Date: { now: () => { virtualNow += 5000; return virtualNow; } }, Math,
    getComputedStyle: () => ({ overflowY: "auto" }),
  };
  runInNewContext(script, context);
  return context;
}

const setPrivacy = (context: any, privacy: string) =>
  runInNewContext(`tiktokSetPrivacy({ videoId: "1111111111", privacy: "${privacy}" })`, context);

test("tiktokSetPrivacy aborts when current privacy cannot be read, and never reports it as a no-op", async () => {
  const script = await Bun.file(new URL("../extension/background.js", import.meta.url)).text();
  let clicked = 0;
  const button = { innerText: "Edit", click: () => { clicked++; } };

  for (const privacy of ["private", "friends"]) {
    const res = await setPrivacy(studioContext(script, "First video\n00:50", [button], []), privacy);
    expect(res.changed).toBe(false);
    expect(res.error).toContain("privacy");
  }
  expect(clicked).toBe(0);
});

test("tiktokSetPrivacy refuses a row with conflicting privacy labels, e.g. a caption reading Friends", async () => {
  const script = await Bun.file(new URL("../extension/background.js", import.meta.url)).text();
  let clicked = 0;
  const button = { innerText: "Only me", click: () => { clicked++; } };

  const res = await setPrivacy(studioContext(script, "Friends\nOnly me", [button], []), "friends");
  expect(res.changed).toBe(false);
  expect(res.error).toContain("privacy");
  expect(clicked).toBe(0);
});

test("tiktokSetPrivacy never falls back to an arbitrary row button", async () => {
  const script = await Bun.file(new URL("../extension/background.js", import.meta.url)).text();
  let clicked = 0;
  const button = { innerText: "Delete", click: () => { clicked++; } };

  const res = await setPrivacy(studioContext(script, "First video\nOnly me", [button], []), "friends");
  expect(res.changed).toBe(false);
  expect(clicked).toBe(0);
});

test("tiktokSetPrivacy selects only one exact option and fails closed otherwise", async () => {
  const script = await Bun.file(new URL("../extension/background.js", import.meta.url)).text();
  const button = { innerText: "Only me", click() {} };
  const option = (innerText: string, onClick: () => void) => ({ innerText, click: onClick });
  let clicked = 0;
  const hit = () => { clicked++; };

  const loose = await setPrivacy(studioContext(script, "First video\nOnly me", [button], [option("Friends of friends", hit)]), "friends");
  expect(loose.changed).toBe(false);

  const twice = await setPrivacy(studioContext(script, "First video\nOnly me", [button], [option("Friends", hit), option("Friends", hit)]), "friends");
  expect(twice.changed).toBe(false);
  expect(clicked).toBe(0);
});

test("tiktokSetPrivacy read-back does not accept a caption that merely starts with the label", async () => {
  const script = await Bun.file(new URL("../extension/background.js", import.meta.url)).text();
  const button = { innerText: "Only me", click() {} };
  const context = studioContext(script, "Friends forever\nOnly me", [button], [{ innerText: "Friends", click() {} }]);

  const res = await setPrivacy(context, "friends");
  expect(res.changed).toBe(true);
  expect(res.verified).toBe(false);
});

test("tiktokStudioList returns null privacy when the row shows no privacy label", async () => {
  const script = await Bun.file(new URL("../extension/background.js", import.meta.url)).text();
  const context = studioContext(script, "First video\n00:50", [], []);

  const res = await runInNewContext("tiktokStudioList({ limit: 1 })", context);
  expect(res.videos).toHaveLength(1);
  expect(res.videos[0].privacy).toBe(null);
});

test("tiktok privacy --set public previews without the variable in the CLI env; the service owns the refusal", async () => {
  const fakeHome = await mkdtemp(join(tmpdir(), "socmedia-tt-pubprev-home-"));
  const stateDir = await mkdtemp(join(tmpdir(), "socmedia-tt-pubprev-state-"));
  try {
    const cli = Bun.spawn(["bun", "run", "src/cli.ts", "tiktok", "privacy", "7703059197751037204", "--set", "public", "--json"], {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, HOME: fakeHome, SOCMEDIA_STATE_DIR: stateDir, SOCMEDIA_EXTENSION_PORT: "0", SOCMEDIA_TIKTOK_ALLOW_PUBLIC: "" },
      stdout: "pipe", stderr: "pipe",
    });
    const [stdout, exit] = await Promise.all([new Response(cli.stdout).text(), cli.exited]);
    expect(exit).toBe(0);
    expect(JSON.parse(stdout).changed).toBe(false);
  } finally {
    await rm(fakeHome, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  }
});

// ---- --schedule (TikTok Studio native scheduler, Europe/Kyiv wall clock) ----
import { parseKyivSchedule, SCHEDULE_MIN_MINUTES, SCHEDULE_MAX_DAYS } from "../src/lib/validate";

const kyivStamp = (ms: number) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Kyiv", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
};

test("parseKyivSchedule validates format, Kyiv clock and the 20 min..10 day window", () => {
  const now = Date.UTC(2026, 10, 3, 10, 0); // 2026-11-03 12:00 in Kyiv (EET, UTC+2)
  expect(SCHEDULE_MIN_MINUTES).toBe(20);
  expect(SCHEDULE_MAX_DAYS).toBe(10);
  const ok = parseKyivSchedule("2026-11-04 18:30", now);
  expect(ok).toEqual({ date: "2026-11-04", time: "18:30", at: Date.UTC(2026, 10, 4, 16, 30) });
  // DST: 2026-07-01 is EEST (UTC+3)
  expect(parseKyivSchedule("2026-07-01 12:00", Date.UTC(2026, 5, 30, 0, 0)).at).toBe(Date.UTC(2026, 6, 1, 9, 0));
  for (const bad of ["2026-11-04", "2026-11-04T18:30", "2026-11-04 18:30:00", "04.11.2026 18:30", "2026-13-01 10:00", "2026-02-30 10:00", "2026-11-04 24:00", "2026-11-04 18:61", ""]) {
    expect(() => parseKyivSchedule(bad, now)).toThrow(/YYYY-MM-DD HH:MM/);
  }
  expect(() => parseKyivSchedule("2026-11-03 12:10", now)).toThrow(/at least 20 minutes/);
  expect(() => parseKyivSchedule("2026-11-03 11:00", now)).toThrow(/at least 20 minutes/);
  expect(parseKyivSchedule("2026-11-03 12:20", now).time).toBe("12:20");
  expect(() => parseKyivSchedule("2026-11-13 12:01", now)).toThrow(/at most 10 days/);
  expect(parseKyivSchedule("2026-11-13 12:00", now).time).toBe("12:00");
  // 2026-03-29 03:30 does not exist in Kyiv (clocks jump 03:00 -> 04:00)
  expect(() => parseKyivSchedule("2026-03-29 03:30", Date.UTC(2026, 2, 28, 0, 0))).toThrow(/does not exist/);
});

test("tiktok upload --schedule previews Kyiv time, needs public, and rejects out-of-window or malformed values", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "socmedia-tt-sched-"));
  const fakeHome = await mkdtemp(join(tmpdir(), "socmedia-home-"));
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
    const when = kyivStamp(Date.now() + 2 * 24 * 3600 * 1000);
    const prev = await run("tiktok", "upload", testFile, "--caption", "c", "--schedule", when, "--json");
    expect(prev.exit).toBe(0);
    const parsed = JSON.parse(prev.stdout);
    expect(parsed.uploaded).toBe(false);
    expect(parsed.preview.schedule).toBe(when);
    expect(parsed.preview.timezone).toBe("Europe/Kyiv");
    expect(parsed.preview.privacy).toBe("public"); // scheduling implies public
    expect(parsed.note).toContain("Nothing uploaded");

    const priv = await run("tiktok", "upload", testFile, "--privacy", "private", "--schedule", when, "--json");
    expect(JSON.parse(priv.stderr).error).toMatch(/public/);
    const past = await run("tiktok", "upload", testFile, "--schedule", "2020-01-01 10:00", "--json");
    expect(JSON.parse(past.stderr).error).toMatch(/at least 20 minutes/);
    const far = await run("tiktok", "upload", testFile, "--schedule", kyivStamp(Date.now() + 30 * 24 * 3600 * 1000), "--json");
    expect(JSON.parse(far.stderr).error).toMatch(/at most 10 days/);
    const bad = await run("tiktok", "upload", testFile, "--schedule", "tomorrow", "--json");
    expect(JSON.parse(bad.stderr).error).toMatch(/YYYY-MM-DD HH:MM/);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
    await rm(fakeHome, { recursive: true, force: true });
  }
});

test("validateJob tiktokUpload accepts a valid schedule only with public privacy and rejects others", async () => {
  const oldHome = process.env.HOME;
  const home = await mkdtemp(join(tmpdir(), "socmedia-vj-"));
  process.env.HOME = home;
  try {
    const f = createMockMp4(join(home, "a.mp4"));
    const fut = kyivStamp(Date.now() + 2 * 24 * 3600 * 1000);
    const mk = (args: any) => ({ action: "tiktokUpload", args: { file: f, ...args } }) as any;
    expect(() => validateJob(mk({ privacy: "public", schedule: fut }))).not.toThrow();
    expect(() => validateJob(mk({ privacy: "private", schedule: fut }))).toThrow(/public/);
    expect(() => validateJob(mk({ privacy: "public", schedule: "2020-01-01 10:00" }))).toThrow(/at least 20 minutes/);
    expect(() => validateJob(mk({ privacy: "public", schedule: 5 }))).toThrow(/schedule/);
  } finally {
    process.env.HOME = oldHome;
    await rm(home, { recursive: true, force: true });
  }
});

test("tiktokUpload in the extension refuses a non-public schedule and wires the Schedule button", async () => {
  const script = await Bun.file(new URL("../extension/background.js", import.meta.url)).text();
  expect(script).toContain("async function pgSetupSchedule");
  expect(script).toContain("schedule = null");
  expect(script).toMatch(/Schedule\$\/i/);
  expect(script).toContain("Europe/Kyiv");
});

test("tiktokSetPrivacy queries the live Studio option element (span components_Select_TUXText)", async () => {
  const script = await Bun.file(new URL("../extension/background.js", import.meta.url)).text();
  const button = { innerText: "Only me", click() {} };
  let clicked = 0;
  const context = studioContext(script, "First video\nOnly me", [button], [{ innerText: "Everyone", click() { clicked++; } }]);
  const seen: string[] = [];
  const orig = context.document.querySelectorAll;
  context.document.querySelectorAll = (sel: string) => { seen.push(sel); return orig(sel); };
  const res = await setPrivacy(context, "public");
  expect(seen.some((s) => s.includes("[data-tt='components_Select_TUXText']"))).toBe(true);
  expect(clicked).toBe(1);
  expect(res.changed).toBe(true);
});

test("tiktokSetPrivacy scrolls half a viewport at a time so virtualized rows are not skipped", async () => {
  const script = await Bun.file(new URL("../extension/background.js", import.meta.url)).text();
  const button = { innerText: "Only me", click() {} };
  let clicked = 0;
  const context = studioContext(script, "First video\nOnly me", [button], [{ innerText: "Friends", click() { clicked++; } }]);
  const body = context.document.body;
  body.scrollHeight = 5000; body.clientHeight = 400; body.scrollTop = 0; body.parentElement = null;
  context.document.scrollingElement = body;
  const orig = context.document.querySelectorAll;
  // the row is mounted only while the viewport is exactly at 400 (a 600px step would jump from 0 to 600 and miss it)
  context.document.querySelectorAll = (sel: string) => (sel === "a[href*='/video/']" && body.scrollTop !== 400 ? [] : orig(sel));
  const res = await setPrivacy(context, "friends");
  expect(body.scrollTop).toBe(400);
  expect(res.changed).toBe(true);
  expect(clicked).toBe(1);
});
