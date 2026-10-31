import { closeSync, constants, existsSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export const isPrivateHost = (h: string) => /^(localhost|.*\.(local|internal|localdomain))$/i.test(h)
  || /^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h) || h.startsWith("[");

export const isMediaHost = (h: string) => /\.(cdninstagram\.com|fbcdn\.net)$/i.test(String(h));

export const NOT_VIDEO_BRANDS = /^(avif|avis|heic|heix|hevc|hevx|mif1|msf1|M4A |M4B )$/;
export function mediaExt(b: Buffer): "jpg" | "png" | "webp" | "mp4" | null {
  if (b.length < 12) return null;
  const h = b.toString("hex", 0, 4);
  if (h.startsWith("ffd8ff")) return "jpg";
  if (h === "89504e47") return "png";
  if (b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") return "webp";
  if (b.toString("latin1", 4, 8) === "ftyp" && !NOT_VIDEO_BRANDS.test(b.toString("latin1", 8, 12))) return "mp4";
  return null;
}

export function safeSeg(s: unknown, max = 60, keepCase = false): string | null {
  const raw = String(s ?? "").normalize("NFKC");
  const v = (keepCase ? raw : raw.toLowerCase()).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+/, "").slice(0, max).replace(/[-.]+$/, "");
  return v || (/[\p{L}\p{N}]/u.test(raw) ? `x-${createHash("sha1").update(raw).digest("hex").slice(0, 8)}` : null);
}

export function authorSeg(author: any): string {
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

export function postId(url: string): string | null {
  let x: URL;
  try { x = new URL(url); } catch { return null; }
  const q = x.searchParams.get("v") || x.searchParams.get("story_fbid") || x.searchParams.get("fbid");
  const segs = x.pathname.split("/").filter(Boolean);
  const i = segs.findIndex((s) => /^(p|reels?|tv|posts|videos)$/i.test(s));
  const id = q || (i >= 0 ? segs[i + 1] : segs.at(-1));
  const seg = safeSeg(id, 60, true);
  return seg && /[A-Z]/.test(seg) ? `${seg}-${createHash("sha1").update(id!).digest("hex").slice(0, 6)}` : seg;
}

export function postDir(post: any, url: string): string {
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

export const MAX_MEDIA_BYTES = 15 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 200 * 1024 * 1024;
export const mediaMax = (type?: string) => (type === "video" ? MAX_VIDEO_BYTES : MAX_MEDIA_BYTES);

export async function fetchBody(url: string, options: { max: number; timeout?: number; allow?: (h: string) => boolean; file?: string }) {
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

export async function downloadPostMedia(result: any, postUrl: string) {
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

export function resolveHomePath(inputPath: string): string {
  const home = resolve(homedir());
  const target = resolve(home, inputPath.replace(/^~(?=\/|$)/, home));
  const rel = relative(home, target);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("Path must be inside home");
  return target;
}

export const PNG_MAGIC = "89504e470d0a1a0a";
export function parseDataUrl(dataUrl: unknown): Buffer {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl ?? ""));
  if (!m) throw new Error("Extension returned no PNG data URL");
  const buf = Buffer.from(m[1], "base64");
  if (buf.length < 16 || buf.subarray(0, 8).toString("hex") !== PNG_MAGIC) throw new Error("Screenshot data is not a PNG");
  return buf;
}

export const stamp = (d = new Date()) => {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

export const slug = (s: unknown) => String(s || "").toLowerCase().normalize("NFKC").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "") || "page";

export function screenshotPath(platform: string, url?: string, now = new Date()): string {
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

export function profileDir(platform: string, username: string, baseDir?: string): string {
  const home = resolve(homedir());
  const root = baseDir ? resolveHomePath(baseDir) : join(home, "socmedia-data");
  const p = safeSeg(platform) || "_unknown";
  const u = safeSeg(username) || "_unknown";
  const target = resolve(root, p, u);
  const rel = relative(home, target);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("Path must be inside home");
  return target;
}

export function profileMarkdown(p: any, posts: any[]): string {
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

export function instagramProfileUrl(value: unknown): string {
  if (typeof value !== "string") throw new Error("Instagram profile URL is required");
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Invalid Instagram profile URL"); }
  const parts = url.pathname.split("/").filter(Boolean);
  const reserved = new Set(["accounts", "challenge", "checkpoint", "direct", "explore", "p", "reel", "reels", "stories", "tv", "about", "developer", "legal"]);
  if (url.protocol !== "https:" || !["instagram.com", "www.instagram.com"].includes(url.hostname.toLowerCase()) || url.username || url.password || url.port || parts.length !== 1 || !/^[a-zA-Z0-9._]{1,30}$/.test(parts[0]!) || reserved.has(parts[0]!.toLowerCase())) throw new Error("Provide an HTTPS Instagram profile URL, for example https://www.instagram.com/username/");
  return `https://www.instagram.com/${parts[0]}/`;
}

export function profileUrl(value: unknown): string {
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

export async function downloadProfile(
  { url, limit = 12, details = true, maxMedia = 50, dir }: { url: string; limit?: number; details?: boolean; maxMedia?: number; dir?: string },
  step: (action: any, args: any) => Promise<any>
) {
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
