import { closeSync, constants, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createConnection, createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dlopen, FFIType } from "bun:ffi";
import { Database } from "bun:sqlite";
import packageInfo from "../package.json";

const stateDir = process.env.SOCMEDIA_STATE_DIR ?? join(homedir(), ".socmedia-cli");
const socketPath = join(stateDir, "service.sock");
const lockPath = join(stateDir, "service.lock");
const identity = "socmedia-service-v1";
const pairingPath = join(stateDir, "extension-pairing.json");
const configPath = join(stateDir, "config.json");
const extensionVersion = packageInfo.version;
const extensionPath = join(stateDir, "extension");

function readConfig(): Record<string, unknown> {
  try {
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("Config must be an object");
    return config;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

function effectivePort() {
  const config = readConfig();
  const env = process.env.SOCMEDIA_EXTENSION_PORT;
  if (env !== undefined) {
    if (!/^\d+$/.test(env) || Number(env) > 65535) throw new Error("SOCMEDIA_EXTENSION_PORT must be 0-65535");
    return { port: Number(env), source: "environment", configuredPort: config.port ?? null };
  }
  if (config.port !== undefined && (!Number.isInteger(config.port) || Number(config.port) < 1 || Number(config.port) > 65535)) throw new Error("Configured port must be an integer from 1 to 65535");
  return config.port === undefined ? { port: 47842, source: "default", configuredPort: null } : { port: Number(config.port), source: "config", configuredPort: config.port };
}

function writeConfig(config: Record<string, unknown>) {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const temporary = join(stateDir, `.config-${randomBytes(8).toString("hex")}`);
  try { writeFileSync(temporary, JSON.stringify(config), { mode: 0o600, flag: "wx" }); renameSync(temporary, configPath); }
  finally { rmSync(temporary, { force: true }); }
}

function installExtension() {
  const source = fileURLToPath(new URL("../extension/", import.meta.url));
  const manifest = JSON.parse(readFileSync(join(source, "manifest.json"), "utf8"));
  if (manifest.version !== extensionVersion || typeof manifest.key !== "string" || !manifest.key) throw new Error("Extension manifest version or public key is invalid");
  const hash = createHash("sha256").update(Buffer.from(manifest.key, "base64")).digest("hex").slice(0, 32);
  const id = [...hash].map((nibble) => String.fromCharCode(97 + parseInt(nibble, 16))).join("");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  if (existsSync(extensionPath) && !lstatSync(extensionPath).isDirectory()) throw new Error("Extension path exists and is not a directory");
  const staged = mkdtempSync(join(stateDir, ".extension-install-"));
  const backup = `${staged}-previous`;
  let movedPrevious = false;
  try {
    for (const file of ["manifest.json", "background.js", "popup.html", "popup.js", "README.md"]) cpSync(join(source, file), join(staged, file));
    cpSync(join(source, "icons"), join(staged, "icons"), { recursive: true });
    if (existsSync(extensionPath)) { renameSync(extensionPath, backup); movedPrevious = true; }
    try { renameSync(staged, extensionPath); }
    catch (error) { if (movedPrevious) renameSync(backup, extensionPath); throw error; }
    if (movedPrevious) rmSync(backup, { recursive: true, force: true });
  } finally { rmSync(staged, { recursive: true, force: true }); }
  return { path: extensionPath, id, steps: ["Open chrome://extensions and enable Developer mode", "Choose Load unpacked", `Select ${extensionPath}`] };
}
const compatibleVersion = (version: string) => {
  const requested = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  const current = /^(\d+)\.(\d+)\.(\d+)$/.exec(extensionVersion);
  return !!requested && !!current && requested[1] === current[1] && requested[2] === current[2];
};
const actions = new Set(["getProfile", "getPosts", "getPost", "getComments", "search", "screenshot", "readInbox", "readThread", "readPage", "snapshot", "scroll", "listTabs", "useTab", "ytStudioRead", "click", "downloadProfile"]);
const contactStatuses = ["new", "messaged", "replied", "won", "rejected", "skip"];
const contactColumns = ["id", "platform", "username", "name", "status", "followers", "following", "postsCount", "verified", "private", "isBusiness", "category", "website", "email", "phone", "bio", "url", "note", "firstSeen", "lastSeen", "updatedAt"];

function csvCell(value: unknown) {
  let text = value == null ? "" : String(value);
  if (/^[=@\t\r]/.test(text) || (/^[+-]/.test(text) && !/^[+-]?[\d\s().-]+$/.test(text))) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function exportContactFile(path: unknown, format: string, contacts: Record<string, unknown>[]) {
  if (path !== undefined && (typeof path !== "string" || !path)) throw new Error("Export path must be a nonempty string");
  const home = resolve(homedir());
  const input = path === undefined ? join("socmedia-data", `contacts-${new Date().toISOString().slice(0, 10)}.${format}`) : (path as string).replace(/^~(?=\/|$)/, home);
  const file = resolve(home, input);
  const rel = relative(home, file);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("Export path must be inside home");
  let current = home;
  const parents = dirname(rel).split(sep).filter((part) => part && part !== ".");
  for (const part of parents) {
    current = join(current, part);
    try {
      const entry = lstatSync(current);
      if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error("Export directories must not be symbolic links");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      mkdirSync(current, { mode: 0o700 });
    }
  }
  try {
    const entry = lstatSync(file);
    if (entry.isSymbolicLink() || !entry.isFile()) throw new Error("Export destination must be a regular file, not a symbolic link");
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const serviceFiles = ["state.sqlite", "state.sqlite-wal", "state.sqlite-shm", "extension-pairing.json", "config.json", "service.lock", "service.sock"];
  if (serviceFiles.some((name) => file === resolve(stateDir, name))) throw new Error("Export destination conflicts with service state");
  const output = format === "json" ? JSON.stringify(contacts, null, 2)
    : format === "jsonl" ? contacts.map((contact) => JSON.stringify(contact) + "\n").join("")
      : [contactColumns, ...contacts.map((contact) => contactColumns.map((column) => contact[column]))].map((row) => row.map(csvCell).join(",")).join("\n") + "\n";
  const temporary = join(dirname(file), `.contacts-export-${randomBytes(12).toString("hex")}`);
  let fd: number | undefined;
  try {
    fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    writeFileSync(fd, output); closeSync(fd); fd = undefined;
    renameSync(temporary, file);
  } finally { if (fd !== undefined) closeSync(fd); rmSync(temporary, { force: true }); }
  return { path: file, count: contacts.length };
}

const isPrivateHost = (h: string) => /^(localhost|.*\.(local|internal|localdomain))$/i.test(h)
  || /^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h) || h.startsWith("[");

const isMediaHost = (h: string) => /\.(cdninstagram\.com|fbcdn\.net)$/i.test(String(h));

const NOT_VIDEO_BRANDS = /^(avif|avis|heic|heix|hevc|hevx|mif1|msf1|M4A |M4B )$/;
function mediaExt(b: Buffer): "jpg" | "png" | "webp" | "mp4" | null {
  if (b.length < 12) return null;
  const h = b.toString("hex", 0, 4);
  if (h.startsWith("ffd8ff")) return "jpg";
  if (h === "89504e47") return "png";
  if (b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") return "webp";
  if (b.toString("latin1", 4, 8) === "ftyp" && !NOT_VIDEO_BRANDS.test(b.toString("latin1", 8, 12))) return "mp4";
  return null;
}

function safeSeg(s: unknown, max = 60, keepCase = false): string | null {
  const raw = String(s ?? "").normalize("NFKC");
  const v = (keepCase ? raw : raw.toLowerCase()).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+/, "").slice(0, max).replace(/[-.]+$/, "");
  return v || (/[\p{L}\p{N}]/u.test(raw) ? `x-${createHash("sha1").update(raw).digest("hex").slice(0, 8)}` : null);
}

function authorSeg(author: any): string {
  let a = safeSeg(author?.username);
  if (!a && author?.url) {
    try {
      const u = new URL(author.url);
      const seg = u.pathname.split("/").filter(Boolean)[0];
      if (seg) a = safeSeg(seg);
    } catch {}
  }
  return a || "_unknown";
}

function postId(url: string): string | null {
  let x: URL;
  try { x = new URL(url); } catch { return null; }
  const q = x.searchParams.get("v") || x.searchParams.get("story_fbid") || x.searchParams.get("fbid");
  const segs = x.pathname.split("/").filter(Boolean);
  const i = segs.findIndex((s) => /^(p|reels?|tv|posts|videos)$/i.test(s));
  const id = q || (i >= 0 ? segs[i + 1] : segs.at(-1));
  const seg = safeSeg(id, 60, true);
  return seg && /[A-Z]/.test(seg) ? `${seg}-${createHash("sha1").update(id!).digest("hex").slice(0, 6)}` : seg;
}

function postDir(post: any, url: string): string {
  const home = resolve(homedir());
  const root = join(home, "socmedia-data");
  const platform = safeSeg(post?.platform) || "_unknown";
  const author = authorSeg(post?.author);
  const pid = postId(url) || "_unknown";
  const target = resolve(root, platform, author, pid);
  const rel = relative(home, target);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("Path must be inside home");
  return target;
}

const MAX_MEDIA_BYTES = 15 * 1024 * 1024;
const MAX_VIDEO_BYTES = 200 * 1024 * 1024;
const mediaMax = (type?: string) => (type === "video" ? MAX_VIDEO_BYTES : MAX_MEDIA_BYTES);

async function fetchBody(url: string, options: { max: number; timeout?: number; allow?: (h: string) => boolean; file?: string }) {
  let u = new URL(url);
  for (let hop = 0; hop < 6; hop++) {
    if (!/^https?:$/.test(u.protocol) || isPrivateHost(u.hostname) || (options.allow && !options.allow(u.hostname))) {
      throw new Error(`Refusing to fetch ${u.href}`);
    }
    const res = await fetch(u.href, { redirect: "manual", signal: AbortSignal.timeout(options.timeout ?? 10000), headers: { accept: "*/*" } });
    const loc = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && loc) {
      u = new URL(loc, u);
      await res.body?.cancel();
      continue;
    }
    if (Number(res.headers.get("content-length")) > options.max) {
      await res.body?.cancel();
      return { status: res.status, url: u.href, headers: res.headers, body: Buffer.alloc(0), truncated: true };
    }
    const chunks: Uint8Array[] = [];
    let n = 0;
    let truncated = false;
    const fd = options.file ? openSync(options.file, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC, 0o600) : null;
    try {
      if (res.body) {
        // @ts-ignore
        for await (const chunk of res.body) {
          const c = chunk as Uint8Array;
          n += c.length;
          if (n > options.max) { truncated = true; break; }
          if (fd !== null) writeSync(fd, c);
          if (fd === null || n - c.length < 16) chunks.push(c);
        }
      }
    } finally {
      if (fd !== null) closeSync(fd);
    }
    return { status: res.status, url: u.href, headers: res.headers, body: Buffer.concat(chunks), truncated };
  }
  throw new Error("Too many redirects");
}

async function downloadPostMedia(result: any, postUrl: string) {
  if (!result || typeof result !== "object") return result;
  if (!["ig", "fb"].includes(result.platform) || !Array.isArray(result.media)) return result;
  const dir = postDir(result, postUrl || result.url);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const downloadedFiles: string[] = [];
  for (let i = 0; i < result.media.length; i++) {
    const m = result.media[i];
    m.path = null;
    if (!m.url) { m.error ??= "no media url"; continue; }
    const max = mediaMax(m.type);
    const nn = String(i + 1).padStart(2, "0");
    const tmp = join(dir, `${nn}.part`);
    try {
      const f = await fetchBody(m.url, { max, timeout: m.type === "video" ? 600000 : 60000, allow: isMediaHost, file: tmp });
      const ext = f.status === 200 && !f.truncated ? mediaExt(f.body) : null;
      if (!ext) throw new Error(`not jpg/png/webp/mp4, or over ${max / 1048576} MB`);
      for (const e of ["jpg", "png", "webp", "mp4"]) if (e !== ext) rmSync(join(dir, `${nn}.${e}`), { force: true });
      const file = join(dir, `${nn}.${ext}`);
      renameSync(tmp, file);
      m.path = file;
      downloadedFiles.push(file);
    } catch (e: any) {
      rmSync(tmp, { force: true });
      m.error = e?.message || String(e);
    }
  }
  result.files = downloadedFiles;
  writeFileSync(join(dir, "post.json"), JSON.stringify({ ...result, savedAt: new Date().toISOString() }, null, 2));
  return result;
}

function resolveHomePath(inputPath: string): string {
  const home = resolve(homedir());
  const target = resolve(home, inputPath.replace(/^~(?=\/|$)/, home));
  const rel = relative(home, target);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("Path must be inside home");
  return target;
}

const PNG_MAGIC = "89504e470d0a1a0a";
function parseDataUrl(dataUrl: unknown): Buffer {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl ?? ""));
  if (!m) throw new Error("Extension returned no PNG data URL");
  const buf = Buffer.from(m[1], "base64");
  if (buf.length < 16 || buf.subarray(0, 8).toString("hex") !== PNG_MAGIC) throw new Error("Screenshot data is not a PNG");
  return buf;
}

const stamp = (d = new Date()) => {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

const slug = (s: unknown) => String(s || "").toLowerCase().normalize("NFKC").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "") || "page";

function screenshotPath(platform: string, url?: string, now = new Date()): string {
  const home = resolve(homedir());
  const baseDir = join(home, "socmedia-data", "screenshots");
  let part = "page";
  if (url) {
    try {
      const u = new URL(url);
      part = slug(u.pathname);
    } catch {}
  }
  const base = join(baseDir, `${platform}-${part}-${stamp(now)}`);
  let file = `${base}.png`;
  for (let i = 2; existsSync(file); i++) file = `${base}-${i}.png`;
  return file;
}

function profileDir(platform: string, username: string, baseDir?: string): string {
  const home = resolve(homedir());
  const root = baseDir ? resolveHomePath(baseDir) : join(home, "socmedia-data");
  const p = safeSeg(platform) || "_unknown";
  const u = safeSeg(username) || "_unknown";
  const target = resolve(root, p, u);
  const rel = relative(home, target);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("Path must be inside home");
  return target;
}

function profileMarkdown(p: any, posts: any[]): string {
  const L = [`# ${p.name || p.username || "Profile"}`, ""];
  const kv = (k: string, v: unknown) => { if (v != null && v !== "") L.push(`- **${k}:** ${v}`); };
  kv("Platform", p.platform);
  kv("Username", p.username);
  kv("URL", p.url);
  kv("Category", p.category);
  kv("Followers", p.followers);
  kv("Following", p.following);
  kv("Posts", p.postsCount);
  kv("Verified", p.verified == null ? null : p.verified ? "yes" : "no");
  kv("Private", p.private == null ? null : p.private ? "yes" : "no");
  kv("Business", p.isBusiness == null ? null : p.isBusiness ? "yes" : "no");
  kv("Website", p.website);
  kv("Email", p.contact?.email || p.email);
  kv("Phone", p.contact?.phone || p.phone);
  kv("Address", p.contact?.address || p.address);
  if (p.bio) L.push("", "## Bio", p.bio);
  if (p.links?.length) L.push("", "## Links", ...p.links.map((l: string) => `- ${l}`));
  if (posts.length) {
    L.push("", "## Posts");
    for (const x of posts) {
      const d = x.detail || {};
      const cap = String(d.caption ?? x.caption ?? "").replace(/\s+/g, " ").trim();
      const stats = [x.type, d.date || x.date, (d.likes ?? x.likes) != null ? `${d.likes ?? x.likes} likes` : null, (d.commentsCount ?? x.comments) != null ? `${d.commentsCount ?? x.comments} comments` : null].filter(Boolean).join(", ");
      L.push(`- ${x.url}${stats ? ` (${stats})` : ""}${cap ? `: ${cap.length > 200 ? `${cap.slice(0, 199)}…` : cap}` : ""}${x.files?.length ? ` [${x.files.join(", ")}]` : ""}`);
    }
  }
  return L.join("\n") + "\n";
}

async function downloadProfile({ url, limit = 12, details = true, maxMedia = 50, dir }: { url: string; limit?: number; details?: boolean; maxMedia?: number; dir?: string }, step: (action: any, args: any) => Promise<any>) {
  const normUrl = profileUrl(url);
  const u = new URL(normUrl);
  const platform = u.hostname.includes("instagram.com") ? "ig" : "fb";
  const urlPath = u.pathname.replace(/^\/+|\/+$/g, "");
  const warnings: string[] = [];
  const warn = (what: string) => (e: any) => { warnings.push(`${what}: ${e?.message || String(e)}`); return null; };
  const soft = async <T>(fn: () => Promise<T>, onError: (e: any) => T | null): Promise<T | null> => {
    try { return await fn(); } catch (e: any) {
      if (String(e?.message).startsWith("HALT")) throw e;
      return onError(e);
    }
  };

  const profile = await step("getProfile", { url: normUrl }) as any;
  const username = profile?.username || urlPath.split("/")[0];
  const folder = profileDir(platform, username, dir);
  mkdirSync(join(folder, "media"), { recursive: true, mode: 0o700 });

  const shotFile = join(folder, "screenshot.png");
  const shot = await soft(() => step("screenshot", { url: normUrl, target: "profile", path: shotFile }), warn("screenshot"));
  const list = await soft(() => step("getPosts", { url: normUrl, limit }), warn("posts")) as any;
  const posts = (list?.posts || []).slice(0, limit) as any[];
  if (details) {
    for (const p of posts) {
      if (p.url) {
        const d = await soft(() => step("getPost", { url: p.url }), warn(`post ${p.url}`));
        if (d) p.detail = d;
      }
    }
  }

  let n = 0;
  let skipped = 0;
  const hashes = new Set<string>();
  const grab = async (mediaUrl: string): Promise<string | null> => {
    try {
      const r = await fetchBody(mediaUrl, { max: MAX_MEDIA_BYTES, timeout: 60000, allow: isMediaHost });
      const e = r.status === 200 && !r.truncated ? mediaExt(r.body) : null;
      if (!e) throw new Error("not jpg/png/webp/mp4, or over 15 MB");
      const sha = createHash("sha1").update(r.body).digest("hex");
      if (hashes.has(sha)) throw new Error("duplicate");
      hashes.add(sha);
      const fileName = `${String(++n).padStart(2, "0")}.${e}`;
      writeFileSync(join(folder, "media", fileName), r.body);
      return `media/${fileName}`;
    } catch (e: any) {
      skipped++;
      warnings.push(`media skipped (${e?.message || String(e)}): ${mediaUrl}`);
      return null;
    }
  };

  for (const p of posts) {
    p.files = [];
    const urls = (p.detail?.media?.length ? p.detail.media.map((m: any) => m.url) : [p.thumbUrl]).filter(Boolean) as string[];
    for (const mediaUrl of urls) {
      if (n >= maxMedia) break;
      const f = await grab(mediaUrl);
      if (f) p.files.push(f);
    }
  }

  const savedAt = new Date().toISOString();
  writeFileSync(join(folder, "profile.json"), JSON.stringify({ ...profile, savedAt }, null, 2));
  writeFileSync(join(folder, "posts.json"), JSON.stringify(posts, null, 2));
  writeFileSync(join(folder, "profile.md"), profileMarkdown(profile, posts));
  return { folder, posts: posts.length, media: n, mediaSkipped: skipped, screenshot: !!shot, warnings };
}

function instagramProfileUrl(value: unknown): string {
  if (typeof value !== "string") throw new Error("Instagram profile URL is required");
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Invalid Instagram profile URL"); }
  const parts = url.pathname.split("/").filter(Boolean);
  const reserved = new Set(["accounts", "challenge", "checkpoint", "direct", "explore", "p", "reel", "reels", "stories", "tv", "about", "developer", "legal"]);
  if (url.protocol !== "https:" || !["instagram.com", "www.instagram.com"].includes(url.hostname.toLowerCase()) || url.username || url.password || url.port || parts.length !== 1 || !/^[a-zA-Z0-9._]{1,30}$/.test(parts[0]!) || reserved.has(parts[0]!.toLowerCase())) throw new Error("Provide an HTTPS Instagram profile URL, for example https://www.instagram.com/username/");
  return `https://www.instagram.com/${parts[0]}/`;
}

function profileUrl(value: unknown): string {
  if (typeof value !== "string") throw new Error("Instagram or Facebook profile URL is required");
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Invalid Instagram or Facebook profile URL"); }
  const host = url.hostname.toLowerCase();
  if (["instagram.com", "www.instagram.com"].includes(host)) return instagramProfileUrl(value);
  const facebookHosts = ["facebook.com", "www.facebook.com", "m.facebook.com", "mbasic.facebook.com", "web.facebook.com", "fb.com", "www.fb.com"];
  const parts = url.pathname.split("/").filter(Boolean);
  const reserved = new Set(["login", "checkpoint", "challenge", "messages", "watch", "reel", "reels", "groups", "events", "marketplace", "share", "photo", "photos", "posts", "videos", "people", "pages", "settings", "help", "home.php", "login.php", "notifications", "friends", "search", "profile.php"]);
  if (url.protocol !== "https:" || !facebookHosts.includes(host) || url.username || url.password || url.port) throw new Error("Provide an HTTPS Instagram or Facebook profile URL");
  if (parts.length === 1 && parts[0]!.toLowerCase() === "profile.php") {
    const ids = url.searchParams.getAll("id");
    if (ids.length !== 1 || !/^\d+$/.test(ids[0]!)) throw new Error("Facebook profile.php URL requires one numeric id");
    return `https://www.facebook.com/profile.php?id=${ids[0]}`;
  }
  const slug = parts.length === 1 && /^[a-zA-Z0-9._-]{1,100}$/.test(parts[0]!) && !reserved.has(parts[0]!.toLowerCase());
  const named = parts.length === 3 && ["people", "pages"].includes(parts[0]!.toLowerCase()) && /^[a-zA-Z0-9._-]{1,100}$/.test(parts[1]!) && /^\d+$/.test(parts[2]!);
  if (!slug && !named) throw new Error("Provide an HTTPS Instagram or Facebook profile URL");
  return `https://www.facebook.com/${parts.join("/")}`;
}

function postUrl(value: unknown): string {
  if (typeof value !== "string") throw new Error("Instagram or Facebook post URL is required");
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Invalid Instagram or Facebook post URL"); }
  const host = url.hostname.toLowerCase();
  const parts = url.pathname.split("/").filter(Boolean);
  if (url.protocol !== "https:" || url.username || url.password || url.port) {
    throw new Error("Provide an HTTPS Instagram or Facebook post URL");
  }

  if (["instagram.com", "www.instagram.com"].includes(host)) {
    if (parts.length !== 2 || !["p", "reel"].includes(parts[0]!) || !/^[a-zA-Z0-9_-]{1,64}$/.test(parts[1]!)) {
      throw new Error("Provide an HTTPS Instagram post or reel URL, for example https://www.instagram.com/p/ID/");
    }
    return `https://www.instagram.com/${parts[0]}/${parts[1]}/`;
  }

  const facebookHosts = ["facebook.com", "www.facebook.com", "m.facebook.com", "mbasic.facebook.com", "web.facebook.com", "fb.com", "www.fb.com"];
  if (facebookHosts.includes(host)) {
    const idPattern = /^[a-zA-Z0-9._-]{1,100}$/;
    if (parts.length === 1 && ["permalink.php", "story.php"].includes(parts[0]!.toLowerCase())) {
      const fbid = url.searchParams.get("story_fbid");
      const uid = url.searchParams.get("id");
      if (!fbid || !uid || !/^\d+$/.test(uid) || !idPattern.test(fbid)) {
        throw new Error("Facebook permalink requires story_fbid and numeric id");
      }
      return `https://www.facebook.com/permalink.php?story_fbid=${fbid}&id=${uid}`;
    }
    if (parts.length === 1 && parts[0]!.toLowerCase() === "photo.php") {
      const fbid = url.searchParams.get("fbid");
      if (!fbid || !/^\d+$/.test(fbid)) throw new Error("Facebook photo.php requires numeric fbid");
      return `https://www.facebook.com/photo.php?fbid=${fbid}`;
    }
    if (parts.length === 1 && parts[0]!.toLowerCase() === "watch") {
      const v = url.searchParams.get("v");
      if (!v || !idPattern.test(v)) throw new Error("Facebook watch URL requires video parameter v");
      return `https://www.facebook.com/watch/?v=${v}`;
    }
    if (parts.length === 2 && ["posts", "reel", "reels"].includes(parts[0]!.toLowerCase()) && idPattern.test(parts[1]!)) {
      const type = parts[0]!.toLowerCase() === "reels" ? "reel" : parts[0]!.toLowerCase();
      return `https://www.facebook.com/${type}/${parts[1]}/`;
    }
    if (parts.length === 3 && ["posts", "videos", "photos"].includes(parts[1]!.toLowerCase()) && idPattern.test(parts[0]!) && idPattern.test(parts[2]!)) {
      return `https://www.facebook.com/${parts[0]}/${parts[1].toLowerCase()}/${parts[2]}/`;
    }
  }

  throw new Error("Provide an HTTPS Instagram or Facebook post URL");
}

function upsertProfileContact(db: Database, value: unknown, requestedUrl: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid social profile result");
  const profile = value as Record<string, any>;
  const canonical = profileUrl(requestedUrl);
  const parsed = new URL(canonical);
  const platform = parsed.hostname === "www.instagram.com" ? "ig" : "fb";
  if (profile.platform !== platform || typeof profile.url !== "string" || profileUrl(profile.url).toLowerCase() !== canonical.toLowerCase()) throw new Error("Social profile result does not match requested profile");
  const path = parsed.pathname.replace(/^\/+|\/+$/g, "");
  const rel = platform === "fb" && path.toLowerCase() === "profile.php" ? `${path}?id=${parsed.searchParams.get("id")}` : path;
  const id = `${platform}:${rel.toLowerCase()}`;
  const row = db.query("SELECT data FROM contacts WHERE id = ?").get(id) as { data: string } | null;
  const existing = row ? JSON.parse(row.data) : null;
  const fields = {
    id, platform, url: `${parsed.origin}/${rel}`, username: profile.username,
    name: profile.name, bio: profile.bio, website: profile.website, category: profile.category,
    followers: profile.followers, following: profile.following, postsCount: profile.postsCount,
    verified: profile.verified, private: profile.private, isBusiness: profile.isBusiness,
    email: profile.contact?.email, phone: profile.contact?.phone,
  };
  const present = Object.fromEntries(Object.entries(fields).filter(([, value]) => value != null && value !== ""));
  const now = new Date().toISOString();
  const contact = existing ? { ...existing, ...present, id, firstSeen: existing.firstSeen, status: existing.status, lastSeen: now } : { status: "new", firstSeen: now, ...present, id, lastSeen: now };
  db.query("INSERT INTO contacts (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data=excluded.data").run(id, JSON.stringify(contact));
}

function validateJob(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Job must be an object");
  const job = value as { action?: unknown; args?: unknown; key?: unknown; notBefore?: unknown };
  if (typeof job.action !== "string" || !actions.has(job.action)) throw new Error("Unknown or restricted action");
  if (!job.args || typeof job.args !== "object" || Array.isArray(job.args)) throw new Error("--args must be a JSON object");
  if (job.action === "readPage") {
    const args = job.args as Record<string, unknown>;
    if (Object.keys(args).some((key) => key !== "maxLines") || (args.maxLines !== undefined && (!Number.isInteger(args.maxLines) || Number(args.maxLines) < 1 || Number(args.maxLines) > 1000))) throw new Error("readPage maxLines must be an integer from 1 to 1000");
  }
  if (job.action === "snapshot" && Object.keys(job.args as object).length) throw new Error("snapshot does not take arguments");
  if (job.action === "getProfile") {
    const args = job.args as Record<string, unknown>;
    if (Object.keys(args).some((key) => key !== "url")) throw new Error("getProfile accepts only a profile URL");
    args.url = profileUrl(args.url);
  }
  if (job.action === "getPosts") {
    const args = job.args as Record<string, unknown>;
    if (Object.keys(args).some((key) => key !== "url" && key !== "limit")) throw new Error("getPosts accepts only url and limit");
    args.url = profileUrl(args.url);
    if (args.limit !== undefined && (!Number.isInteger(args.limit) || Number(args.limit) < 1 || Number(args.limit) > 100)) throw new Error("Post limit must be an integer from 1 to 100");
  }
  if (job.action === "getPost") {
    const args = job.args as Record<string, unknown>;
    if (Object.keys(args).some((key) => key !== "url" && key !== "download")) throw new Error("getPost accepts only url and download");
    args.url = postUrl(args.url);
    if (args.download !== undefined && typeof args.download !== "boolean") throw new Error("--download must be a boolean");
  }
  if (job.action === "getComments") {
    const args = job.args as Record<string, unknown>;
    if (Object.keys(args).some((key) => key !== "url" && key !== "limit")) throw new Error("getComments accepts only url and limit");
    args.url = postUrl(args.url);
    if (args.limit !== undefined && (!Number.isInteger(args.limit) || Number(args.limit) < 1 || Number(args.limit) > 500)) throw new Error("Comment limit must be an integer from 1 to 500");
  }
  if (job.action === "screenshot") {
    const args = job.args as Record<string, unknown>;
    for (const key of Object.keys(args)) {
      if (!["url", "selector", "target", "path"].includes(key)) throw new Error(`Unknown screenshot option: ${key}`);
    }
    if (args.url !== undefined && (typeof args.url !== "string" || !args.url)) throw new Error("Screenshot url must be a nonempty string");
    if (args.selector !== undefined && (typeof args.selector !== "string" || !args.selector)) throw new Error("Screenshot selector must be a nonempty string");
    if (args.target !== undefined && !["viewport", "post", "profile"].includes(String(args.target))) throw new Error("Screenshot target must be viewport, post or profile");
    if (args.path !== undefined) {
      if (typeof args.path !== "string" || !args.path) throw new Error("Screenshot path must be a nonempty string");
      resolveHomePath(args.path);
    }
  }
  if (job.action === "search") {
    const args = job.args as Record<string, unknown>;
    for (const key of Object.keys(args)) {
      if (!["platform", "query", "type", "limit"].includes(key)) throw new Error(`Unknown search option: ${key}`);
    }
    if (typeof args.platform !== "string") throw new Error("Search platform is required");
    const norm = { ig: "ig", instagram: "ig", fb: "fb", facebook: "fb" }[args.platform.toLowerCase()];
    if (!norm) throw new Error("Search platform must be ig or fb");
    args.platform = norm;
    if (typeof args.query !== "string" || !args.query.trim() || args.query.length > 200) throw new Error("Search query must be a string between 1 and 200 characters");
    if (args.type !== undefined && !["users", "hashtag", "pages", "places"].includes(String(args.type))) throw new Error("Search type must be users, hashtag, pages or places");
    if (args.limit !== undefined && (!Number.isInteger(args.limit) || Number(args.limit) < 1 || Number(args.limit) > 50)) throw new Error("Search limit must be an integer from 1 to 50");
  }
  if (job.action === "downloadProfile") {
    const args = job.args as Record<string, unknown>;
    for (const key of Object.keys(args)) {
      if (!["url", "limit", "details", "maxMedia", "dir"].includes(key)) throw new Error(`Unknown downloadProfile option: ${key}`);
    }
    if (typeof args.url !== "string") throw new Error("Profile URL is required");
    args.url = profileUrl(args.url);
    if (args.limit !== undefined && (!Number.isInteger(args.limit) || Number(args.limit) < 1 || Number(args.limit) > 100)) throw new Error("Limit must be an integer from 1 to 100");
    if (args.maxMedia !== undefined && (!Number.isInteger(args.maxMedia) || Number(args.maxMedia) < 0 || Number(args.maxMedia) > 300)) throw new Error("maxMedia must be an integer from 0 to 300");
    if (args.details !== undefined && typeof args.details !== "boolean") throw new Error("details must be a boolean");
    if (args.dir !== undefined) {
      if (typeof args.dir !== "string" || !args.dir) throw new Error("dir must be a nonempty string");
      resolveHomePath(args.dir);
    }
  }
  if (job.key !== undefined && (typeof job.key !== "string" || !job.key)) throw new Error("--key must be a nonempty string");
  if (job.notBefore !== undefined && (typeof job.notBefore !== "string" || !Number.isFinite(Date.parse(job.notBefore)))) throw new Error("--not-before must be a valid ISO date");
  return job;
}

async function status(): Promise<{ running: boolean; pid?: number; version?: string; extension?: unknown; halted?: unknown; extensionUrl?: string; portSource?: string }> {
  return new Promise((resolve) => {
    const socket = createConnection(socketPath);
    let data = "";
    const timer = setTimeout(() => { socket.destroy(); resolve({ running: false }); }, 1000);
    socket.once("error", () => { clearTimeout(timer); resolve({ running: false }); });
    socket.on("data", (chunk) => {
      data += chunk.toString();
      if (!data.includes("\n")) return;
      clearTimeout(timer);
      socket.destroy();
      try {
        const response = JSON.parse(data.split("\n")[0]!);
        if (response.identity === identity && Number.isInteger(response.pid) && response.pid > 0) {
          resolve({ running: true, pid: response.pid, version: response.version, extension: response.extension, halted: response.halted, extensionUrl: response.extensionUrl, portSource: response.portSource });
          return;
        }
      } catch { /* not a socmedia response */ }
      resolve({ running: false });
    });
    socket.once("end", () => { clearTimeout(timer); resolve({ running: false }); });
  });
}

async function start() {
  const existing = await status();
  if (existing.running) return existing;
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const child = spawn(process.execPath, [import.meta.path, "--service-daemon"], {
    detached: true, stdio: "ignore", env: process.env,
  });
  child.unref();
  for (let i = 0; i < 100; i++) {
    const current = await status();
    if (current.running) return current;
    await Bun.sleep(30);
  }
  throw new Error("Service did not start; check the state directory and existing socket or lock");
}

async function stop() {
  if (!(await status()).running) return { running: false };
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection(socketPath);
    let data = "";
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("Service stop timed out")); }, 1000);
    socket.once("error", (error) => { clearTimeout(timer); reject(error); });
    socket.on("data", (chunk) => {
      data += chunk.toString();
      if (!data.includes("\n")) return;
      try {
        const greeting = JSON.parse(data.split("\n")[0]!);
        if (greeting.identity !== identity) throw new Error("Not a socmedia service");
        clearTimeout(timer);
        socket.end("stop\n", () => resolve());
      } catch (error) { clearTimeout(timer); socket.destroy(); reject(error); }
    });
  });
  for (let i = 0; i < 100; i++) {
    if (!(await status()).running) return { running: false };
    await Bun.sleep(30);
  }
  throw new Error("Service did not stop");
}

async function queueRequest(command: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let data = "";
    let identified = false;
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("Service request timed out")); }, 15000);
    socket.once("error", (error) => { clearTimeout(timer); reject(error); });
    socket.on("data", (chunk) => {
      data += chunk.toString();
      while (data.includes("\n")) {
        const end = data.indexOf("\n");
        const line = data.slice(0, end);
        data = data.slice(end + 1);
        try {
          const message = JSON.parse(line);
          if (!identified) {
            if (message.identity !== identity) throw new Error("Not a socmedia service");
            identified = true;
            socket.write(command + "\n");
          } else {
            clearTimeout(timer); socket.destroy();
            if (message.error && !message.status) reject(new Error(message.error)); else resolve(message);
            return;
          }
        } catch (error) { clearTimeout(timer); socket.destroy(); reject(error); return; }
      }
    });
    socket.once("end", () => { clearTimeout(timer); reject(new Error("Service closed the queue request")); });
  });
}

async function runPageJob(action: "snapshot" | "readPage" | "getProfile" | "getComments" | "getPosts" | "getPost" | "screenshot" | "search", args: Record<string, unknown>): Promise<unknown> {
  const current = await status();
  if (!current.running) throw new Error("Service not running");
  if (current.halted) {
    const reason = (current.halted as { reason?: string }).reason || "security challenge";
    throw new Error(`HALT: ${reason}; resolve it in Chrome and run service resume`);
  }
  const extension = current.extension as { connected?: boolean; compatible?: boolean } | undefined;
  if (!extension?.connected) throw new Error("Extension not connected");
  if (!extension.compatible) throw new Error("Extension version incompatible");
  const created = await queueRequest(`queue enqueue ${JSON.stringify({ action, args })}`) as { id: number };
  const deadline = Date.now() + (action === "getComments" || action === "getPosts" || action === "getPost" || action === "search" ? 75000 : action === "getProfile" ? 60000 : 30000);
  while (Date.now() < deadline) {
    let job = await queueRequest(`queue get ${created.id}`) as { status: string; result?: unknown; error?: string | { code?: string; reason?: string } };
    if (!["done", "failed", "cancelled"].includes(job.status)) {
      const state = await status();
      if (state.halted) {
        // HALT and the job result are persisted together; status can observe them
        // after the earlier job read, so read the job again before reporting it.
        job = await queueRequest(`queue get ${created.id}`) as typeof job;
        if (!["done", "failed", "cancelled"].includes(job.status)) throw new Error(`Job ${created.id} is ${job.status}; resolve the challenge and run service resume`);
      }
      if (!state.running) throw new Error(`Service stopped; inspect job ${created.id} after restarting`);
    }
    if (job.status === "done") return job.result;
    if (job.status === "failed" || job.status === "cancelled") {
      if (typeof job.error === "object" && job.error?.code === "HALT") throw new Error(`HALT: ${job.error.reason}; resolve it in Chrome and run service resume`);
      throw new Error(`Job ${created.id}: ${typeof job.error === "object" ? job.error?.reason : job.error || job.status}`);
    }
    await Bun.sleep(50);
  }
  throw new Error(`Job ${created.id} still pending; inspect it with queue get`);
}

if (Bun.argv[2] === "--service-daemon") {
  const libc = dlopen(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  });
  const lockFd = openSync(lockPath, "a", 0o600);
  if (libc.symbols.flock(lockFd, 2 | 4) !== 0) { closeSync(lockFd); process.exit(1); }
  // The kernel releases the exclusive lock if this process crashes. Only its holder
  // may remove a stale socket, and a live unrelated listener must be left alone.
  try {
    if (!lstatSync(socketPath).isSocket()) throw new Error("service path is not a socket");
    await new Promise<void>((resolve, reject) => {
      const probe = createConnection(socketPath);
      probe.once("connect", () => { probe.destroy(); reject(new Error("socket already in use")); });
      probe.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "ECONNREFUSED" || error.code === "ENOENT") resolve(); else reject(error);
      });
    });
    rmSync(socketPath, { force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") { closeSync(lockFd); process.exit(1); }
  }
  const db = new Database(join(stateDir, "state.sqlite"));
  db.run("CREATE TABLE IF NOT EXISTS jobs (id INTEGER PRIMARY KEY, data TEXT NOT NULL)");
  db.run("CREATE TABLE IF NOT EXISTS contacts (id TEXT PRIMARY KEY, data TEXT NOT NULL)");
  db.run("CREATE TABLE IF NOT EXISTS service_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const haltRow = db.query("SELECT value FROM service_state WHERE key = 'halted'").get() as { value: string } | null;
  let halted: { code: string; reason: string } | null = haltRow ? JSON.parse(haltRow.value) : null;
  db.run("UPDATE jobs SET data = json_set(data, '$.status', 'queued') WHERE json_extract(data, '$.action') IN ('readPage','snapshot','getProfile','getComments','getPosts','getPost','screenshot','search','downloadProfile') AND json_extract(data, '$.status') = 'running'");
  type ExtensionData = { token: string; challenge?: { clientNonce: string; serverNonce: string; version: string } };
  let extensionSocket: Bun.ServerWebSocket<ExtensionData> | null = null;
  let connectedVersion: string | null = null;
  const pending = new Map<string, { ws: Bun.ServerWebSocket<ExtensionData>; finish: (reply: unknown) => void | Promise<void>; timer: ReturnType<typeof setTimeout> }>();
  let browserBusy = false;
  let workerWake: ReturnType<typeof setTimeout> | undefined;
  const extensionTimeout = Number(process.env.SOCMEDIA_EXTENSION_TIMEOUT_MS ?? "10000");
  if (!Number.isInteger(extensionTimeout) || extensionTimeout < 1 || extensionTimeout > 12000) throw new Error("SOCMEDIA_EXTENSION_TIMEOUT_MS must be 1-12000");
  const portConfig = effectivePort();
  const port = portConfig.port;
  const extensionServer = Bun.serve<ExtensionData>({
    hostname: "127.0.0.1", port,
    fetch(request, server) {
      if (new URL(request.url).pathname !== "/extension") return new Response("Not found", { status: 404 });
      try {
        const pairing = JSON.parse(readFileSync(pairingPath, "utf8"));
        if (!/^[a-p]{32}$/.test(pairing.id) || !/^[a-f0-9]{64}$/.test(pairing.token) || request.headers.get("origin") !== `chrome-extension://${pairing.id}`) return new Response("Forbidden", { status: 403 });
        if (!server.upgrade(request, { data: { token: pairing.token } })) return new Response("Upgrade required", { status: 400 });
      } catch { return new Response("Forbidden", { status: 403 }); }
    },
    websocket: {
      message(ws, message) {
        try {
          const hello = JSON.parse(String(message));
          if (hello.type === "result" && ws === extensionSocket) {
            const request = pending.get(hello.id);
            if (!request || request.ws !== ws) return;
            pending.delete(hello.id); clearTimeout(request.timer);
            if (hello.error?.code === "HALT" && typeof hello.error.reason === "string" && hello.error.reason.length > 0 && hello.error.reason.length <= 500) request.finish({ halt: { code: "HALT", reason: hello.error.reason } });
            else request.finish(hello.error ? { error: String(hello.error) } : hello.result);
            return;
          }
          if (hello.type === "hello" && !ws.data.challenge && typeof hello.version === "string" && /^[a-f0-9]{64}$/.test(hello.clientNonce)) {
            const challenge = { version: hello.version, clientNonce: hello.clientNonce, serverNonce: randomBytes(32).toString("hex") };
            ws.data.challenge = challenge;
            const proof = createHmac("sha256", Buffer.from(ws.data.token, "hex")).update(`server:${challenge.clientNonce}:${challenge.serverNonce}:${challenge.version}`).digest("hex");
            ws.send(JSON.stringify({ type: "challenge", serverNonce: challenge.serverNonce, proof }));
            return;
          }
          const challenge = ws.data.challenge;
          ws.data.challenge = undefined;
          if (!challenge || hello.type !== "authenticate" || typeof hello.proof !== "string" || !/^[a-f0-9]{64}$/.test(hello.proof)) { ws.close(1008, "Authentication failed"); return; }
          const expected = createHmac("sha256", Buffer.from(ws.data.token, "hex")).update(`client:${challenge.clientNonce}:${challenge.serverNonce}:${challenge.version}`).digest();
          if (!timingSafeEqual(Buffer.from(hello.proof, "hex"), expected)) { ws.close(1008, "Authentication failed"); return; }
          if (extensionSocket && extensionSocket !== ws) extensionSocket.close(1000, "Replaced");
          extensionSocket = ws;
          connectedVersion = challenge.version;
          ws.send(JSON.stringify({ type: "hello", version: extensionVersion, compatible: compatibleVersion(challenge.version) }));
          queueMicrotask(pump);
        } catch { ws.close(1008, "Invalid hello"); }
      },
      close(ws) {
        if (extensionSocket === ws) { extensionSocket = null; connectedVersion = null; }
        for (const [id, request] of pending) if (request.ws === ws) {
          pending.delete(id); clearTimeout(request.timer); request.finish({ error: "Extension disconnected" });
        }
      },
    },
  });
  function pump() {
    if (workerWake) { clearTimeout(workerWake); workerWake = undefined; }
    if (halted || !extensionSocket || !connectedVersion || !compatibleVersion(connectedVersion)) return;
    const now = Date.now();
    let wakeAt = Infinity;
    const compRow = (db.query("SELECT id, data FROM jobs WHERE json_extract(data, '$.action') = 'downloadProfile' AND json_extract(data, '$.status') = 'queued' ORDER BY id").all() as { id: number; data: string }[]).find((candidate) => {
      const job = JSON.parse(candidate.data);
      const at = job.notBefore ? Date.parse(job.notBefore) : 0;
      if (at > now) { wakeAt = Math.min(wakeAt, at); return false; }
      return true;
    });
    if (compRow) {
      const compJob = JSON.parse(compRow.data);
      compJob.status = "running";
      db.query("UPDATE jobs SET data = ? WHERE id = ?").run(JSON.stringify(compJob), compRow.id);
      (async () => {
        try {
          const step = async (action: string, args: Record<string, unknown>) => {
            const sub = validateJob({ action, args });
            const subRow = db.query("INSERT INTO jobs (data) VALUES (?) RETURNING id").get(JSON.stringify({ ...sub, status: "queued", parent: compRow.id })) as { id: number };
            queueMicrotask(pump);
            const deadline = Date.now() + 75000;
            while (Date.now() < deadline) {
              const check = db.query("SELECT data FROM jobs WHERE id = ?").get(subRow.id) as { data: string };
              const current = JSON.parse(check.data);
              if (current.status === "done") return current.result;
              if (current.status === "failed") {
                if (current.error?.code === "HALT") throw new Error(`HALT: ${current.error.reason}`);
                throw new Error(typeof current.error === "object" ? current.error?.reason : current.error);
              }
              await Bun.sleep(50);
            }
            throw new Error(`Subtask ${action} timed out`);
          };
          const res = await downloadProfile(compJob.args, step);
          compJob.status = "done"; compJob.result = res;
        } catch (e: any) {
          compJob.status = "failed"; compJob.error = e?.message || String(e);
        } finally {
          db.query("UPDATE jobs SET data = ? WHERE id = ?").run(JSON.stringify(compJob), compRow.id);
          queueMicrotask(pump);
        }
      })();
    }
    if (browserBusy) return;
    const rows = db.query("SELECT id, data FROM jobs WHERE json_extract(data, '$.action') IN ('readPage','snapshot','getProfile','getComments','getPosts','getPost','screenshot','search') AND json_extract(data, '$.status') = 'queued' ORDER BY id").all() as { id: number; data: string }[];
    const row = rows.find((candidate) => {
      const job = JSON.parse(candidate.data);
      const at = job.notBefore ? Date.parse(job.notBefore) : 0;
      if (at > now) { wakeAt = Math.min(wakeAt, at); return false; }
      return true;
    });
    if (!row) {
      if (Number.isFinite(wakeAt)) workerWake = setTimeout(pump, Math.min(wakeAt - now, 2 ** 31 - 1));
      return;
    }
    const job = JSON.parse(row.data);
    job.status = "running";
    db.query("UPDATE jobs SET data = ? WHERE id = ?").run(JSON.stringify(job), row.id);
    browserBusy = true;
    const ws = extensionSocket;
    const id = randomBytes(16).toString("hex");
    const finish = async (reply: unknown) => {
      const halt = reply && typeof reply === "object" && "halt" in reply ? (reply as { halt: { code: string; reason: string } }).halt : null;
      const error = reply && typeof reply === "object" && "error" in reply ? String((reply as { error: unknown }).error) : null;
      if (halt) { halted = halt; job.status = "failed"; job.error = halt; }
      else if (error === "Extension disconnected") { job.status = "queued"; }
      else if (error) { job.status = "failed"; job.error = error; }
      else {
        let finalResult: unknown = reply;
        if (job.action === "getPost" && job.args?.download) {
          try { finalResult = await downloadPostMedia(reply, job.args.url); } catch {}
        } else if (job.action === "screenshot") {
          try {
            const replyObj = reply as { dataUrl?: string; width?: number; height?: number; url?: string; truncated?: boolean };
            const buf = parseDataUrl(replyObj?.dataUrl);
            const from = (job.args as any)?.url || replyObj?.url;
            let platform = "web";
            if (from) {
              try {
                const u = new URL(from);
                if (u.hostname.includes("instagram.com")) platform = "ig";
                else if (u.hostname.includes("facebook.com") || u.hostname.includes("fb.com")) platform = "fb";
              } catch {}
            }
            const targetPath = (job.args as any)?.path ? resolveHomePath((job.args as any).path) : screenshotPath(platform, from);
            mkdirSync(dirname(targetPath), { recursive: true, mode: 0o700 });
            writeFileSync(targetPath, buf);
            finalResult = {
              path: targetPath,
              width: replyObj?.width ?? null,
              height: replyObj?.height ?? null,
              url: replyObj?.url ?? from ?? null,
              ...(replyObj?.truncated ? { truncated: true } : {}),
            };
          } catch (e: any) {
            job.status = "failed";
            job.error = e?.message || String(e);
            finalResult = undefined;
          }
        }
        if (job.status !== "failed") {
          job.status = "done";
          job.result = finalResult;
        }
      }
      try {
        db.transaction(() => {
          if (halt) db.query("INSERT INTO service_state (key, value) VALUES ('halted', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(halt));
          if (job.status === "done" && job.action === "getProfile") upsertProfileContact(db, reply, job.args.url);
          db.query("UPDATE jobs SET data = ? WHERE id = ?").run(JSON.stringify(job), row.id);
        })();
      } catch (error) {
        job.status = "failed"; job.error = `Contact upsert failed: ${error instanceof Error ? error.message : String(error)}`; delete job.result;
        db.query("UPDATE jobs SET data = ? WHERE id = ?").run(JSON.stringify(job), row.id);
      }
      browserBusy = false;
      queueMicrotask(pump);
    };
    const timeout = job.action === "getComments" ? Math.max(extensionTimeout, 60000) : job.action === "getProfile" ? Math.max(extensionTimeout, 45000) : extensionTimeout;
    const timer = setTimeout(() => { pending.delete(id); finish({ error: "Extension request timed out" }); }, timeout);
    pending.set(id, { ws, finish, timer });
    ws.send(JSON.stringify({ type: "request", id, action: job.action, args: job.args }));
  }
  const extensionStatus = () => ({ connected: extensionSocket !== null, version: connectedVersion, compatible: connectedVersion === null ? null : compatibleVersion(connectedVersion), port: extensionServer.port });
  const server = createServer((socket) => {
    socket.write(JSON.stringify({ identity, pid: process.pid, version: extensionVersion, extension: extensionStatus(), halted, extensionUrl: `ws://127.0.0.1:${extensionServer.port}/extension`, portSource: portConfig.source }) + "\n");
    let input = "";
    socket.on("data", (data) => {
      input += data.toString();
      if (!input.includes("\n")) return;
      const command = input.split("\n")[0];
      if (command === "stop") { socket.end(); shutdown(); }
      else if (command === "service resume") {
        db.query("DELETE FROM service_state WHERE key = 'halted'").run();
        halted = null;
        socket.end(JSON.stringify({ halted: null }) + "\n");
        queueMicrotask(pump);
      }
      else if (command === "tabs list" || command === "tabs clear" || command?.startsWith("tabs use ")) {
        if (browserBusy) { socket.end(JSON.stringify({ error: "Browser worker is busy" }) + "\n"); return; }
        let tabId: number | null = null;
        if (command.startsWith("tabs use ")) {
          const rawId = command.slice("tabs use ".length);
          tabId = Number(rawId);
          if (!/^(0|[1-9]\d*)$/.test(rawId) || !Number.isSafeInteger(tabId)) { socket.end(JSON.stringify({ error: "Tab ID must be a non-negative integer" }) + "\n"); return; }
        }
        if (!extensionSocket) { socket.end(JSON.stringify({ error: "Extension not connected" }) + "\n"); return; }
        if (!connectedVersion || !compatibleVersion(connectedVersion)) { socket.end(JSON.stringify({ error: "Extension version incompatible" }) + "\n"); return; }
        const id = randomBytes(16).toString("hex");
        const ws = extensionSocket;
        browserBusy = true;
        const finish = (reply: unknown) => { browserBusy = false; socket.end(JSON.stringify(reply) + "\n"); queueMicrotask(pump); };
        const timer = setTimeout(() => { pending.delete(id); finish({ error: "Extension request timed out" }); }, extensionTimeout);
        pending.set(id, { ws, finish, timer });
        ws.send(JSON.stringify(command === "tabs list" ? { type: "request", id, action: "tabs.list" } : { type: "request", id, action: "tabs.use", args: { tabId } }));
      }
      else if (command === "queue list") {
        const rows = db.query("SELECT id, data FROM jobs ORDER BY id DESC").all() as { id: number; data: string }[];
        socket.end(JSON.stringify({ jobs: rows.map((row) => ({ id: row.id, ...JSON.parse(row.data) })) }) + "\n");
      } else if (command?.startsWith("contacts list ")) {
        try {
          const filters = JSON.parse(command.slice("contacts list ".length));
          if (filters.status !== undefined && !contactStatuses.includes(filters.status)) throw new Error("Invalid contact status");
          if (filters.platform !== undefined && !["ig", "fb"].includes(filters.platform)) throw new Error("Invalid contact platform");
          const rows = db.query("SELECT data FROM contacts ORDER BY rowid").all() as { data: string }[];
          const contacts = rows.map((row) => JSON.parse(row.data)).filter((contact) => (!filters.status || contact.status === filters.status) && (!filters.platform || contact.platform === filters.platform));
          socket.end(JSON.stringify({ count: contacts.length, file: join(stateDir, "state.sqlite"), contacts }) + "\n");
        } catch (error) { socket.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) + "\n"); }
      } else if (command?.startsWith("contacts export ")) {
        try {
          const args = JSON.parse(command.slice("contacts export ".length));
          if (args.status !== undefined && !contactStatuses.includes(args.status)) throw new Error("Invalid contact status");
          if (args.platform !== undefined && !["ig", "fb"].includes(args.platform)) throw new Error("Invalid contact platform");
          const format = args.format ?? "csv";
          if (!["csv", "json", "jsonl"].includes(format)) throw new Error("Format must be csv, json or jsonl");
          const rows = db.query("SELECT data FROM contacts ORDER BY rowid").all() as { data: string }[];
          const contacts = rows.map((row) => JSON.parse(row.data)).filter((contact) => (!args.status || contact.status === args.status) && (!args.platform || contact.platform === args.platform));
          socket.end(JSON.stringify(exportContactFile(args.path, format, contacts)) + "\n");
        } catch (error) { socket.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) + "\n"); }
      } else if (command?.startsWith("contacts update ")) {
        try {
          const update = JSON.parse(command.slice("contacts update ".length));
          if (typeof update.id !== "string" || !update.id.trim()) throw new Error("Contact ID is required");
          if (update.status === undefined && update.note === undefined) throw new Error("Provide --status or --note");
          if (update.status !== undefined && !contactStatuses.includes(update.status)) throw new Error("Invalid contact status");
          if (update.note !== undefined && (typeof update.note !== "string" || update.note.length > 2000)) throw new Error("Contact note must be at most 2000 characters");
          const result = db.transaction(() => {
            const row = db.query("SELECT data FROM contacts WHERE id = ?").get(update.id) as { data: string } | null;
            if (!row) throw new Error(`No contact ${update.id}`);
            const contact = { ...JSON.parse(row.data), ...(update.status !== undefined && { status: update.status }), ...(update.note !== undefined && { note: update.note }), updatedAt: new Date().toISOString() };
            db.query("UPDATE contacts SET data = ? WHERE id = ?").run(JSON.stringify(contact), update.id);
            return contact;
          })();
          socket.end(JSON.stringify(result) + "\n");
        } catch (error) { socket.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) + "\n"); }
      } else if (command?.startsWith("queue get ")) {
        const id = Number(command.slice("queue get ".length));
        if (!Number.isSafeInteger(id) || id < 1) {
          socket.end(JSON.stringify({ error: "Job ID must be a positive integer" }) + "\n");
          return;
        }
        const row = db.query("SELECT id, data FROM jobs WHERE id = ?").get(id) as { id: number; data: string } | null;
        socket.end(JSON.stringify(row ? { id: row.id, ...JSON.parse(row.data) } : { error: `Job ${id} not found` }) + "\n");
      } else if (command?.startsWith("queue enqueue ")) {
        try {
          const job = validateJob(JSON.parse(command.slice("queue enqueue ".length)));
          const create = db.transaction(() => {
            if (job.key) {
              const existing = db.query("SELECT id, data FROM jobs WHERE json_extract(data, '$.key') = ? ORDER BY id DESC LIMIT 1").get(job.key as string) as { id: number; data: string } | null;
              if (existing) {
                const saved = JSON.parse(existing.data);
                if (saved.action !== job.action || !Bun.deepEquals(saved.args, job.args) || saved.notBefore !== job.notBefore) {
                  throw new Error(`Idempotency key conflict: ${job.key}`);
                }
                return { id: existing.id, ...saved };
              }
            }
            const data = JSON.stringify({ ...job, status: "queued", createdAt: new Date().toISOString() });
            const inserted = db.query("INSERT INTO jobs (data) VALUES (?)").run(data);
            return { id: Number(inserted.lastInsertRowid), ...JSON.parse(data) };
          });
          socket.end(JSON.stringify(create()) + "\n");
          queueMicrotask(pump);
        } catch (error) { socket.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) + "\n"); }
      } else if (command?.startsWith("queue cancel ")) {
        const id = Number(command.slice("queue cancel ".length));
        if (!Number.isSafeInteger(id) || id < 1) {
          socket.end(JSON.stringify({ error: "Job ID must be a positive integer" }) + "\n");
          return;
        }
        const cancel = db.transaction(() => {
          const row = db.query("SELECT id, data FROM jobs WHERE id = ?").get(id) as { id: number; data: string } | null;
          if (!row) return { error: `Job ${id} not found` };
          const job = JSON.parse(row.data);
          if (job.status === "cancelled") return { id: row.id, ...job };
          if (job.status !== "queued") return { error: `Job ${id} cannot be cancelled (status: ${job.status})` };
          job.status = "cancelled";
          db.query("UPDATE jobs SET data = ? WHERE id = ?").run(JSON.stringify(job), id);
          return { id: row.id, ...job };
        });
        socket.end(JSON.stringify(cancel()) + "\n");
      }
    });
  });
  server.on("error", () => { closeSync(lockFd); process.exit(1); });
  server.listen(socketPath);
  const shutdown = () => server.close(() => {
    extensionServer.stop(true);
    db.close();
    rmSync(socketPath, { force: true });
    closeSync(lockFd);
    process.exit(0);
  });
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
} else if (Bun.argv[2] === "--version") {
  console.log(extensionVersion);
} else if (Bun.argv.includes("--help")) {
  if (Bun.argv[2] === "service") {
    console.log("Usage: socmedia service <start|status|stop|resume> [--json]\n\nCommands:\n  start   Start the local service or return the running service\n  status  Show service, halted state and extension connection status\n  stop    Stop the local service; succeed if already stopped\n  resume  Resume the queue after manually resolving a login or security challenge\n\nOptions:\n  --json  Print the result as JSON\n  --help  Show this help message\n\nEnvironment:\n  SOCMEDIA_STATE_DIR             Service data directory\n  SOCMEDIA_EXTENSION_PORT        Overrides saved config port (default: 47842; 0 selects an available port)\n  SOCMEDIA_EXTENSION_TIMEOUT_MS  Extension request timeout in milliseconds (default: 10000, range: 1-12000; profile requests use at least 45000)\n\nPort changes apply after the service restarts.");
  } else if (Bun.argv[2] === "queue") {
    console.log("Usage: socmedia queue <list|get|cancel|enqueue> [options]\n\nCommands:\n  list              List saved queue jobs\n  get <id>          Show a job by its positive numeric ID\n  cancel <id>       Cancel a queued job by ID; cancelling twice returns the same job\n  enqueue <action>  Queue an action; readPage, snapshot and Instagram/Facebook getProfile execute\n\nOptions:\n  --args JSON       Action arguments as a JSON object (default: {})\n  --not-before TIME Earliest run time as an ISO date\n  --key KEY         Reuse the same job; changed action, args or time causes a key conflict\n  --json            Print the result as JSON\n  --help            Show this help message");
  } else if (Bun.argv[2] === "tabs") {
    console.log("Usage: socmedia tabs <list|use|clear> [options]\n\nCommands:\n  list         List Socmedia CLI group tabs and the selected tab\n  use <tabId>  Select an open Instagram, Facebook or YouTube tab by its numeric ID\n  clear        Clear the selected tab and return to the Socmedia CLI group\n\nOptions:\n  --json       Print the result as JSON\n  --help       Show this help message");
  } else if (Bun.argv[2] === "profile") {
    console.log("Usage: socmedia profile <get|posts|download> <url> [options]\n\nCommands:\n  get <url>         Read an Instagram or Facebook profile/page via its HTTPS URL\n  posts <url>       List posts from an Instagram or Facebook profile/page\n  download <url>    Collect profile, screenshot, posts and media into ~/socmedia-data\n\nOptions:\n  --limit N         With posts or download, maximum posts from 1 to 100 (default: 12)\n  --details         With download, fetch details of each post (default: true)\n  --no-details      With download, skip post detail fetch\n  --max-media N     With download, maximum media files from 0 to 300 (default: 50)\n  --dir PATH        With download, custom destination inside home\n  --background      With download, run in background via service queue\n  --json            Print the result as JSON\n  --help            Show this help message\n\nSuccessful profile reads update local contacts. Fields may be null or incomplete.");
  } else if (Bun.argv[2] === "contacts") {
    console.log("Usage: socmedia contacts <list|update|export> [options]\n\nCommands:\n  list              List locally stored contacts\n  update <id>       Update a contact by its ID; provide --status and/or --note\n  export            Export filtered contacts to a file inside home\n\nOptions:\n  --status STATUS   Filter list/export or set status: new, messaged, replied, won, rejected, skip\n  --platform NAME   Filter list/export by ig or fb\n  --note TEXT       Set note on update (maximum 2000 characters; empty clears it)\n  --format FORMAT   Export as csv, json or jsonl (default: csv)\n  --path PATH       Export destination inside home (default: ~/socmedia-data/contacts-<date>.<format>)\n  --json            Print the command result as JSON\n  --help            Show this help message\n\nInstagram and Facebook profile reads populate contacts; import is not implemented yet.");
  } else if (Bun.argv[2] === "post") {
    console.log("Usage: socmedia post <get|comments> <url> [options]\n\nCommands:\n  get <url>       Read a post from Instagram or Facebook\n  comments <url>  Read Instagram or Facebook post comments\n\nOptions:\n  --download      With get, download media files to ~/socmedia-data\n  --slides        Alias for --download\n  --limit N       With comments, maximum comments from 1 to 500 (default: 20)\n  --json          Print the result as JSON\n  --help          Show this help message\n\nExpands available comments through Chrome debugger and reads visible English UI; results may be incomplete.");
  } else if (Bun.argv[2] === "page") {
    console.log("Usage: socmedia page <read|snapshot> [options]\n\nCommands:\n  read            Queue and return visible page text and URL\n  snapshot        Queue and return visible interactive elements\n\nOptions:\n  --max-lines N   With read, limit output to 1-1000 lines (default: 200)\n  --json          Print the result as JSON\n  --help          Show this help message");
  } else if (Bun.argv[2] === "screenshot") {
    console.log("Usage: socmedia screenshot [options]\n\nOptions:\n  --url URL         Navigate to URL first\n  --selector SEL    CSS selector to crop\n  --target TARGET   viewport, post, or profile (default: viewport)\n  --path PATH       Output file destination inside home\n  --json            Print the result as JSON\n  --help            Show this help message");
  } else if (Bun.argv[2] === "search") {
    console.log("Usage: socmedia search <platform> <query> [options]\n\nSearch for profiles, pages, places or hashtags on Instagram or Facebook\n\nArguments:\n  platform       Social network: ig (instagram) or fb (facebook)\n  query          Search keyword or hashtag (1-200 characters)\n\nOptions:\n  --type TYPE    users, hashtag, pages, places (default: users)\n  --limit N      Maximum results from 1 to 50 (default: 20)\n  --json         Print the result as JSON\n  --help         Show this help message");
  } else if (Bun.argv[2] === "config") {
    console.log("Usage: socmedia config <get|set|unset> port [value] [--json]\n\nCommands:\n  get port          Show the effective port and configuration source\n  set port <value>  Save a port from 1 to 65535\n  unset port        Remove the saved port\n\nOptions:\n  --json            Print the result as JSON\n  --help            Show this help message\n\nSOCMEDIA_EXTENSION_PORT overrides the saved port; changes apply when the service restarts.");
  } else if (Bun.argv[2] === "extension") {
    console.log("Usage: socmedia extension <install|path|pair> [options]\n\nCommands:\n  install    Copy the extension to its stable state directory and show Chrome setup steps\n  path       Show the stable extension directory\n  pair       Generate a pairing secret for the Chrome extension\n\nOptions:\n  --open     With install, open chrome://extensions in Google Chrome\n  --id ID    With pair, set the Chrome extension ID\n  --json     Print the result as JSON; pairing output contains a sensitive secret\n  --help     Show this help message\n\nPairing replaces any previous pairing; restart the service to disconnect existing clients.");
  } else {
    console.log("Usage: socmedia [options]\n\nCommands:\n  service    Start or inspect the local service\n  queue      Inspect the service queue\n  extension  Pair the Chrome extension\n  tabs       Inspect extension work tabs\n  page       Inspect the work page\n  screenshot Take a screenshot of the work page\n  search     Search on Instagram or Facebook\n  post       Inspect a social post\n  profile    Read a social profile\n  contacts   List local contacts\n  config     Configure the service\n\nOptions:\n  --version  Show the CLI version\n  --help     Show this help message");
  }
} else if (Bun.argv[2] === "post" && Bun.argv[3] === "get") {
  try {
    const url = postUrl(Bun.argv[4]);
    const args: { url: string; download?: boolean } = { url };
    for (let i = 5; i < Bun.argv.length; i++) {
      const option = Bun.argv[i];
      if (option === "--json") continue;
      if (option === "--download" || option === "--slides") args.download = true;
      else throw new Error(`Unknown post option: ${option}`);
    }
    console.log(JSON.stringify(await runPageJob("getPost", args)));
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
} else if (Bun.argv[2] === "post" && Bun.argv[3] === "comments") {
  try {
    const url = postUrl(Bun.argv[4]);
    const args: { url: string; limit?: number } = { url };
    for (let i = 5; i < Bun.argv.length; i++) {
      const option = Bun.argv[i];
      if (option === "--json") continue;
      if (option !== "--limit") throw new Error(`Unknown post option: ${option}`);
      const value = Bun.argv[++i];
      if (!value || !/^[1-9]\d*$/.test(value) || Number(value) > 500) throw new Error("--limit must be an integer from 1 to 500");
      args.limit = Number(value);
    }
    console.log(JSON.stringify(await runPageJob("getComments", args)));
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
} else if (Bun.argv[2] === "contacts" && Bun.argv[3] === "export") {
  try {
    const args: { status?: string; platform?: string; format?: string; path?: string } = {};
    for (let i = 4; i < Bun.argv.length; i++) {
      const option = Bun.argv[i];
      if (option === "--json") continue;
      if (!["--status", "--platform", "--format", "--path"].includes(option ?? "")) throw new Error(`Unknown contacts option: ${option}`);
      const value = Bun.argv[++i];
      if (value === undefined || value === "" || value.startsWith("--")) throw new Error(`${option} requires a value`);
      if (option === "--status") { if (!contactStatuses.includes(value)) throw new Error("Invalid contact status"); args.status = value; }
      else if (option === "--platform") { if (!["ig", "fb"].includes(value)) throw new Error("--platform must be ig or fb"); args.platform = value; }
      else if (option === "--format") { if (!["csv", "json", "jsonl"].includes(value)) throw new Error("--format must be csv, json or jsonl"); args.format = value; }
      else args.path = value;
    }
    console.log(JSON.stringify(await queueRequest(`contacts export ${JSON.stringify(args)}`)));
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
} else if (Bun.argv[2] === "contacts" && Bun.argv[3] === "update") {
  try {
    const id = Bun.argv[4];
    if (!id || id.startsWith("--") || !id.trim()) throw new Error("Contact ID is required");
    const update: { id: string; status?: string; note?: string } = { id };
    for (let i = 5; i < Bun.argv.length; i++) {
      const option = Bun.argv[i];
      if (option === "--json") continue;
      if (option !== "--status" && option !== "--note") throw new Error(`Unknown contacts option: ${option}`);
      const value = Bun.argv[++i];
      if (value === undefined || ["--json", "--status", "--note"].includes(value)) throw new Error(`${option} requires a value`);
      if (option === "--status") {
        if (!contactStatuses.includes(value)) throw new Error("--status must be new, messaged, replied, won, rejected or skip");
        update.status = value;
      } else {
        if (value.length > 2000) throw new Error("--note must be at most 2000 characters");
        update.note = value;
      }
    }
    if (update.status === undefined && update.note === undefined) throw new Error("Provide --status or --note");
    console.log(JSON.stringify(await queueRequest(`contacts update ${JSON.stringify(update)}`)));
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
} else if (Bun.argv[2] === "contacts" && Bun.argv[3] === "list") {
  try {
    const filters: { status?: string; platform?: string } = {};
    for (let i = 4; i < Bun.argv.length; i++) {
      const option = Bun.argv[i];
      if (option === "--json") continue;
      if (option !== "--status" && option !== "--platform") throw new Error(`Unknown contacts option: ${option}`);
      const value = Bun.argv[++i];
      if (option === "--status") {
        if (!value || !contactStatuses.includes(value)) throw new Error("--status must be new, messaged, replied, won, rejected or skip");
        filters.status = value;
      } else {
        if (!value || !["ig", "fb"].includes(value)) throw new Error("--platform must be ig or fb");
        filters.platform = value;
      }
    }
    console.log(JSON.stringify(await queueRequest(`contacts list ${JSON.stringify(filters)}`)));
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
} else if (Bun.argv[2] === "profile" && Bun.argv[3] === "get") {
  try {
    if (Bun.argv.slice(5).some((option) => option !== "--json")) throw new Error("Unknown profile option");
    const url = profileUrl(Bun.argv[4]);
    console.log(JSON.stringify(await runPageJob("getProfile", { url })));
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
} else if (Bun.argv[2] === "profile" && Bun.argv[3] === "posts") {
  try {
    const url = profileUrl(Bun.argv[4]);
    const args: { url: string; limit?: number } = { url, limit: 12 };
    for (let i = 5; i < Bun.argv.length; i++) {
      const option = Bun.argv[i];
      if (option === "--json") continue;
      if (option !== "--limit") throw new Error(`Unknown profile option: ${option}`);
      const value = Bun.argv[++i];
      if (!value || !/^[1-9]\d*$/.test(value) || Number(value) > 100) throw new Error("--limit must be an integer from 1 to 100");
      args.limit = Number(value);
    }
    console.log(JSON.stringify(await runPageJob("getPosts", args)));
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
} else if (Bun.argv[2] === "profile" && Bun.argv[3] === "download") {
  try {
    const url = profileUrl(Bun.argv[4]);
    const args: { url: string; limit?: number; details?: boolean; maxMedia?: number; dir?: string } = { url, limit: 12, details: true, maxMedia: 50 };
    let background = false;
    for (let i = 5; i < Bun.argv.length; i++) {
      const option = Bun.argv[i];
      if (option === "--json") continue;
      if (option === "--background") {
        background = true;
      } else if (option === "--details") {
        args.details = true;
      } else if (option === "--no-details") {
        args.details = false;
      } else if (option === "--limit") {
        const val = Bun.argv[++i];
        if (!val || !/^[1-9]\d*$/.test(val) || Number(val) > 100) throw new Error("--limit must be an integer from 1 to 100");
        args.limit = Number(val);
      } else if (option === "--max-media") {
        const val = Bun.argv[++i];
        if (!val || !/^(0|[1-9]\d*)$/.test(val) || Number(val) > 300) throw new Error("--max-media must be an integer from 0 to 300");
        args.maxMedia = Number(val);
      } else if (option === "--dir") {
        const val = Bun.argv[++i];
        if (!val) throw new Error("Missing value for --dir");
        resolveHomePath(val);
        args.dir = val;
      } else throw new Error(`Unknown profile option: ${option}`);
    }
    if (background) {
      const job = validateJob({ action: "downloadProfile", args });
      const queued = await queueRequest(`queue enqueue ${JSON.stringify(job)}`) as { id: number };
      console.log(JSON.stringify({ queued: true, id: queued.id }));
    } else {
      console.log(JSON.stringify(await downloadProfile(args, (act, a) => runPageJob(act, a))));
    }
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
} else if (Bun.argv[2] === "page" && (Bun.argv[3] === "snapshot" || Bun.argv[3] === "read")) {
  try {
    const args: Record<string, number> = {};
    for (let i = 4; i < Bun.argv.length; i++) {
      const option = Bun.argv[i];
      if (option === "--json") continue;
      if (option === "--max-lines" && Bun.argv[3] === "read") {
        const value = Bun.argv[++i];
        if (!value || !/^[1-9]\d*$/.test(value) || Number(value) > 1000) throw new Error("--max-lines must be an integer from 1 to 1000");
        args.maxLines = Number(value);
      } else throw new Error(`Unknown page option: ${option}`);
    }
    console.log(JSON.stringify(await runPageJob(Bun.argv[3] === "read" ? "readPage" : "snapshot", args)));
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
} else if (Bun.argv[2] === "config") {
  try {
    const action = Bun.argv[3];
    if (Bun.argv[4] !== "port" || !["get", "set", "unset"].includes(action ?? "")) throw new Error("Use config get|set|unset port");
    const rest = Bun.argv.slice(action === "set" ? 6 : 5);
    if (rest.some((option) => option !== "--json")) throw new Error("Unknown config option");
    if (action === "set") {
      const value = Bun.argv[5];
      if (!value || !/^[1-9]\d*$/.test(value) || Number(value) > 65535) throw new Error("Port must be an integer from 1 to 65535");
      writeConfig({ ...readConfig(), port: Number(value) });
    } else if (action === "unset") {
      const config = readConfig(); delete config.port; writeConfig(config);
    }
    console.log(JSON.stringify({ ...effectivePort(), ...(action !== "get" && { note: "Changes apply after the service restarts" }) }));
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
} else if (Bun.argv[2] === "extension" && (Bun.argv[3] === "install" || Bun.argv[3] === "path")) {
  try {
    const options = Bun.argv.slice(4);
    const install = Bun.argv[3] === "install";
    if (options.some((option) => option !== "--json" && !(install && option === "--open"))) throw new Error("Unknown extension option");
    const result = install ? installExtension() : { path: extensionPath };
    if (install && options.includes("--open")) {
      if (process.platform !== "darwin") throw new Error("--open is currently supported on macOS only");
      const opened = spawnSync("open", ["-a", "Google Chrome", "chrome://extensions"]);
      if (opened.error || opened.status !== 0) throw new Error("Extension copied, but Chrome could not be opened; open chrome://extensions manually");
    }
    console.log(JSON.stringify(result));
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
} else if (Bun.argv[2] === "extension" && Bun.argv[3] === "pair") {
  try {
    if (Bun.argv[4] !== "--id" || !/^[a-p]{32}$/.test(Bun.argv[5] ?? "") || Bun.argv.slice(6).some((arg) => arg !== "--json")) throw new Error("Provide --id followed by the 32-character Chrome extension ID");
    const pairing = { id: Bun.argv[5]!, token: randomBytes(32).toString("hex") };
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const temporary = join(stateDir, `.pairing-${randomBytes(8).toString("hex")}`);
    try {
      writeFileSync(temporary, JSON.stringify(pairing), { mode: 0o600, flag: "wx" });
      renameSync(temporary, pairingPath);
    } finally { rmSync(temporary, { force: true }); }
    console.log(JSON.stringify(pairing));
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
} else if (Bun.argv[2] === "service" && Bun.argv[3] === "status") {
  console.log(JSON.stringify(await status()));
} else if (Bun.argv[2] === "service" && Bun.argv[3] === "start") {
  try { console.log(JSON.stringify(await start())); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
} else if (Bun.argv[2] === "service" && Bun.argv[3] === "stop") {
  try { console.log(JSON.stringify(await stop())); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
} else if (Bun.argv[2] === "service" && Bun.argv[3] === "resume") {
  try { console.log(JSON.stringify(await queueRequest("service resume"))); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
} else if (Bun.argv[2] === "tabs" && Bun.argv[3] === "list") {
  try { console.log(JSON.stringify(await queueRequest("tabs list"))); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
} else if (Bun.argv[2] === "tabs" && (Bun.argv[3] === "use" || Bun.argv[3] === "clear")) {
  try {
    const rawId = Bun.argv[4];
    if (Bun.argv[3] === "use" && (!rawId || !/^(0|[1-9]\d*)$/.test(rawId) || !Number.isSafeInteger(Number(rawId)))) throw new Error("Tab ID must be a non-negative integer");
    const rest = Bun.argv.slice(Bun.argv[3] === "use" ? 5 : 4);
    if (rest.some((arg) => arg !== "--json")) throw new Error("Unknown tabs option");
    console.log(JSON.stringify(await queueRequest(Bun.argv[3] === "use" ? `tabs use ${rawId}` : "tabs clear")));
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
} else if (Bun.argv[2] === "queue" && Bun.argv[3] === "list") {
  try { console.log(JSON.stringify(await queueRequest("queue list"))); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
} else if (Bun.argv[2] === "queue" && Bun.argv[3] === "enqueue") {
  try {
    const action = Bun.argv[4];
    let args: unknown = {};
    let key: string | undefined;
    let notBefore: string | undefined;
    for (let i = 5; i < Bun.argv.length; i++) {
      const option = Bun.argv[i];
      if (option === "--json") continue;
      if (!["--args", "--key", "--not-before"].includes(option ?? "") || !Bun.argv[i + 1]) throw new Error(`Invalid option or missing value: ${option}`);
      const value = Bun.argv[++i]!;
      if (option === "--args") { try { args = JSON.parse(value); } catch { throw new Error("--args must be a JSON object"); } }
      else if (option === "--key") key = value;
      else notBefore = value;
    }
    const job = validateJob({ action, args, key, notBefore });
    console.log(JSON.stringify(await queueRequest(`queue enqueue ${JSON.stringify(job)}`)));
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
} else if (Bun.argv[2] === "screenshot") {
  try {
    const args: { url?: string; selector?: string; target?: string; path?: string } = {};
    for (let i = 3; i < Bun.argv.length; i++) {
      const option = Bun.argv[i];
      if (option === "--json") continue;
      if (option === "--url") {
        const val = Bun.argv[++i];
        if (!val) throw new Error("Missing value for --url");
        args.url = val;
      } else if (option === "--selector") {
        const val = Bun.argv[++i];
        if (!val) throw new Error("Missing value for --selector");
        args.selector = val;
      } else if (option === "--target") {
        const val = Bun.argv[++i];
        if (!val || !["viewport", "post", "profile"].includes(val)) throw new Error("Screenshot target must be viewport, post or profile");
        args.target = val;
      } else if (option === "--path") {
        const val = Bun.argv[++i];
        if (!val) throw new Error("Missing value for --path");
        args.path = val;
      } else throw new Error(`Unknown screenshot option: ${option}`);
    }
    if (!args.target) args.target = "viewport";
    console.log(JSON.stringify(await runPageJob("screenshot", args)));
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
} else if (Bun.argv[2] === "search") {
  try {
    const platform = Bun.argv[3];
    const query = Bun.argv[4];
    if (!platform || !query || platform.startsWith("--") || query.startsWith("--")) throw new Error("Usage: socmedia search <platform> <query> [options]");
    const norm = { ig: "ig", instagram: "ig", fb: "fb", facebook: "fb" }[platform.toLowerCase()];
    if (!norm) throw new Error("Search platform must be ig or fb");
    const args: { platform: string; query: string; type?: string; limit?: number } = { platform: norm, query, type: "users", limit: 20 };
    for (let i = 5; i < Bun.argv.length; i++) {
      const option = Bun.argv[i];
      if (option === "--json") continue;
      if (option === "--type") {
        const val = Bun.argv[++i];
        if (!val || !["users", "hashtag", "pages", "places"].includes(val)) throw new Error("Search type must be users, hashtag, pages or places");
        args.type = val;
      } else if (option === "--limit") {
        const val = Bun.argv[++i];
        if (!val || !/^[1-9]\d*$/.test(val) || Number(val) > 50) throw new Error("--limit must be an integer from 1 to 50");
        args.limit = Number(val);
      } else throw new Error(`Unknown search option: ${option}`);
    }
    console.log(JSON.stringify(await runPageJob("search", args)));
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
} else if (Bun.argv[2] === "queue" && (Bun.argv[3] === "get" || Bun.argv[3] === "cancel")) {
  try {
    const id = Bun.argv[4];
    if (!id || !/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))) throw new Error("Job ID must be a positive integer");
    console.log(JSON.stringify(await queueRequest(`queue ${Bun.argv[3]} ${id}`)));
  }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}

export { isPrivateHost, isMediaHost, mediaExt, safeSeg, postId, postDir, downloadPostMedia, parseDataUrl, screenshotPath, resolveHomePath, profileDir, downloadProfile, profileMarkdown };
