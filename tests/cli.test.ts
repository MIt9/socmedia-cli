import { expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { runInNewContext } from "node:vm";
import { createHash, createHmac, randomBytes, webcrypto } from "node:crypto";
import packageInfo from "../package.json";
import manifest from "../extension/manifest.json";
import { Database } from "bun:sqlite";

const projectVersion = packageInfo.version;

test("Instagram comments use real extension extraction and trusted expansion with HALT checks", async () => {
  const script = await Bun.file(new URL("../extension/background.js", import.meta.url)).text();
  const stored: Record<string, unknown> = { cliSelectedTab: 42 };
  const tab = { id: 42, windowId: 4, active: true, status: "complete", url: "https://www.instagram.com/previous/" };
  const location = { href: tab.url, pathname: "/previous/", hostname: "www.instagram.com" };
  let expanded = false;
  const inputs: string[] = [];
  const button = { innerText: "View more comments", getAttribute: () => null, scrollIntoView: () => {}, getBoundingClientRect: () => ({ left: 100, top: 100, width: 100, height: 30 }) };
  const time: any = { innerText: "2d", getAttribute: () => "2026-01-01T00:00:00Z" };
  const item = { innerText: "person\n2d\nHello there\n2 likes\nReply", parentElement: null, querySelectorAll: () => [time], querySelector: () => ({ innerText: "person", href: "https://www.instagram.com/person/" }) };
  time.parentElement = item;
  const document = { body: { innerText: "" }, querySelector: () => null, querySelectorAll: (selector: string) => selector === "time[datetime]" ? [time] : selector === "button, [role=button], a[role=button]" && !expanded ? [button] : [] };
  const ignore = { addListener() {} };
  const chrome = {
    storage: { local: { get: async (keys: string | string[]) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, stored[key]])), set: async (values: Record<string, unknown>) => Object.assign(stored, values) }, onChanged: ignore },
    tabs: { get: async () => tab, query: async () => [], update: async (_id: number, values: { url?: string }) => { if (values.url) { tab.url = values.url; location.href = values.url; location.pathname = new URL(values.url).pathname; } } },
    tabGroups: { query: async () => [] }, windows: { get: async () => ({ state: "normal" }) },
    scripting: { executeScript: async ({ func, args = [] }: any) => [{ result: func(...args) }] },
    debugger: { attach: async () => {}, detach: async () => {}, sendCommand: async (_target: unknown, _method: string, params: { type: string }) => { inputs.push(params.type); if (params.type === "mouseReleased") expanded = true; } },
    alarms: { create() {}, onAlarm: ignore }, runtime: { onStartup: ignore },
  };
  const context = { chrome, WebSocket, console, URL, document, location, setTimeout: (fn: () => void, ms?: number) => { if ((ms ?? 0) < 10000) { fn(); return 0; } return setTimeout(fn, ms); }, clearTimeout: (id: any) => clearTimeout(id), Date, Math, resetExpanded: () => { expanded = false; } };
  runInNewContext(script, context);
  const result = await runInNewContext('getComments({url:"https://www.instagram.com/p/Cx_123/",limit:1})', context);
  expect(result).toEqual({ platform: "ig", url: "https://www.instagram.com/p/Cx_123/", comments: [{ author: "person", authorUrl: "https://www.instagram.com/person/", text: "Hello there", date: "2026-01-01T00:00:00Z", likes: 2 }] });
  expect(inputs).toContain("mousePressed"); expect(inputs).toContain("mouseReleased");
  tab.url = "https://www.instagram.com/checkpoint/";
  await expect(runInNewContext('getComments({url:"https://www.instagram.com/p/Cx_123/"})', context)).rejects.toMatchObject({ code: "HALT" });
  tab.url = "https://www.instagram.com/p/Cx_123/";
  await expect(runInNewContext('getComments({url:"https://www.instagram.com/p/Cx_123/",limit:0})', context)).rejects.toThrow("Comment limit must be an integer from 1 to 500");
  await expect(runInNewContext('getComments({url:"https://www.instagram.com/p/Cx_123/",limit:501})', context)).rejects.toThrow("Comment limit must be an integer from 1 to 500");
  context.resetExpanded();
  chrome.windows.get = async () => ({ state: "minimized" });
  await expect(runInNewContext('getComments({url:"https://www.instagram.com/p/Cx_123/",limit:1})', context)).rejects.toThrow("Restore the work window before expanding comments");
  chrome.windows.get = async () => ({ state: "normal" });
  tab.url = "https://www.instagram.com/p/PreviousPost/";
  chrome.tabs.update = async () => { tab.url = "https://www.instagram.com/p/DifferentPost/"; location.href = tab.url; location.pathname = "/p/DifferentPost/"; };
  await expect(runInNewContext('getComments({url:"https://www.instagram.com/p/Cx_123/",limit:1})', context)).rejects.toThrow("different Instagram post");
});

test("Facebook comments use real extension extraction with HALT checks", async () => {
  const script = await Bun.file(new URL("../extension/background.js", import.meta.url)).text();
  const stored: Record<string, unknown> = { cliSelectedTab: 42 };
  const tab = { id: 42, windowId: 4, active: true, status: "complete", url: "https://www.facebook.com/previous/" };
  const location = { href: tab.url, pathname: "/previous/", hostname: "www.facebook.com" };
  const replyArticle: any = {
    getAttribute: (name: string) => name === "aria-label" ? "Reply by Alice to Bob's comment 1 hour ago" : null,
    innerText: "Alice\n·\n1h\n·\nFollow\nNested reply\nLike\nReply",
    querySelectorAll: () => [],
    querySelector: () => null,
  };
  const authorLink = { innerText: "Bob", href: "https://www.facebook.com/bob?id=123&ref=ts" };
  const mainArticle = {
    getAttribute: (name: string) => name === "aria-label" ? "Comment by Bob 2 hours ago" : null,
    innerText: "Bob\n·\n2h\n·\nFollow\nGreat post!\nNested reply\nLike\nReply\n5",
    querySelectorAll: (selector: string) => selector === "[role=article]" ? [replyArticle] : selector === "a[href]" ? [authorLink] : [],
    querySelector: (selector: string) => selector === "a[href]" ? authorLink : null,
  };
  const document = { body: { innerText: "" }, querySelector: () => null, querySelectorAll: (selector: string) => selector === "[role=article][aria-label]" ? [mainArticle, replyArticle] : [] };
  const ignore = { addListener() {} };
  const chrome = {
    storage: { local: { get: async (keys: string | string[]) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, stored[key]])), set: async (values: Record<string, unknown>) => Object.assign(stored, values) }, onChanged: ignore },
    tabs: { get: async () => tab, query: async () => [], update: async (_id: number, values: { url?: string }) => { if (values.url) { tab.url = values.url; location.href = values.url; location.pathname = new URL(values.url).pathname; } } },
    tabGroups: { query: async () => [] }, windows: { get: async () => ({ state: "normal" }) },
    scripting: { executeScript: async ({ func, args = [] }: any) => [{ result: func(...args) }] },
    debugger: { attach: async () => {}, detach: async () => {}, sendCommand: async () => {} },
    alarms: { create() {}, onAlarm: ignore }, runtime: { onStartup: ignore },
  };
  const context = { chrome, WebSocket, console, URL, document, location, setTimeout: (fn: () => void, ms?: number) => { if ((ms ?? 0) < 10000) { fn(); return 0; } return setTimeout(fn, ms); }, clearTimeout: (id: any) => clearTimeout(id), Date, Math, resetExpanded: () => {} };
  runInNewContext(script, context);
  const result = await runInNewContext('getComments({url:"https://www.facebook.com/samplepage/posts/123456789",limit:2})', context);
  expect(result).toEqual({
    platform: "fb",
    url: "https://www.facebook.com/samplepage/posts/123456789/",
    comments: [
      { author: "Bob", authorUrl: "https://www.facebook.com/bob?id=123", text: "Great post!", date: "2 hours ago", likes: 5 },
      { author: "Alice", authorUrl: null, text: "Nested reply", date: "1 hour ago", likes: 0 },
    ],
  });
  tab.url = "https://www.facebook.com/checkpoint/";
  await expect(runInNewContext('getComments({url:"https://www.facebook.com/samplepage/posts/123456789"})', context)).rejects.toMatchObject({ code: "HALT" });
});

test("post comments validates Instagram and Facebook URLs and limit and returns queued result", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "socmedia-comments-"));
  const run = async (...args: string[]) => {
    const cli = Bun.spawn(["bun", "run", "src/cli.ts", ...args], { cwd: import.meta.dir + "/..", env: { ...process.env, SOCMEDIA_STATE_DIR: stateDir, SOCMEDIA_EXTENSION_PORT: "0" }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exit] = await Promise.all([new Response(cli.stdout).text(), new Response(cli.stderr).text(), cli.exited]); return { stdout, stderr, exit };
  };
  let pid: number | undefined; let ws: WebSocket | undefined;
  try {
    const help = await run("post", "comments", "--help"); expect(help.stdout).toContain("comments <url>"); expect(help.stdout).toContain("--limit"); expect(help.stdout).toContain("--json");
    for (const args of [["https://instagram.com/example/"], ["https://facebook.com/example/"], ["https://facebook.com.evil.test/posts/123"], ["https://instagram.com.evil.test/p/123/"], ["https://instagram.com/p/123/", "--limit", "501"], ["https://instagram.com/p/123/", "--limit", "0"]]) {
      expect((await run("post", "comments", ...args, "--json")).exit).not.toBe(0);
    }
    const id = "o".repeat(32);
    const pairing = JSON.parse((await run("extension", "pair", "--id", id, "--json")).stdout);
    const started = JSON.parse((await run("service", "start", "--json")).stdout); pid = started.pid;
    ws = new WebSocket(`ws://127.0.0.1:${started.extension.port}/extension`, { headers: { Origin: `chrome-extension://${id}` } } as unknown as string[]);
    await authenticateMock(ws, pairing.token);
    const expectedIg = { platform: "ig", url: "https://www.instagram.com/p/Cx_123/", comments: [{ author: "person", authorUrl: "https://www.instagram.com/person/", text: "Hello", date: null, likes: 0 }] };
    const expectedFb = { platform: "fb", url: "https://www.facebook.com/samplepage/posts/123456789/", comments: [{ author: "Bob", authorUrl: "https://www.facebook.com/bob", text: "Nice", date: "1h", likes: 1 }] };
    ws.onmessage = (event) => {
      const request = JSON.parse(String(event.data));
      const result = request.args.url.includes("instagram.com") ? expectedIg : expectedFb;
      ws!.send(JSON.stringify({ type: "result", id: request.id, result }));
    };
    const resultIg = await run("post", "comments", "https://instagram.com/p/Cx_123/?ignored=yes", "--limit", "1", "--json");
    expect(resultIg.exit).toBe(0); expect(JSON.parse(resultIg.stdout)).toEqual(expectedIg);
    const resultFb = await run("post", "comments", "https://facebook.com/samplepage/posts/123456789?ignored=yes", "--limit", "5", "--json");
    expect(resultFb.exit).toBe(0); expect(JSON.parse(resultFb.stdout)).toEqual(expectedFb);
    const jobs = JSON.parse((await run("queue", "list", "--json")).stdout).jobs;
    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toMatchObject({ action: "getComments", status: "done", result: expectedFb });
    expect(jobs[1]).toMatchObject({ action: "getComments", status: "done", result: expectedIg });
  } finally {
    ws?.close(); if (pid) { try { process.kill(pid, "SIGTERM"); } catch {} for (let i = 0; i < 100; i++) { try { process.kill(pid, 0); } catch { break; } await Bun.sleep(20); } }
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("getComments validates enqueue arguments, requeues on disconnect and recovers on restart", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "socmedia-comments-recovery-"));
  const run = async (...args: string[]) => {
    const cli = Bun.spawn(["bun", "run", "src/cli.ts", ...args], { cwd: import.meta.dir + "/..", env: { ...process.env, SOCMEDIA_STATE_DIR: stateDir, SOCMEDIA_EXTENSION_PORT: "0" }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exit] = await Promise.all([new Response(cli.stdout).text(), new Response(cli.stderr).text(), cli.exited]);
    return { stdout, stderr, exit };
  };
  let pid: number | undefined;
  let ws: WebSocket | undefined;
  try {
    expect((await run("queue", "enqueue", "getComments", "--args", '{"url":"https://facebook.com/post/1"}', "--json")).exit).not.toBe(0);
    expect((await run("queue", "enqueue", "getComments", "--args", '{"url":"https://instagram.com/p/123/","extra":1}', "--json")).exit).not.toBe(0);
    expect((await run("queue", "enqueue", "getComments", "--args", '{"url":"https://instagram.com/p/123/","limit":0}', "--json")).exit).not.toBe(0);
    expect((await run("queue", "enqueue", "getComments", "--args", '{"url":"https://instagram.com/p/123/","limit":600}', "--json")).exit).not.toBe(0);

    const extId = "k".repeat(32);
    const pairing = JSON.parse((await run("extension", "pair", "--id", extId, "--json")).stdout);
    let started = JSON.parse((await run("service", "start", "--json")).stdout);
    pid = started.pid;

    const fbValid = JSON.parse((await run("queue", "enqueue", "getComments", "--args", '{"url":"https://facebook.com/samplepage/posts/123456789","limit":5}', "--json")).stdout);
    expect(fbValid).toMatchObject({ id: 1, action: "getComments", args: { url: "https://www.facebook.com/samplepage/posts/123456789/", limit: 5 }, status: "queued" });
    await run("queue", "cancel", String(fbValid.id), "--json");

    const connect = async () => {
      const socket = new WebSocket(`ws://127.0.0.1:${started.extension.port}/extension`, { headers: { Origin: `chrome-extension://${extId}` } } as unknown as string[]);
      const request = new Promise<any>((resolve) => socket.addEventListener("message", (event) => { const msg = JSON.parse(String(event.data)); if (msg.type === "request") resolve(msg); }));
      await authenticateMock(socket, pairing.token);
      return { socket, request };
    };

    let link = await connect();
    ws = link.socket;

    const job = JSON.parse((await run("queue", "enqueue", "getComments", "--args", '{"url":"https://instagram.com/p/Cx_123/","limit":10}', "--json")).stdout);
    const req = await Promise.race([link.request, Bun.sleep(1500).then(() => { throw new Error("timeout"); })]);
    expect(req).toMatchObject({ action: "getComments", args: { url: "https://www.instagram.com/p/Cx_123/", limit: 10 } });

    ws.close();
    for (let i = 0; i < 50; i++) {
      const check = JSON.parse((await run("queue", "get", String(job.id), "--json")).stdout);
      if (check.status === "queued") break;
      await Bun.sleep(20);
    }
    expect(JSON.parse((await run("queue", "get", String(job.id), "--json")).stdout).status).toBe("queued");

    link = await connect();
    ws = link.socket;
    await Promise.race([link.request, Bun.sleep(1500).then(() => { throw new Error("retry timeout"); })]);
    expect(JSON.parse((await run("queue", "get", String(job.id), "--json")).stdout).status).toBe("running");

    process.kill(pid!, "SIGKILL");
    ws.close();
    for (let i = 0; i < 100; i++) { if (!(await run("service", "status", "--json")).stdout.includes('"running":true')) break; await Bun.sleep(20); }
    started = JSON.parse((await run("service", "start", "--json")).stdout);
    pid = started.pid;

    expect(JSON.parse((await run("queue", "get", String(job.id), "--json")).stdout).status).toBe("queued");

    link = await connect();
    ws = link.socket;
    const finalReq = await Promise.race([link.request, Bun.sleep(1500).then(() => { throw new Error("final retry timeout"); })]);
    const mockResult = { platform: "ig", url: "https://www.instagram.com/p/Cx_123/", comments: [] };
    ws.send(JSON.stringify({ type: "result", id: finalReq.id, result: mockResult }));

    let result: any;
    for (let i = 0; i < 50; i++) {
      result = JSON.parse((await run("queue", "get", String(job.id), "--json")).stdout);
      if (result.status === "done") break;
      await Bun.sleep(20);
    }
    expect(result).toMatchObject({ status: "done", result: mockResult });
  } finally {
    ws?.close();
    if (pid) { try { process.kill(pid, "SIGTERM"); } catch {} for (let i = 0; i < 100; i++) { try { process.kill(pid, 0); } catch { break; } await Bun.sleep(20); } }
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("contacts export writes filtered CSV JSON and JSONL inside home safely", async () => {
  const home = await mkdtemp(join(tmpdir(), "socmedia-export-home-"));
  const outside = await mkdtemp(join(tmpdir(), "socmedia-export-outside-"));
  const stateDir = join(home, "state");
  const run = async (...args: string[]) => {
    const cli = Bun.spawn(["bun", "run", "src/cli.ts", ...args], { cwd: import.meta.dir + "/..", env: { ...process.env, HOME: home, SOCMEDIA_STATE_DIR: stateDir, SOCMEDIA_EXTENSION_PORT: "0" }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exit] = await Promise.all([new Response(cli.stdout).text(), new Response(cli.stderr).text(), cli.exited]); return { stdout, stderr, exit };
  };
  let pid: number | undefined; let ws: WebSocket | undefined;
  try {
    const help = await run("contacts", "export", "--help");
    for (const term of ["export", "--format", "--path", "--status", "--platform", "--json"]) expect(help.stdout).toContain(term);
    const id = "n".repeat(32);
    const pairing = JSON.parse((await run("extension", "pair", "--id", id, "--json")).stdout);
    const started = JSON.parse((await run("service", "start", "--json")).stdout); pid = started.pid;
    ws = new WebSocket(`ws://127.0.0.1:${started.extension.port}/extension`, { headers: { Origin: `chrome-extension://${id}` } } as unknown as string[]);
    await authenticateMock(ws, pairing.token);
    ws.onmessage = (event) => {
      const request = JSON.parse(String(event.data));
      ws!.send(JSON.stringify({ type: "result", id: request.id, result: { platform: "ig", url: request.args.url, username: "example", name: '=HYPERLINK("x")', followers: 0, verified: false } }));
    };
    expect((await run("profile", "get", "https://www.instagram.com/example/", "--json")).exit).toBe(0);
    expect((await run("contacts", "update", "ig:example", "--status", "won", "--note", 'line\n"quoted", text', "--json")).exit).toBe(0);
    const contact = JSON.parse((await run("contacts", "list", "--json")).stdout).contacts[0];
    const csv = await run("contacts", "export", "--format", "csv", "--path", join(home, "reports", "contacts.csv"), "--status", "won", "--platform", "ig", "--json");
    expect(csv.exit).toBe(0); expect(JSON.parse(csv.stdout)).toEqual({ path: join(home, "reports", "contacts.csv"), count: 1 });
    const csvText = await readFile(join(home, "reports", "contacts.csv"), "utf8");
    expect(csvText).toStartWith("id,platform,username,name,status,followers,following,postsCount,verified,private,isBusiness,category,website,email,phone,bio,url,note,firstSeen,lastSeen,updatedAt\n");
    expect(csvText).toContain('"\'=HYPERLINK(""x"")"'); expect(csvText).toContain('"line\n""quoted"", text"');
    for (const format of ["json", "jsonl"]) {
      const file = join(home, `contacts.${format}`);
      const result = await run("contacts", "export", "--format", format, "--path", file, "--json"); expect(result.exit).toBe(0);
      const data = await readFile(file, "utf8"); expect(format === "json" ? JSON.parse(data) : data.trim().split("\n").map((line) => JSON.parse(line))).toEqual([contact]);
    }
    const empty = await run("contacts", "export", "--format", "json", "--status", "skip", "--path", join(home, "empty.json"), "--json");
    expect(JSON.parse(empty.stdout).count).toBe(0); expect(JSON.parse(await readFile(join(home, "empty.json"), "utf8"))).toEqual([]);
    const defaultResult = JSON.parse((await run("contacts", "export", "--json")).stdout);
    expect(defaultResult.path).toStartWith(join(home, "socmedia-data", "contacts-"));
    await symlink(outside, join(home, "escape"));
    for (const file of [join(outside, "bad.csv"), join(home, "escape", "bad.csv")]) {
      const rejected = await run("contacts", "export", "--path", file, "--json"); expect(rejected.exit).not.toBe(0);
    }
    expect((await run("contacts", "export", "--format", "xml", "--json")).exit).not.toBe(0);
    expect(await readdir(outside)).toEqual([]);
    await writeFile(join(outside, "victim"), "unchanged");
    await symlink(join(outside, "victim"), join(home, "linked.csv"));
    expect((await run("contacts", "export", "--path", join(home, "linked.csv"), "--json")).exit).not.toBe(0);
    expect(await readFile(join(outside, "victim"), "utf8")).toBe("unchanged");
    expect((await run("contacts", "export", "--path", join(stateDir, "state.sqlite"), "--json")).exit).not.toBe(0);
    expect(JSON.parse((await run("contacts", "list", "--json")).stdout).count).toBe(1);
  } finally {
    ws?.close(); if (pid) { try { process.kill(pid, "SIGTERM"); } catch {} for (let i = 0; i < 100; i++) { try { process.kill(pid, 0); } catch { break; } await Bun.sleep(20); } }
    await rm(home, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true });
  }
});

test("Facebook profile extraction uses actual extension DOM logic with HALT checks", async () => {
  const script = await Bun.file(new URL("../extension/background.js", import.meta.url)).text();
  const stored: Record<string, unknown> = { cliSelectedTab: 42 };
  const tab = { id: 42, windowId: 4, active: true, status: "complete", url: "https://www.facebook.com/oldpage" };
  const location = { href: tab.url, pathname: "/oldpage", hostname: "www.facebook.com" };
  const text = "Sample Page\n1.2K followers • 15 following\nFollow\nUseful local resources\nCommunity Organization\nMore\nLinks\nexample.org\nContact info\nhello@example.invalid\nPhotos";
  const document = { body: { innerText: text }, querySelector: (selector: string) => selector === "[role=main]" ? { innerText: text } : selector === "h1" ? { innerText: "Sample Page" } : null, querySelectorAll: () => [] };
  const ignore = { addListener() {} };
  const chrome = {
    storage: { local: { get: async (keys: string | string[]) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, stored[key]])), set: async (values: Record<string, unknown>) => Object.assign(stored, values) }, onChanged: ignore },
    tabs: { get: async () => tab, query: async () => [], update: async (_id: number, values: { url?: string }) => { if (values.url) { tab.url = values.url; location.href = values.url; location.pathname = new URL(values.url).pathname; } } },
    tabGroups: { query: async () => [] }, scripting: { executeScript: async ({ func, args = [] }: any) => [{ result: func(...args) }] },
    alarms: { create() {}, onAlarm: ignore }, runtime: { onStartup: ignore },
  };
  const context = { chrome, WebSocket, console, URL, document, location, setTimeout: (fn: () => void) => { fn(); return 0; }, Date, Math };
  runInNewContext(script, context);
  const profile = await runInNewContext('getProfile({url:"https://www.facebook.com/samplepage"})', context);
  expect(profile).toMatchObject({ platform: "fb", username: "samplepage", name: "Sample Page", bio: "Useful local resources", category: "Community Organization", followers: 1200, following: 15, postsCount: null, website: "https://example.org", contact: { email: "hello@example.invalid" } });
  const numeric = await runInNewContext('getProfile({url:"https://www.facebook.com/profile.php?id=12345"})', context);
  expect(numeric).toMatchObject({ platform: "fb", username: null });
  tab.url = "https://www.facebook.com/checkpoint/";
  await expect(runInNewContext('getProfile({url:"https://www.facebook.com/samplepage"})', context)).rejects.toMatchObject({ code: "HALT" });
  expect(tab.url).toBe("https://www.facebook.com/checkpoint/");
  tab.url = "https://www.facebook.com/oldpage";
  chrome.tabs.update = async () => { tab.url = "https://www.facebook.com/differentpage"; location.href = tab.url; location.pathname = "/differentpage"; };
  await expect(runInNewContext('getProfile({url:"https://www.facebook.com/samplepage"})', context)).rejects.toThrow("different profile");
});

test("Facebook profile URLs queue reads and upsert fb contacts while preserving user fields", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "socmedia-facebook-"));
  const run = async (...args: string[]) => {
    const cli = Bun.spawn(["bun", "run", "src/cli.ts", ...args], { cwd: import.meta.dir + "/..", env: { ...process.env, SOCMEDIA_STATE_DIR: stateDir, SOCMEDIA_EXTENSION_PORT: "0" }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exit] = await Promise.all([new Response(cli.stdout).text(), new Response(cli.stderr).text(), cli.exited]); return { stdout, stderr, exit };
  };
  let pid: number | undefined; let ws: WebSocket | undefined;
  try {
    for (const url of ["http://facebook.com/example", "https://facebook.com.evil.test/example", "https://user@facebook.com/example", "https://facebook.com/profile.php", "https://facebook.com/profile.php?id=abc", "https://facebook.com/profile.php?id=1&id=2", "https://facebook.com/people", "https://facebook.com/example/posts/123"]) {
      expect((await run("profile", "get", url, "--json")).exit).not.toBe(0);
    }
    const extId = "m".repeat(32);
    const pairing = JSON.parse((await run("extension", "pair", "--id", extId, "--json")).stdout);
    const started = JSON.parse((await run("service", "start", "--json")).stdout); pid = started.pid;
    ws = new WebSocket(`ws://127.0.0.1:${started.extension.port}/extension`, { headers: { Origin: `chrome-extension://${extId}` } } as unknown as string[]);
    await authenticateMock(ws, pairing.token);
    let name = "First";
    ws.onmessage = (event) => { const request = JSON.parse(String(event.data)); ws!.send(JSON.stringify({ type: "result", id: request.id, result: { platform: "fb", url: request.args.url, username: request.args.url.includes("profile.php") ? null : "samplepage", name, followers: 1200 } })); };
    const first = await run("profile", "get", "https://m.facebook.com/samplepage?tracking=ignored", "--json");
    expect(first.exit).toBe(0); expect(JSON.parse(first.stdout)).toMatchObject({ platform: "fb", url: "https://www.facebook.com/samplepage" });
    expect((await run("contacts", "update", "fb:samplepage", "--status", "won", "--note", "keep", "--json")).exit).toBe(0);
    name = "Updated"; expect((await run("profile", "get", "https://fb.com/samplepage", "--json")).exit).toBe(0);
    const numeric = await run("profile", "get", "https://www.facebook.com/profile.php?id=12345", "--json"); expect(numeric.exit).toBe(0);
    const contacts = JSON.parse((await run("contacts", "list", "--platform", "fb", "--json")).stdout).contacts;
    expect(contacts.find((contact: any) => contact.id === "fb:samplepage")).toMatchObject({ name: "Updated", status: "won", note: "keep" });
    expect(contacts.find((contact: any) => contact.id === "fb:profile.php?id=12345")).toMatchObject({ platform: "fb", status: "new" });
    expect((await run("service", "stop", "--json")).exit).toBe(0); ws.close();
    pid = JSON.parse((await run("service", "start", "--json")).stdout).pid;
    expect(JSON.parse((await run("contacts", "list", "--platform", "fb", "--json")).stdout).contacts).toEqual(contacts);
  } finally {
    ws?.close(); if (pid) { try { process.kill(pid, "SIGTERM"); } catch {} for (let i = 0; i < 100; i++) { try { process.kill(pid, 0); } catch { break; } await Bun.sleep(20); } }
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("contacts update preserves status and note through profile refresh and restart", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "socmedia-contact-update-"));
  const run = async (...args: string[]) => {
    const cli = Bun.spawn(["bun", "run", "src/cli.ts", ...args], { cwd: import.meta.dir + "/..", env: { ...process.env, SOCMEDIA_STATE_DIR: stateDir, SOCMEDIA_EXTENSION_PORT: "0" }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exit] = await Promise.all([new Response(cli.stdout).text(), new Response(cli.stderr).text(), cli.exited]); return { stdout, stderr, exit };
  };
  let pid: number | undefined; let ws: WebSocket | undefined;
  try {
    const help = await run("contacts", "update", "--help");
    expect(help.stdout).toContain("update <id>"); expect(help.stdout).toContain("--status"); expect(help.stdout).toContain("--note"); expect(help.stdout).toContain("--json");
    const extId = "l".repeat(32);
    const pairing = JSON.parse((await run("extension", "pair", "--id", extId, "--json")).stdout);
    const started = JSON.parse((await run("service", "start", "--json")).stdout); pid = started.pid;
    ws = new WebSocket(`ws://127.0.0.1:${started.extension.port}/extension`, { headers: { Origin: `chrome-extension://${extId}` } } as unknown as string[]);
    await authenticateMock(ws, pairing.token);
    let name = "First";
    ws.onmessage = (event) => { const request = JSON.parse(String(event.data)); ws!.send(JSON.stringify({ type: "result", id: request.id, result: { platform: "ig", url: request.args.url, username: "example", name } })); };
    expect((await run("profile", "get", "https://instagram.com/example/", "--json")).exit).toBe(0);
    const updated = await run("contacts", "update", "ig:example", "--status", "won", "--note", "remember", "--json");
    expect(updated.exit).toBe(0);
    expect(JSON.parse(updated.stdout)).toMatchObject({ id: "ig:example", status: "won", note: "remember", updatedAt: expect.any(String) });
    name = "Second";
    expect((await run("profile", "get", "https://instagram.com/example/", "--json")).exit).toBe(0);
    const current = JSON.parse((await run("contacts", "list", "--json")).stdout).contacts[0];
    expect(current).toMatchObject({ status: "won", note: "remember", name: "Second", updatedAt: expect.any(String) });
    for (const args of [["ig:missing", "--status", "won"], ["ig:example"], ["ig:example", "--status", "bad"], ["ig:example", "--note", "x".repeat(2001)], ["ig:example", "--unknown"]]) {
      const invalid = await run("contacts", "update", ...args, "--json"); expect(invalid.exit).not.toBe(0); expect(invalid.stderr.length).toBeGreaterThan(0);
    }
    expect((await run("service", "stop", "--json")).exit).toBe(0); ws.close();
    pid = JSON.parse((await run("service", "start", "--json")).stdout).pid;
    expect(JSON.parse((await run("contacts", "list", "--json")).stdout).contacts[0]).toEqual(current);
    const cleared = await run("contacts", "update", "ig:example", "--note", "", "--json");
    expect(cleared.exit).toBe(0); expect(JSON.parse(cleared.stdout)).toMatchObject({ status: "won", note: "" });
  } finally {
    ws?.close(); if (pid) { try { process.kill(pid, "SIGTERM"); } catch {} for (let i = 0; i < 100; i++) { try { process.kill(pid, 0); } catch { break; } await Bun.sleep(20); } }
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("profile results upsert contacts without erasing status or notes and survive restart", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "socmedia-contacts-"));
  const fixture = new Database(join(stateDir, "state.sqlite"));
  fixture.run("CREATE TABLE contacts (id TEXT PRIMARY KEY, data TEXT NOT NULL)");
  fixture.query("INSERT INTO contacts (id, data) VALUES (?, ?)").run("ig:example", JSON.stringify({ id: "ig:example", platform: "ig", status: "won", note: "preserve note", firstSeen: "2020-01-01T00:00:00.000Z", bio: "old bio", followers: 12, verified: true }));
  fixture.close();
  const run = async (...args: string[]) => {
    const cli = Bun.spawn(["bun", "run", "src/cli.ts", ...args], { cwd: import.meta.dir + "/..", env: { ...process.env, SOCMEDIA_STATE_DIR: stateDir, SOCMEDIA_EXTENSION_PORT: "0" }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exit] = await Promise.all([new Response(cli.stdout).text(), new Response(cli.stderr).text(), cli.exited]);
    return { stdout, stderr, exit };
  };
  let pid: number | undefined; let ws: WebSocket | undefined;
  try {
    const help = await run("contacts", "--help"); expect(help.stdout).toContain("list"); expect(help.stdout).toContain("--json");
    const id = "k".repeat(32);
    const pairing = JSON.parse((await run("extension", "pair", "--id", id, "--json")).stdout);
    const started = JSON.parse((await run("service", "start", "--json")).stdout); pid = started.pid;
    ws = new WebSocket(`ws://127.0.0.1:${started.extension.port}/extension`, { headers: { Origin: `chrome-extension://${id}` } } as unknown as string[]);
    await authenticateMock(ws, pairing.token);
    ws.onmessage = (event) => {
      const request = JSON.parse(String(event.data));
      const username = new URL(request.args.url).pathname.split("/")[1];
      const result = { platform: "ig", url: request.args.url, username, name: username === "example" ? "Updated" : "New contact", bio: null, followers: 0, verified: false, contact: username === "other" ? { email: "person@example.invalid", phone: "+10000000000" } : null };
      ws!.send(JSON.stringify({ type: "result", id: request.id, result }));
    };
    expect((await run("profile", "get", "https://instagram.com/example/", "--json")).exit).toBe(0);
    expect((await run("profile", "get", "https://instagram.com/other/", "--json")).exit).toBe(0);
    const listing = JSON.parse((await run("contacts", "list", "--json")).stdout);
    expect(listing.count).toBe(2);
    const existing = listing.contacts.find((c: any) => c.id === "ig:example");
    expect(existing).toMatchObject({ status: "won", note: "preserve note", firstSeen: "2020-01-01T00:00:00.000Z", name: "Updated", bio: "old bio", followers: 0, verified: false });
    expect(existing.lastSeen).toEqual(expect.any(String));
    expect(listing.contacts.find((c: any) => c.id === "ig:other")).toMatchObject({ status: "new", platform: "ig", username: "other", name: "New contact", email: "person@example.invalid", phone: "+10000000000" });
    expect(JSON.parse((await run("contacts", "list", "--status", "won", "--platform", "ig", "--json")).stdout).contacts).toEqual([existing]);
    expect((await run("contacts", "list", "--status", "unknown", "--json")).exit).not.toBe(0);
    ws.onmessage = (event) => {
      const request = JSON.parse(String(event.data));
      ws!.send(JSON.stringify({ type: "result", id: request.id, result: { platform: "ig", url: "https://www.instagram.com/other/", username: "other" } }));
    };
    const mismatch = await run("profile", "get", "https://instagram.com/third/", "--json");
    expect(mismatch.exit).not.toBe(0); expect(mismatch.stderr).toContain("does not match");
    expect(JSON.parse((await run("contacts", "list", "--json")).stdout)).toEqual(listing);
    expect((await run("service", "stop", "--json")).exit).toBe(0); ws.close();
    pid = JSON.parse((await run("service", "start", "--json")).stdout).pid;
    expect(JSON.parse((await run("contacts", "list", "--json")).stdout)).toEqual(listing);
  } finally {
    ws?.close(); if (pid) { try { process.kill(pid, "SIGTERM"); } catch {} for (let i = 0; i < 100; i++) { try { process.kill(pid, 0); } catch { break; } await Bun.sleep(20); } }
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("Instagram profile extraction uses real extension DOM logic after safe navigation", async () => {
  const script = await Bun.file(new URL("../extension/background.js", import.meta.url)).text();
  const stored: Record<string, unknown> = { cliSelectedTab: 42 };
  const tab = { id: 42, windowId: 4, active: true, status: "complete", url: "https://www.instagram.com/previous/" };
  const location = { href: tab.url, pathname: "/previous/", hostname: "www.instagram.com" };
  const main = { innerText: "10 posts\n1.2K followers\n45 following\nA sample bio\nexample.org\nMessage" };
  const document = {
    body: { innerText: main.innerText },
    querySelector: (selector: string) => selector === 'meta[property="og:title"]' ? { content: "Example Name (@example)" } : selector === "main" ? main : null,
    querySelectorAll: () => [],
  };
  const ignore = { addListener() {} };
  const chrome = {
    storage: { local: { get: async (keys: string | string[]) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, stored[key]])), set: async (values: Record<string, unknown>) => Object.assign(stored, values) }, onChanged: ignore },
    tabs: {
      get: async () => tab, query: async () => [],
      update: async (_id: number, values: { url?: string }) => { if (values.url) { tab.url = values.url; location.href = values.url; location.pathname = new URL(values.url).pathname; } },
    },
    tabGroups: { query: async () => [] }, scripting: { executeScript: async ({ func, args = [] }: any) => [{ result: func(...args) }] },
    alarms: { create() {}, onAlarm: ignore }, runtime: { onStartup: ignore },
  };
  const context = { chrome, WebSocket, console, URL, document, location, setTimeout: (fn: () => void) => { fn(); return 0; }, Date, Math };
  runInNewContext(script, context);
  const result = await runInNewContext('getProfile({url:"https://www.instagram.com/example/"})', context);
  expect(result).toMatchObject({ platform: "ig", username: "example", name: "Example Name", bio: "A sample bio", website: "https://example.org", category: null, followers: 1200, following: 45, postsCount: 10, verified: false, private: false, isBusiness: false, avatarUrl: null, contact: null, links: [] });
  expect(tab.url).toBe("https://www.instagram.com/example/");
  tab.url = "https://www.instagram.com/checkpoint/";
  await expect(runInNewContext('getProfile({url:"https://www.instagram.com/example/"})', context)).rejects.toMatchObject({ code: "HALT" });
  expect(tab.url).toBe("https://www.instagram.com/checkpoint/");
});

test("profile get validates Instagram URLs and returns queued result", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "socmedia-profile-"));
  const run = async (...args: string[]) => {
    const cli = Bun.spawn(["bun", "run", "src/cli.ts", ...args], { cwd: import.meta.dir + "/..", env: { ...process.env, SOCMEDIA_STATE_DIR: stateDir, SOCMEDIA_EXTENSION_PORT: "0" }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exit] = await Promise.all([new Response(cli.stdout).text(), new Response(cli.stderr).text(), cli.exited]); return { stdout, stderr, exit };
  };
  let pid: number | undefined; let ws: WebSocket | undefined;
  try {
    const help = await run("profile", "get", "--help"); expect(help.stdout).toContain("get <url>"); expect(help.stdout).toContain("--json");
    for (const url of ["https://instagram.com.evil.test/example", "http://instagram.com/example", "https://user@instagram.com/example", "https://instagram.com:444/example", "https://instagram.com/p/123", "https://instagram.com/"]) {
      const invalid = await run("profile", "get", url, "--json"); expect(invalid.exit).not.toBe(0); expect(invalid.stderr).toContain("Instagram");
    }
    const id = "j".repeat(32);
    const pairing = JSON.parse((await run("extension", "pair", "--id", id, "--json")).stdout);
    const started = JSON.parse((await run("service", "start", "--json")).stdout); pid = started.pid;
    ws = new WebSocket(`ws://127.0.0.1:${started.extension.port}/extension`, { headers: { Origin: `chrome-extension://${id}` } } as unknown as string[]);
    await authenticateMock(ws, pairing.token);
    const expected = { platform: "ig", url: "https://www.instagram.com/example/", username: "example", name: "Example", followers: 1200 };
    ws.onmessage = (event) => { const request = JSON.parse(String(event.data)); expect(request.action).toBe("getProfile"); expect(request.args).toEqual({ url: expected.url }); ws!.send(JSON.stringify({ type: "result", id: request.id, result: expected })); };
    const result = await run("profile", "get", "https://www.instagram.com/example/", "--json");
    expect(result.exit).toBe(0); expect(JSON.parse(result.stdout)).toEqual(expected);
    const jobs = JSON.parse((await run("queue", "list", "--json")).stdout).jobs;
    expect(jobs[0]).toMatchObject({ action: "getProfile", status: "done", result: expected });
    ws.onmessage = (event) => { const request = JSON.parse(String(event.data)); ws!.send(JSON.stringify({ type: "result", id: request.id, error: { code: "HALT", reason: "captcha challenge" } })); };
    const halted = await run("profile", "get", "https://instagram.com/example/", "--json");
    expect(halted.exit).not.toBe(0); expect(halted.stderr).toContain("captcha challenge"); expect(halted.stderr).toContain("resume");
  } finally {
    ws?.close();
    if (pid) { try { process.kill(pid, "SIGTERM"); } catch {} for (let i = 0; i < 100; i++) { try { process.kill(pid, 0); } catch { break; } await Bun.sleep(20); } }
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("page read rechecks its job when HALT arrives between job and status reads", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "socmedia-halt-race-"));
  let halted = false;
  let reads = 0;
  let mode: "failed" | "queued" = "failed";
  const server = createServer((socket) => {
    socket.write(JSON.stringify({ identity: "socmedia-service-v1", pid: process.pid, version: projectVersion, extension: { connected: true, compatible: true }, halted: halted ? { code: "HALT", reason: "captcha challenge" } : null }) + "\n");
    let input = "";
    socket.on("data", (data) => {
      input += data.toString();
      if (!input.includes("\n")) return;
      const command = input.split("\n")[0]!;
      let reply: unknown;
      if (command.startsWith("queue enqueue ")) reply = { id: 2, status: "queued" };
      else if (command === "queue get 2") {
        reads++;
        if (reads === 1) { halted = true; reply = { id: 2, status: "running" }; }
        else reply = mode === "failed" ? { id: 2, status: "failed", error: { code: "HALT", reason: "captcha challenge" } } : { id: 2, status: "queued" };
      } else reply = { error: "unexpected command" };
      socket.end(JSON.stringify(reply) + "\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(join(stateDir, "service.sock"), resolve));
  const run = async () => {
    const cli = Bun.spawn(["bun", "run", "src/cli.ts", "page", "read", "--json"], { cwd: import.meta.dir + "/..", env: { ...process.env, SOCMEDIA_STATE_DIR: stateDir, SOCMEDIA_EXTENSION_PORT: "0" }, stdout: "pipe", stderr: "pipe" });
    const [stderr, exit] = await Promise.all([new Response(cli.stderr).text(), cli.exited]);
    return { stderr, exit };
  };
  try {
    const failed = await run();
    expect(failed.exit).not.toBe(0); expect(failed.stderr).toContain("captcha challenge"); expect(failed.stderr).toContain("resume"); expect(reads).toBe(2);
    halted = false; reads = 0; mode = "queued";
    const queued = await run();
    expect(queued.exit).not.toBe(0); expect(queued.stderr).toContain("Job 2"); expect(queued.stderr).toContain("queued"); expect(reads).toBe(2);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("page read validates limits and returns queued readPage data or a HALT error", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "socmedia-page-read-"));
  const run = async (...args: string[]) => {
    const cli = Bun.spawn(["bun", "run", "src/cli.ts", ...args], { cwd: import.meta.dir + "/..", env: { ...process.env, SOCMEDIA_STATE_DIR: stateDir, SOCMEDIA_EXTENSION_PORT: "0" }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exit] = await Promise.all([new Response(cli.stdout).text(), new Response(cli.stderr).text(), cli.exited]);
    return { stdout, stderr, exit };
  };
  let pid: number | undefined;
  let ws: WebSocket | undefined;
  try {
    const help = await run("page", "read", "--help");
    expect(help.stdout).toContain("read"); expect(help.stdout).toContain("--max-lines"); expect(help.stdout).toContain("--json");
    for (const args of [["--max-lines", "0"], ["--max-lines", "1001"], ["--max-lines", "abc"], ["--max-lines"], ["--unknown"]]) {
      const invalid = await run("page", "read", ...args, "--json");
      expect(invalid.exit).not.toBe(0); expect(invalid.stderr).toContain(args[0]);
    }
    const extId = "i".repeat(32);
    const pairing = JSON.parse((await run("extension", "pair", "--id", extId, "--json")).stdout);
    const started = JSON.parse((await run("service", "start", "--json")).stdout); pid = started.pid;
    ws = new WebSocket(`ws://127.0.0.1:${started.extension.port}/extension`, { headers: { Origin: `chrome-extension://${extId}` } } as unknown as string[]);
    await authenticateMock(ws, pairing.token);
    let halt = false;
    const seen: any[] = [];
    ws.onmessage = (event) => {
      const request = JSON.parse(String(event.data)); seen.push(request);
      ws!.send(JSON.stringify(halt ? { type: "result", id: request.id, error: { code: "HALT", reason: "captcha challenge" } } : { type: "result", id: request.id, result: { url: "https://www.instagram.com/", text: "one\ntwo", lines: ["one", "two"] } }));
    };
    const read = await run("page", "read", "--max-lines", "2", "--json");
    expect(read.exit).toBe(0); expect(JSON.parse(read.stdout)).toMatchObject({ text: "one\ntwo", lines: ["one", "two"] });
    expect(seen[0]).toMatchObject({ action: "readPage", args: { maxLines: 2 } });
    halt = true;
    const blocked = await run("page", "read", "--json");
    expect(blocked.exit).not.toBe(0); expect(blocked.stderr).toContain("captcha challenge"); expect(blocked.stderr).toContain("resume");
    expect(seen[1]).toMatchObject({ action: "readPage", args: {} });
  } finally {
    ws?.close();
    if (pid) { try { process.kill(pid, "SIGTERM"); } catch {} for (let i = 0; i < 100; i++) { try { process.kill(pid, 0); } catch { break; } await Bun.sleep(20); } }
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("extension snapshot preserves visible element fields and shares HALT protection", async () => {
  const script = await Bun.file(new URL("../extension/background.js", import.meta.url)).text();
  const stored: Record<string, unknown> = { cliSelectedTab: 42 };
  const tab = { id: 42, windowId: 4, active: true, url: "https://www.instagram.com/example/" };
  const element = (visible: boolean, role: string | null, text: string, href: string | null) => ({
    tagName: "BUTTON", innerText: text, href, getAttribute: (name: string) => name === "role" ? role : name === "aria-label" ? "Profile" : null,
    getBoundingClientRect: () => ({ width: visible ? 100 : 0, height: visible ? 50 : 0 }),
  });
  const elements = [element(true, "button", "  View   profile  ", "https://www.instagram.com/example/"), element(false, null, "hidden", null), element(true, null, " Next ", null)];
  const document = { body: { innerText: "" }, querySelector: () => null, querySelectorAll: (selector: string) => selector === "iframe" || selector.startsWith("[role=dialog]") ? [] : elements };
  const ignore = { addListener() {} };
  const chrome = {
    storage: { local: { get: async (keys: string | string[]) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, stored[key]])), set: async (v: Record<string, unknown>) => Object.assign(stored, v) }, onChanged: ignore },
    tabs: { get: async () => tab, query: async () => [] }, tabGroups: { query: async () => [] },
    scripting: { executeScript: async ({ func, args = [] }: any) => [{ result: func(...args) }] },
    alarms: { create() {}, onAlarm: ignore }, runtime: { onStartup: ignore },
  };
  const context = { chrome, WebSocket, console, URL, document, location: { pathname: "/example/", hostname: "www.instagram.com" } };
  runInNewContext(script, context);
  expect(await runInNewContext("snapshot({})", context)).toEqual([
    { index: 0, role: "button", label: "Profile", text: "View profile", href: "https://www.instagram.com/example/" },
    { index: 1, role: "button", label: "Profile", text: "Next", href: null },
  ]);
  tab.url = "https://www.instagram.com/checkpoint/";
  await expect(runInNewContext("snapshot({})", context)).rejects.toMatchObject({ code: "HALT" });
});

test("page snapshot returns a queued browser result through the authenticated extension", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "socmedia-snapshot-"));
  const run = async (...args: string[]) => {
    const cli = Bun.spawn(["bun", "run", "src/cli.ts", ...args], { cwd: import.meta.dir + "/..", env: { ...process.env, SOCMEDIA_STATE_DIR: stateDir, SOCMEDIA_EXTENSION_PORT: "0" }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exit] = await Promise.all([new Response(cli.stdout).text(), new Response(cli.stderr).text(), cli.exited]);
    return { stdout, stderr, exit };
  };
  let pid: number | undefined;
  let ws: WebSocket | undefined;
  try {
    const help = await run("page", "snapshot", "--help");
    expect(help.stdout).toContain("snapshot"); expect(help.stdout).toContain("--json");
    const id = "h".repeat(32);
    const pairing = JSON.parse((await run("extension", "pair", "--id", id, "--json")).stdout);
    const started = JSON.parse((await run("service", "start", "--json")).stdout); pid = started.pid;
    ws = new WebSocket(`ws://127.0.0.1:${started.extension.port}/extension`, { headers: { Origin: `chrome-extension://${id}` } } as unknown as string[]);
    await authenticateMock(ws, pairing.token);
    const expected = [{ index: 0, role: "button", label: "Open", text: "Open", href: null }];
    ws.onmessage = (event) => {
      const request = JSON.parse(String(event.data));
      expect(request.action).toBe("snapshot");
      ws!.send(JSON.stringify({ type: "result", id: request.id, result: expected }));
    };
    const result = await run("page", "snapshot", "--json");
    expect(result.exit).toBe(0); expect(JSON.parse(result.stdout)).toEqual(expected);
    const list = JSON.parse((await run("queue", "list", "--json")).stdout);
    expect(list.jobs[0]).toMatchObject({ action: "snapshot", status: "done", result: expected });
    let shouldHalt = true;
    ws.onmessage = (event) => {
      const request = JSON.parse(String(event.data));
      ws!.send(JSON.stringify(shouldHalt ? { type: "result", id: request.id, error: { code: "HALT", reason: "captcha challenge" } } : { type: "result", id: request.id, result: expected }));
    };
    const haltedJob = JSON.parse((await run("queue", "enqueue", "snapshot", "--json")).stdout);
    let state: any;
    for (let i = 0; i < 40; i++) { state = JSON.parse((await run("service", "status", "--json")).stdout); if (state.halted) break; await Bun.sleep(20); }
    expect(state.halted).toMatchObject({ code: "HALT", reason: "captcha challenge" });
    expect(JSON.parse((await run("queue", "get", String(haltedJob.id), "--json")).stdout).status).toBe("failed");
    const waiting = JSON.parse((await run("queue", "enqueue", "snapshot", "--json")).stdout);
    expect(JSON.parse((await run("queue", "get", String(waiting.id), "--json")).stdout).status).toBe("queued");
    shouldHalt = false;
    expect((await run("service", "resume", "--json")).exit).toBe(0);
    let final: any;
    for (let i = 0; i < 40; i++) { final = JSON.parse((await run("queue", "get", String(waiting.id), "--json")).stdout); if (final.status === "done") break; await Bun.sleep(20); }
    expect(final).toMatchObject({ status: "done", result: expected });
  } finally {
    ws?.close();
    if (pid) { try { process.kill(pid, "SIGTERM"); } catch {} for (let i = 0; i < 100; i++) { try { process.kill(pid, 0); } catch { break; } await Bun.sleep(20); } }
    await rm(stateDir, { recursive: true, force: true });
  }
});

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
    const inert = await run("queue", "enqueue", "getPosts", "--args", "{}", "--json");
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
