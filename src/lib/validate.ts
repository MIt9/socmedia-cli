import { profileUrl, resolveHomePath } from "../media";

export const actions = new Set(["getProfile", "getPosts", "getPost", "getComments", "search", "screenshot", "readInbox", "readThread", "sendMessage", "readPage", "snapshot", "scroll", "listTabs", "useTab", "ytStudioRead", "click", "downloadProfile", "inertTask"]);
export const contactStatuses = ["new", "messaged", "replied", "won", "rejected", "skip"];
export const contactColumns = ["id", "platform", "username", "name", "status", "followers", "following", "postsCount", "verified", "private", "isBusiness", "category", "website", "email", "phone", "bio", "url", "note", "firstSeen", "lastSeen", "updatedAt"];

export const MAX_LEN = 1000;
export const GAP_MS = 90e3;
export const JITTER_MS = 60e3;
export const DUP_MS = 7 * 24 * 3600e3;
export const DEFAULT_CAP = 20;

export function capFromEnv(v = process.env.SOCMEDIA_MAX_MESSAGES_PER_DAY) {
  if (v === undefined || v === null || String(v).trim() === "") return DEFAULT_CAP;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_CAP;
}

export function checkMessageText(text: unknown): string {
  const t = typeof text === "string" ? text.trim() : "";
  if (!t) throw new Error("Message text is empty");
  const len = [...t].length;
  if (len > MAX_LEN) throw new Error(`Message is too long (${len} > ${MAX_LEN} characters)`);
  return t;
}

export function parseMessageTarget(to: unknown): { platform: "ig" | "fb"; url: string } {
  if (typeof to !== "string") throw new Error("Message recipient is required");
  let u: URL;
  try { u = new URL(to); } catch { throw new Error("Invalid recipient URL"); }
  const host = u.hostname.toLowerCase();
  const isIg = host.includes("instagram.com");
  const isFb = host.includes("facebook.com") || host.includes("fb.com");
  if (!isIg && !isFb) throw new Error("Provide an Instagram or Facebook recipient URL");
  const isThread = to.includes("/direct/t/") || /\/messages\/(e2ee\/)?t\//.test(to);
  if (isThread) return { platform: isIg ? "ig" : "fb", url: to };
  return { platform: isIg ? "ig" : "fb", url: profileUrl(to) };
}

export function previewUnlessConfirmed({ to, text, confirm }: { to: unknown; text: unknown; confirm?: boolean }) {
  const { platform, url } = parseMessageTarget(to);
  const t = checkMessageText(text);
  return confirm === true ? null : { preview: { platform, to: url, text: t }, sent: false };
}


export function postUrl(value: unknown): string {
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

export function validateJob(value: unknown) {
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
  if (job.action === "readInbox") {
    const args = job.args as Record<string, unknown>;
    for (const key of Object.keys(args)) {
      if (!["platform", "limit"].includes(key)) throw new Error(`Unknown readInbox option: ${key}`);
    }
    if (typeof args.platform !== "string") throw new Error("Platform is required");
    const norm = { ig: "ig", instagram: "ig", fb: "fb", facebook: "fb" }[args.platform.toLowerCase()];
    if (!norm) throw new Error("Platform must be ig or fb");
    args.platform = norm;
    if (args.limit !== undefined && (!Number.isInteger(args.limit) || Number(args.limit) < 1 || Number(args.limit) > 100)) throw new Error("Limit must be an integer from 1 to 100");
  }
  if (job.action === "readThread") {
    const args = job.args as Record<string, unknown>;
    for (const key of Object.keys(args)) {
      if (!["url", "to", "limit"].includes(key)) throw new Error(`Unknown readThread option: ${key}`);
    }
    if (!args.url && !args.to) throw new Error("Give url or to");
    if (args.url !== undefined && typeof args.url !== "string") throw new Error("url must be a string");
    if (args.to !== undefined && typeof args.to !== "string") throw new Error("to must be a string");
    if (args.limit !== undefined && (!Number.isInteger(args.limit) || Number(args.limit) < 1 || Number(args.limit) > 100)) throw new Error("Limit must be an integer from 1 to 100");
  }
  if (job.action === "sendMessage") {
    const args = job.args as Record<string, unknown>;
    for (const key of Object.keys(args)) {
      if (!["to", "text"].includes(key)) throw new Error(`Unknown sendMessage option: ${key}`);
    }
    const parsed = parseMessageTarget(args.to);
    args.to = parsed.url;
    args.text = checkMessageText(args.text);
  }
  if (job.action === "ytStudioRead") {
    const args = job.args as Record<string, unknown>;
    for (const key of Object.keys(args)) {
      if (!["expected", "studioUrl", "open"].includes(key)) throw new Error(`Unknown ytStudioRead option: ${key}`);
    }
    if (!args.expected || typeof args.expected !== "object") throw new Error("expected channel object required");
    if (typeof args.studioUrl !== "string" || !args.studioUrl) throw new Error("studioUrl is required");
    if (args.open !== undefined && typeof args.open !== "boolean") throw new Error("open must be a boolean");
  }
  if (job.action === "click") {
    const args = job.args as Record<string, unknown>;
    for (const key of Object.keys(args)) {
      if (!["index", "selector", "text"].includes(key)) throw new Error(`Unknown click option: ${key}`);
    }
    if (args.index !== undefined && (!Number.isInteger(args.index) || Number(args.index) < 0)) throw new Error("click index must be a non-negative integer");
    if (args.selector !== undefined && (typeof args.selector !== "string" || !args.selector)) throw new Error("click selector must be a nonempty string");
    if (args.text !== undefined && (typeof args.text !== "string" || !args.text)) throw new Error("click text must be a nonempty string");
    if (args.index === undefined && args.selector === undefined && args.text === undefined) throw new Error("click requires index, selector or text");
  }
  if (job.action === "scroll") {
    const args = job.args as Record<string, unknown>;
    for (const key of Object.keys(args)) {
      if (!["selector", "times"].includes(key)) throw new Error(`Unknown scroll option: ${key}`);
    }
    if (args.selector !== undefined && (typeof args.selector !== "string" || !args.selector)) throw new Error("scroll selector must be a nonempty string");
    if (args.times !== undefined && (!Number.isInteger(args.times) || Number(args.times) < 1 || Number(args.times) > 20)) throw new Error("scroll times must be an integer from 1 to 20");
  }
  if (job.key !== undefined && (typeof job.key !== "string" || !job.key)) throw new Error("--key must be a nonempty string");
  if (job.notBefore !== undefined && (typeof job.notBefore !== "string" || !Number.isFinite(Date.parse(job.notBefore)))) throw new Error("--not-before must be a valid ISO date");
  return job;
}
