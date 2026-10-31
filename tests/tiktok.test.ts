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
