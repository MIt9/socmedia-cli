try { importScripts("yt-judge.js"); } catch {}

let socket;
let browserAction = Promise.resolve();
let connectEpoch = 0;

const GROUP_TITLE = "Socmedia CLI";
const isSocial = (url) => /^https:\/\/([\w-]+\.)*((instagram|facebook|youtube)\.com|fb\.com)\//.test(url || "");

async function selectedWorkTab() {
  const { cliSelectedTab } = await chrome.storage.local.get("cliSelectedTab");
  const tab = cliSelectedTab != null ? await chrome.tabs.get(cliSelectedTab).catch(() => null) : null;
  return tab && isSocial(tab.url) ? tab : null;
}

async function workGroup() {
  const { cliGroupId } = await chrome.storage.local.get("cliGroupId");
  let group = cliGroupId != null ? await chrome.tabGroups.get(cliGroupId).catch(() => null) : null;
  if (!group || group.title !== GROUP_TITLE) {
    [group] = await chrome.tabGroups.query({ title: GROUP_TITLE });
    await chrome.storage.local.set({ cliGroupId: group?.id ?? null });
  }
  return group ?? null;
}

async function groupTabs() {
  const group = await workGroup();
  return group ? chrome.tabs.query({ groupId: group.id }) : [];
}

async function getWorkTab(create = true) {
  const { cliWorkTabId, cliWorkWindowId } = await chrome.storage.local.get(["cliWorkTabId", "cliWorkWindowId"]);
  const tabs = await groupTabs();
  let tab = (await selectedWorkTab()) || tabs.find((item) => item.id === cliWorkTabId) || tabs[0];
  if (!tab) {
    if (!create) throw new Error("No social media tab yet");
    let win = cliWorkWindowId != null ? await chrome.windows.get(cliWorkWindowId).catch(() => null) : null;
    tab = win && cliWorkTabId != null ? await chrome.tabs.get(cliWorkTabId).catch(() => null) : null;
    if (tab?.windowId !== win?.id) tab = null;
    if (!win) {
      win = await chrome.windows.create({ url: "about:blank", focused: false, state: "normal", left: 40, top: 40, width: 1280, height: 900 });
      tab = win.tabs?.[0] || (await chrome.tabs.query({ windowId: win.id }))[0];
    }
    tab ||= await chrome.tabs.create({ windowId: win.id, url: "about:blank", active: true });
    const group = await workGroup();
    if (group && group.windowId === win.id) await chrome.tabs.group({ tabIds: tab.id, groupId: group.id });
    else {
      const id = await chrome.tabs.group({ tabIds: tab.id, createProperties: { windowId: win.id } });
      await chrome.tabGroups.update(id, { title: GROUP_TITLE, color: "purple" });
      await chrome.storage.local.set({ cliGroupId: id });
    }
    await chrome.storage.local.set({ cliWorkWindowId: win.id });
  }
  if (!tab.active) await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
  if (tab.id !== cliWorkTabId) await chrome.storage.local.set({ cliWorkTabId: tab.id });
  return { tabId: tab.id, windowId: tab.windowId };
}

async function listTabs() {
  const selected = await selectedWorkTab();
  const { cliWorkTabId } = await chrome.storage.local.get("cliWorkTabId");
  const tabs = await groupTabs();
  if (selected && !tabs.some((tab) => tab.id === selected.id)) tabs.push(selected);
  return tabs.map((tab) => ({ tabId: tab.id, windowId: tab.windowId, url: tab.url, title: tab.title, active: tab.active, selected: tab.id === selected?.id, work: tab.id === cliWorkTabId }));
}

async function useTab({ tabId }) {
  if (tabId === null) {
    await chrome.storage.local.remove("cliSelectedTab");
    return { ok: true, selected: null };
  }
  if (!Number.isSafeInteger(tabId) || tabId < 0) throw new Error("Tab ID must be a non-negative integer");
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || !isSocial(tab.url)) throw new Error(`Tab ${tabId} is not an open Instagram, Facebook or YouTube tab`);
  await chrome.storage.local.set({ cliSelectedTab: tabId });
  return { ok: true, selected: tabId };
}

function inspectPage() {
  const path = location.pathname.toLowerCase();
  const paths = ["/challenge", "/checkpoint", "/accounts/login", "/login", "/suspended"];
  for (const part of paths) if (path.includes(part)) return `URL path "${part}"`;
  if ([...document.querySelectorAll("iframe")].some((frame) => {
    const rect = frame.getBoundingClientRect();
    return /recaptcha|captcha|arkoselabs/i.test(frame.src || "") && rect.width >= 100 && rect.height >= 50;
  })) return "captcha challenge";
  if (location.hostname.includes("instagram.com") && (document.querySelector("form#loginForm") || document.querySelector('form[action*="/accounts/login"]'))) return "not logged in (Instagram login form)";
  if ((location.hostname.includes("facebook.com") || /(^|\.)fb\.com$/.test(location.hostname)) && (document.querySelector("form#login_form") || (document.querySelector('input[name="email"]') && document.querySelector('input[name="pass"]')))) return "not logged in (Facebook login form)";
  const pattern = /Try Again Later|We restrict certain activity|suspicious activity|Confirm it['’]s you|You['’]re Temporarily Blocked/i;
  const dialogs = [...document.querySelectorAll('[role=dialog], [role=alertdialog], [role=alert]')];
  if ((document.body?.innerText || "").length < 3000 && document.body) dialogs.push(document.body);
  for (const element of dialogs) { const match = (element?.innerText || "").match(pattern); if (match) return `security check: "${match[0]}"`; }
  return null;
}

async function safeTab(tabId) {
  const tab = await chrome.tabs.get(tabId);
  const parsed = new URL(tab.url);
  const path = parsed.pathname.toLowerCase();
  const blockedPath = ["/challenge", "/checkpoint", "/accounts/login", "/login", "/suspended"].find((part) => path.includes(part));
  const externalLogin = parsed.hostname === "accounts.google.com" || (/(^|\.)google\.com$/.test(parsed.hostname) && path.startsWith("/sorry"));
  if (!blockedPath && !externalLogin && !isSocial(tab.url)) throw new Error("Work tab is not an open Instagram, Facebook or YouTube tab");
  const [check] = blockedPath || externalLogin ? [] : await chrome.scripting.executeScript({ target: { tabId }, func: inspectPage });
  const reason = blockedPath ? `URL path "${blockedPath}"` : externalLogin ? "Google sign-in or security check" : check?.result;
  if (reason) {
    const error = new Error(`HALT: ${reason}`);
    error.code = "HALT";
    error.reason = reason;
    throw error;
  }
  return tab;
}

async function safeWorkTab() {
  const { tabId } = await getWorkTab(false);
  return safeTab(tabId);
}

function instagramProfileUrl(value) {
  if (typeof value !== "string") throw new Error("Instagram profile URL is required");
  let url;
  try { url = new URL(value); } catch { throw new Error("Invalid Instagram profile URL"); }
  const parts = url.pathname.split("/").filter(Boolean);
  const reserved = new Set(["accounts", "challenge", "checkpoint", "direct", "explore", "p", "reel", "reels", "stories", "tv", "about", "developer", "legal"]);
  if (url.protocol !== "https:" || !["instagram.com", "www.instagram.com"].includes(url.hostname.toLowerCase()) || url.username || url.password || url.port || parts.length !== 1 || !/^[a-zA-Z0-9._]{1,30}$/.test(parts[0]) || reserved.has(parts[0].toLowerCase())) throw new Error("Provide an HTTPS Instagram profile URL");
  return `https://www.instagram.com/${parts[0]}/`;
}

function profileUrl(value) {
  if (typeof value !== "string") throw new Error("Instagram or Facebook profile URL is required");
  let url;
  try { url = new URL(value); } catch { throw new Error("Invalid Instagram or Facebook profile URL"); }
  const host = url.hostname.toLowerCase();
  if (["instagram.com", "www.instagram.com"].includes(host)) return instagramProfileUrl(value);
  const facebookHosts = ["facebook.com", "www.facebook.com", "m.facebook.com", "mbasic.facebook.com", "web.facebook.com", "fb.com", "www.fb.com"];
  const parts = url.pathname.split("/").filter(Boolean);
  const reserved = new Set(["login", "checkpoint", "challenge", "messages", "watch", "reel", "reels", "groups", "events", "marketplace", "share", "photo", "photos", "posts", "videos", "people", "pages", "settings", "help", "home.php", "login.php", "notifications", "friends", "search", "profile.php"]);
  if (url.protocol !== "https:" || !facebookHosts.includes(host) || url.username || url.password || url.port) throw new Error("Provide an HTTPS Instagram or Facebook profile URL");
  if (parts.length === 1 && parts[0].toLowerCase() === "profile.php") {
    const ids = url.searchParams.getAll("id");
    if (ids.length !== 1 || !/^\d+$/.test(ids[0])) throw new Error("Facebook profile.php URL requires one numeric id");
    return `https://www.facebook.com/profile.php?id=${ids[0]}`;
  }
  const slug = parts.length === 1 && /^[a-zA-Z0-9._-]{1,100}$/.test(parts[0]) && !reserved.has(parts[0].toLowerCase());
  const named = parts.length === 3 && ["people", "pages"].includes(parts[0].toLowerCase()) && /^[a-zA-Z0-9._-]{1,100}$/.test(parts[1]) && /^\d+$/.test(parts[2]);
  if (!slug && !named) throw new Error("Provide an HTTPS Instagram or Facebook profile URL");
  return `https://www.facebook.com/${parts.join("/")}`;
}

function postUrl(value) {
  if (typeof value !== "string") throw new Error("Instagram or Facebook post URL is required");
  let url;
  try { url = new URL(value); } catch { throw new Error("Invalid Instagram or Facebook post URL"); }
  const host = url.hostname.toLowerCase();
  const parts = url.pathname.split("/").filter(Boolean);
  if (url.protocol !== "https:" || url.username || url.password || url.port) {
    throw new Error("Provide an HTTPS Instagram or Facebook post URL");
  }

  if (["instagram.com", "www.instagram.com"].includes(host)) {
    if (parts.length !== 2 || !["p", "reel"].includes(parts[0]) || !/^[a-zA-Z0-9_-]{1,64}$/.test(parts[1])) {
      throw new Error("Provide an HTTPS Instagram post or reel URL, for example https://www.instagram.com/p/ID/");
    }
    return `https://www.instagram.com/${parts[0]}/${parts[1]}/`;
  }

  const facebookHosts = ["facebook.com", "www.facebook.com", "m.facebook.com", "mbasic.facebook.com", "web.facebook.com", "fb.com", "www.fb.com"];
  if (facebookHosts.includes(host)) {
    const idPattern = /^[a-zA-Z0-9._-]{1,100}$/;
    if (parts.length === 1 && ["permalink.php", "story.php"].includes(parts[0].toLowerCase())) {
      const fbid = url.searchParams.get("story_fbid");
      const uid = url.searchParams.get("id");
      if (!fbid || !uid || !/^\d+$/.test(uid) || !idPattern.test(fbid)) {
        throw new Error("Facebook permalink requires story_fbid and numeric id");
      }
      return `https://www.facebook.com/permalink.php?story_fbid=${fbid}&id=${uid}`;
    }
    if (parts.length === 1 && parts[0].toLowerCase() === "photo.php") {
      const fbid = url.searchParams.get("fbid");
      if (!fbid || !/^\d+$/.test(fbid)) throw new Error("Facebook photo.php requires numeric fbid");
      return `https://www.facebook.com/photo.php?fbid=${fbid}`;
    }
    if (parts.length === 1 && parts[0].toLowerCase() === "watch") {
      const v = url.searchParams.get("v");
      if (!v || !idPattern.test(v)) throw new Error("Facebook watch URL requires video parameter v");
      return `https://www.facebook.com/watch/?v=${v}`;
    }
    if (parts.length === 2 && ["posts", "reel", "reels"].includes(parts[0].toLowerCase()) && idPattern.test(parts[1])) {
      const type = parts[0].toLowerCase() === "reels" ? "reel" : parts[0].toLowerCase();
      return `https://www.facebook.com/${type}/${parts[1]}/`;
    }
    if (parts.length === 3 && ["posts", "videos", "photos"].includes(parts[1].toLowerCase()) && idPattern.test(parts[0]) && idPattern.test(parts[2])) {
      return `https://www.facebook.com/${parts[0]}/${parts[1].toLowerCase()}/${parts[2]}/`;
    }
  }

  throw new Error("Provide an HTTPS Instagram or Facebook post URL");
}

function extractInstagramProfile() {
  const num = (s) => {
    if (s == null) return null;
    const m = String(s).replace(/,/g, "").match(/([\d.]+)\s*([KkMmBb])?/);
    if (!m) return null;
    const val = parseFloat(m[1]);
    if (isNaN(val)) return null;
    const mult = { k: 1e3, m: 1e6, b: 1e9 }[(m[2] || "").toLowerCase()] || 1;
    return Math.round(val * mult);
  };
  const ogTitle = document.querySelector('meta[property="og:title"]')?.content || "";
  const ogDesc = document.querySelector('meta[property="og:description"]')?.content || "";
  const ogImg = document.querySelector('meta[property="og:image"]')?.content || null;
  const username = location.pathname.replace(/^\/+|\/+$/g, "").split("/")[0] || document.querySelector("header section h2, header h2, header h1")?.innerText?.trim() || null;
  const name = ogTitle.match(/^(.*?)\s*\(@/)?.[1]?.trim() || document.querySelector('header section span[dir="auto"], header section h1')?.innerText?.trim() || null;
  const lines = ((document.querySelector("main") || document.body)?.innerText || "").split("\n").map((s) => s.trim()).filter(Boolean);
  const countLine = (re) => lines.find((line) => re.test(line));
  const followers = num(countLine(/^[\d.,]+[KkMmBb]?\s+followers$/i)) ?? num(ogDesc.match(/([\d.,]+[KkMmBb]?)\s+Followers/i)?.[1]);
  const following = num(countLine(/^[\d.,]+[KkMmBb]?\s+following$/i)) ?? num(ogDesc.match(/([\d.,]+[KkMmBb]?)\s+Following/i)?.[1]);
  const postsCount = num(countLine(/^[\d.,]+[KkMmBb]?\s+posts?$/i)) ?? num(ogDesc.match(/([\d.,]+[KkMmBb]?)\s+Posts/i)?.[1]);
  const siteRe = /^(?:https?:\/\/)?[\w-]+(?:\.[\w-]+)+(?:\/\S*)?(?: and \d+ more)?$/i;
  const stopRe = /^(Follow|Following|Message|Edit profile|View archive|Contact|Email|Call|Directions)$/i;
  const fi = lines.findIndex((line) => /^[\d.,]+[KkMmBb]?\s+following$/i.test(line));
  let tail = [];
  if (fi >= 0) {
    tail = lines.slice(fi + 1, fi + 12);
    const stop = tail.findIndex((line) => stopRe.test(line) || line === username);
    if (stop >= 0) tail = tail.slice(0, stop);
  }
  const siteLine = tail.find((line) => siteRe.test(line));
  const bio = tail.filter((line) => line !== siteLine).join("\n") || null;
  const verified = Boolean(document.querySelector('header [aria-label*="Verified" i], header svg[aria-label*="Verified" i], header [title*="Verified" i]'));
  const isPrivate = Boolean(document.body?.innerText?.match(/This Account is Private|This account is private/i));
  const avatarUrl = document.querySelector('header img[alt*="profile picture" i], header img')?.src || ogImg;
  const category = document.querySelector('header section div:not([dir="auto"])')?.innerText?.trim() || null;
  const unwrapIg = (href) => { try { return new URL(href, location.href).searchParams.get("u") || href; } catch { return href; } };
  const links = [...new Set([...document.querySelectorAll('main a[href*="l.instagram.com"], header a[target="_blank"]')].map((a) => unwrapIg(a.href)).filter((href) => href && !href.includes("instagram.com")))];
  const site = siteLine?.replace(/ and \d+ more$/i, "");
  const website = (site && (links.find((href) => href.includes(site.replace(/^https?:\/\//, "").replace(/^www\./, ""))) || (/^https?:/.test(site) ? site : `https://${site}`))) || links.find((href) => !/threads\.(com|net)/.test(href)) || null;
  const emailMatch = (bio || "").match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  const phoneMatch = (bio || "").match(/\+?[\d(][\d\s().-]{7,}\d/);
  const contact = (emailMatch || phoneMatch) ? { email: emailMatch?.[0] || null, phone: phoneMatch?.[0] || null, address: null } : null;
  const isBusiness = Boolean(category || contact || document.querySelector('[aria-label*="Contact" i]'));
  return { platform: "ig", url: location.href, username, name, bio, website, category, followers, following, postsCount, verified, private: isPrivate, isBusiness, avatarUrl, contact, links };
}

function extractFacebookProfile() {
  const num = (s) => {
    if (s == null) return null;
    const m = String(s).replace(/,/g, "").match(/([\d.]+)\s*([KkMmBb])?/);
    if (!m) return null;
    const val = parseFloat(m[1]);
    if (isNaN(val)) return null;
    const mult = { k: 1e3, m: 1e6, b: 1e9 }[(m[2] || "").toLowerCase()] || 1;
    return Math.round(val * mult);
  };
  const ogTitle = document.querySelector('meta[property="og:title"]')?.content || "";
  const ogDesc = document.querySelector('meta[property="og:description"]')?.content || "";
  const ogImg = document.querySelector('meta[property="og:image"]')?.content || null;
  const lines = ((document.querySelector("[role=main]") || document.body)?.innerText || "").split("\n").map((s) => s.trim()).filter(Boolean);
  const ci = lines.findIndex((line) => /\bfollowers\b|\bfriends\b|\blikes\b/i.test(line) && /^[\d.,]+[KkMmBb]?\s/.test(line));
  const buttons = /^(Sign up|Log in|Follow|Following|Search|Message|Like|Liked|Call now|Send message|Book now|Contact us|Learn more|Shop now|Add friend|Friends|Edit profile|Add to story)$/i;
  let intro = ci >= 0 ? lines.slice(ci + 1) : [];
  while (intro.length && buttons.test(intro[0])) intro.shift();
  const moreAt = intro.findIndex((line) => /^(More|All|Posts)$/i.test(line));
  intro = moreAt >= 0 ? intro.slice(0, moreAt) : intro.slice(0, 6);
  const section = (title) => {
    const i = lines.indexOf(title);
    if (i < 0) return [];
    const out = [];
    for (const line of lines.slice(i + 1, i + 12)) {
      if (/^(Links|Contact info|Photos|Intro|Featured|Reels|Videos|Privacy|See all.*)$/i.test(line)) break;
      out.push(line.replace(/^·\s*/, ""));
    }
    return [...new Set(out)];
  };
  const sites = section("Links");
  const contactLines = section("Contact info");
  const name = document.querySelector("h1")?.innerText?.trim() || (ci > 0 ? lines[ci - 1] : null) || ogTitle || null;
  const urlPath = location.pathname.replace(/^\/+|\/+$/g, "");
  const username = urlPath.includes("profile.php") ? null : urlPath.split("/")[0] || null;
  const followers = num(document.body?.innerText?.match(/([\d.,]+[KkMmBb]?)\s+followers/i)?.[1]) ?? num(ogDesc.match(/([\d.,]+[KkMmBb]?)\s+followers/i)?.[1]);
  const following = num(document.body?.innerText?.match(/([\d.,]+[KkMmBb]?)\s+following/i)?.[1]);
  const verified = Boolean(document.querySelector('h1 [aria-label*="Verified" i], [role=main] [aria-label*="Verified" i]'));
  const isPrivate = Boolean(document.body?.innerText?.match(/Content Not Found|This content isn't available/i));
  const avatarUrl = document.querySelector('svg[aria-label*="profile picture" i] image, img[alt*="profile picture" i]')?.src || ogImg;
  const category = intro.length > 1 && /^[A-Z][\w &'/,-]{2,40}$/.test(intro[intro.length - 1]) ? intro[intro.length - 1] : null;
  const bio = intro.filter((line) => line !== category).join("\n") || null;
  const links = sites.map((site) => (/^https?:/.test(site) ? site : `https://${site}`)).filter((href) => /^https?:\/\/[\w-]+(\.[\w-]+)+/.test(href));
  const website = links[0] || null;
  const contactText = [...contactLines, bio || ""].join("\n");
  const emailMatch = contactText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  const phoneMatch = contactText.match(/\+?[\d(][\d\s().-]{7,}\d/);
  const contact = (emailMatch || phoneMatch) ? { email: emailMatch?.[0] || null, phone: phoneMatch?.[0] || null, address: contactLines.find((line) => /\d/.test(line) && /,/.test(line) && !/@/.test(line)) || null } : null;
  const isBusiness = Boolean(category || /page/i.test(document.body?.innerText?.slice(0, 1500) || "") || document.querySelector('a[href*="/reviews/"]'));
  return { platform: "fb", url: location.href, username, name, bio, website, category, followers, following, postsCount: null, verified, private: isPrivate, isBusiness, avatarUrl, contact, links };
}

let lastProfileNavigation = 0;
let nextProfileGap = 3000;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function navigateSocial(target) {
  const { tabId } = await getWorkTab();
  const current = await chrome.tabs.get(tabId);
  if (current.url !== "about:blank") await safeTab(tabId);
  if (current.url !== target) {
    const wait = lastProfileNavigation + nextProfileGap - Date.now();
    if (wait > 0) await delay(wait);
    const beforeNavigation = await chrome.tabs.get(tabId);
    if (beforeNavigation.url !== "about:blank") await safeTab(tabId);
    await chrome.tabs.update(tabId, { url: target });
    lastProfileNavigation = Date.now();
    nextProfileGap = 3000 + Math.floor(Math.random() * 4001);
    const deadline = Date.now() + 30000;
    let loaded = false;
    while (Date.now() < deadline) {
      const tab = await chrome.tabs.get(tabId);
      if (tab.status === "complete") { loaded = true; break; }
      await delay(300);
    }
    if (!loaded) throw new Error("Social page navigation timed out");
    await delay(800 + Math.floor(Math.random() * 701));
  }
  return safeTab(tabId);
}

async function getProfile({ url }) {
  const target = profileUrl(url);
  const tab = await navigateSocial(target);
  const tabId = tab.id;
  if (profileUrl(tab.url).toLowerCase() !== target.toLowerCase()) throw new Error("Redirected to a different profile");
  const extractor = new URL(target).hostname === "www.instagram.com" ? extractInstagramProfile : extractFacebookProfile;
  const [execution] = await chrome.scripting.executeScript({ target: { tabId }, func: extractor });
  if (!execution?.result) throw new Error("Could not read profile");
  return execution.result;
}

function extractInstagramPosts(limit) {
  const num = (s) => {
    if (s == null) return null;
    const match = String(s).replace(/,/g, "").match(/([\d.]+)\s*([KkMmBb])?/);
    if (!match) return null;
    const value = parseFloat(match[1]);
    if (isNaN(value)) return null;
    return Math.round(value * ({ k: 1e3, m: 1e6, b: 1e9 }[(match[2] || "").toLowerCase()] || 1));
  };
  const posts = [];
  const links = [...document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]')];
  for (const a of links) {
    const url = a.href;
    const shortcode = url.match(/\/(?:p|reel)\/([^/?#]+)/)?.[1] || null;
    let type = "photo";
    if (url.includes("/reel/")) type = "reel";
    else if (a.querySelector('svg[aria-label*="Carousel" i], svg[aria-label*="Sidecar" i]') || a.parentElement?.querySelector('svg[aria-label*="Carousel" i], svg[aria-label*="Sidecar" i]')) type = "carousel";
    else if (a.querySelector('svg[aria-label*="Video" i], svg[aria-label*="Clip" i], video') || a.parentElement?.querySelector('svg[aria-label*="Video" i]')) type = "video";
    else if (a.querySelector('svg[aria-label*="Pinned" i]')) type = null;

    const img = a.querySelector("img");
    const thumbUrl = img?.src || null;
    const caption = img?.alt || null;

    const n = a.__socStats || [];
    const likes = n.length > 1 ? num(n[n.length - 2]) : null;
    const comments = n.length ? num(n[n.length - 1]) : null;

    posts.push({ url, shortcode, type, thumbUrl, caption, date: null, likes, comments });
    if (posts.length >= limit) break;
  }
  return posts;
}

function extractFacebookPosts(limit) {
  const num = (s) => {
    if (s == null) return null;
    const match = String(s).replace(/,/g, "").match(/([\d.]+)\s*([KkMmBb])?/);
    if (!match) return null;
    const value = parseFloat(match[1]);
    if (isNaN(value)) return null;
    return Math.round(value * ({ k: 1e3, m: 1e6, b: 1e9 }[(match[2] || "").toLowerCase()] || 1));
  };
  const posts = [];
  const K = '[aria-label="Leave a comment"]';
  const clean = (h) => {
    try {
      const u = new URL(h);
      for (const k of [...u.searchParams.keys()]) if (!["story_fbid", "id", "fbid", "v"].includes(k)) u.searchParams.delete(k);
      return u.href;
    } catch { return h; }
  };
  for (const b of document.querySelectorAll(K)) {
    let art = b;
    for (let i = 0; i < 40 && art.parentElement; i++) {
      if (art.querySelector('[aria-label^="Actions for this post"]') || art.parentElement.querySelectorAll(K).length > 1) break;
      art = art.parentElement;
    }
    const own = (sel) => [...art.querySelectorAll(sel)].filter((e) => !e.closest("[role=article]"));
    const POST_RE = /\/(posts|videos|reel)\/[\w-]+|\/watch\/?\?v=|permalink\.php/;
    const hrefs = own("a[href]").map((a) => a.href);
    const perma = hrefs.find((h) => POST_RE.test(h)) || hrefs.find((h) => /\/photo\/?\?fbid=|\/photos\/[\w.-]+/.test(h));
    if (!perma) continue;
    const url = clean(perma);
    const id = url.match(/(?:\/posts\/|\/videos\/|\/reel\/|story_fbid=|fbid=|[?&]v=)([\w\d]+)/)?.[1] || null;
    const img = own("img").find((i) => i.width > 150);
    const thumbUrl = img?.src || null;
    const caption = art.querySelector('[data-ad-preview="message"], [data-ad-comet-preview="message"]')?.innerText?.replace(/…\s*See more\s*$|\s*See less\s*$/, "").trim() || null;
    const tsA = own("a").filter((a) => POST_RE.test(a.href) || /\/photo|\/photos\//.test(a.href) || a.__socTip);
    const tip = tsA.map((a) => a.__socTip || document.getElementById(a.getAttribute("aria-labelledby") || "")?.innerText?.trim()).find(Boolean);
    const date = art.querySelector("time[datetime]")?.getAttribute("datetime") || tip || null;

    let type = "text";
    if (url.includes("/reel/")) type = "reel";
    else if (/\/videos\/|\/watch/.test(url) || art.querySelector("video")) type = "video";
    else if (img) type = "photo";

    const stat = (re) => num(own("span").map((s) => s.innerText?.trim()).find((t) => re.test(t || "")));
    const likes = num(own('[aria-label="Like"]').map((e) => e.innerText?.trim()).find((t) => /^[\d.,]+[KkMm]?$/.test(t || "")));
    const comments = num(b.innerText?.trim().match(/^[\d.,]+[KkMm]?$/)?.[0]) ?? stat(/^[\d.,]+[KkMm]?\s+comments?$/i);

    posts.push({ url, shortcode: id, type, thumbUrl, caption, date, likes, comments });
    if (posts.length >= limit) break;
  }
  return posts;
}

async function getPosts({ url, limit = 12 }) {
  const target = profileUrl(url);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Post limit must be an integer from 1 to 100");
  const tab = await navigateSocial(target);
  const tabId = tab.id;
  const isIg = new URL(target).hostname.includes("instagram.com");
  const current = await safeTab(tabId);
  if (profileUrl(current.url).toLowerCase() !== target.toLowerCase()) throw new Error("Redirected to a different profile");
  const extractor = isIg ? extractInstagramPosts : extractFacebookPosts;
  const [execution] = await chrome.scripting.executeScript({ target: { tabId }, func: extractor, args: [limit] });
  return { platform: isIg ? "ig" : "fb", url: current.url, posts: execution?.result || [] };
}

function findMoreComments() {
  const buttons = [...document.querySelectorAll("button, [role=button], a[role=button]")];
  const button = buttons.find((item) => (/View (more|previous) comments|Load more comments/i.test(item.innerText || "") || /View (more|previous) comments|Load more comments/i.test(item.getAttribute("aria-label") || "")) && item.getBoundingClientRect().width > 0);
  if (!button) return null;
  button.scrollIntoView({ block: "center" });
  const rect = button.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

function extractInstagramComments(limit) {
  const num = (s) => {
    if (s == null) return null;
    const match = String(s).replace(/,/g, "").match(/([\d.]+)\s*([KkMmBb])?/);
    if (!match) return null;
    const value = parseFloat(match[1]);
    if (isNaN(value)) return null;
    return Math.round(value * ({ k: 1e3, m: 1e6, b: 1e9 }[(match[2] || "").toLowerCase()] || 1));
  };
  const comments = [];
  for (const time of document.querySelectorAll("time[datetime]")) {
    let item = time.parentElement;
    for (let i = 0; item && i < 10; i++, item = item.parentElement) {
      if (item.querySelectorAll("time[datetime]").length > 1) { item = null; break; }
      if (/(^|\n)Reply(\n|$)/.test(item.innerText || "")) break;
    }
    if (!item || !/(^|\n)Reply(\n|$)/.test(item.innerText || "")) continue;
    const author = item.querySelector('a[href^="/"]:not([href*="/p/"]):not([href*="/reel/"])');
    const lines = item.innerText.split("\n").map((line) => line.trim()).filter(Boolean);
    const ti = lines.indexOf(time.innerText.trim());
    const body = lines.slice(ti + 1).filter((line) => !/^(Reply|[\d.,]+[KkMm]?\s+likes?|View all \d+ repl(y|ies)|Hide replies|See translation)$/i.test(line));
    const text = body.join("\n") || null;
    if (!text) continue;
    comments.push({ author: author?.innerText?.trim() || lines[0] || null, authorUrl: author?.href || null, text, date: time.getAttribute("datetime"), likes: num(lines.find((line) => /^[\d.,]+[KkMm]?\s+likes?$/i.test(line))) ?? 0 });
    if (comments.length >= limit) break;
  }
  return comments;
}

function extractFacebookComments(limit) {
  const num = (s) => {
    if (s == null) return null;
    const match = String(s).replace(/,/g, "").match(/([\d.]+)\s*([KkMmBb])?/);
    if (!match) return null;
    const value = parseFloat(match[1]);
    if (isNaN(value)) return null;
    return Math.round(value * ({ k: 1e3, m: 1e6, b: 1e9 }[(match[2] || "").toLowerCase()] || 1));
  };
  const comments = [];
  for (const item of document.querySelectorAll("[role=article][aria-label]")) {
    const label = item.getAttribute("aria-label") || "";
    const match = label.match(/^(?:Comment|Reply) by (.+?)(?: to .+?'s comment)? (\S+ \S+ ago|just now|a (?:minute|day|week|month|year) ago)$/i);
    if (!match) continue;
    const author = match[1];
    const own = (item.innerText || "").split("\n").map((s) => s.trim()).filter(Boolean);
    const nested = [...item.querySelectorAll("[role=article]")].flatMap((n) => (n.innerText || "").split("\n").map((s) => s.trim()));
    const lines = own.filter((line) => !nested.includes(line));
    const start = Math.max(lines.indexOf("Follow"), lines.findIndex((line) => /^\d+\s*[smhdwy]$/.test(line)));
    const body = lines.slice(start + 1).filter((line) => line !== "·" && !/^(Like|Reply|Share|Edited|Author|Top fan|See translation|View \d+ repl(y|ies)|View all \d+ replies|[\d.,]+[KkMm]?)$/i.test(line));
    const text = body.join("\n") || null;
    if (!text) continue;
    const link = [...item.querySelectorAll("a[href]")].find((a) => (a.innerText || "").trim() === author) || item.querySelector("a[href]");
    let authorUrl = null;
    try {
      const u = new URL(link.href);
      for (const k of [...u.searchParams.keys()]) if (k !== "id") u.searchParams.delete(k);
      authorUrl = u.href;
    } catch {}
    const likeCount = lines.slice(start + 1).find((line) => /^[\d.,]+[KkMm]?$/.test(line));
    comments.push({ author, authorUrl, text, date: match[2], likes: likeCount ? num(likeCount) : 0 });
    if (comments.length >= limit) break;
  }
  return comments;
}

async function getComments({ url, limit = 20 }) {
  const target = postUrl(url);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error("Comment limit must be an integer from 1 to 500");
  const tab = await navigateSocial(target);
  const tabId = tab.id;
  const isIg = new URL(target).hostname.includes("instagram.com");
  const checkTarget = async () => {
    const current = await safeTab(tabId);
    if (postUrl(current.url) !== target) throw new Error(`Redirected to a different ${isIg ? "Instagram" : "Facebook"} post`);
    return current;
  };
  await checkTarget();
  let attached = false;
  try {
    for (let i = 0; i < 5; i++) {
      await checkTarget();
      const [located] = await chrome.scripting.executeScript({ target: { tabId }, func: findMoreComments });
      const point = located?.result;
      if (!point) break;
      await checkTarget();
      if (!attached) {
        const win = await chrome.windows.get(tab.windowId);
        if (win.state === "minimized") throw new Error("Restore the work window before expanding comments");
        await chrome.debugger.attach({ tabId }, "1.3"); attached = true;
      }
      for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
        let timer;
        try {
          await Promise.race([
            chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", { type, x: point.x, y: point.y, ...(type !== "mouseMoved" && { button: "left", clickCount: 1 }) }),
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Chrome debugger input timed out")), 15000); }),
          ]);
        } finally { clearTimeout(timer); }
      }
      await delay(1000 + Math.floor(Math.random() * 1001));
      await checkTarget();
    }
  } finally { if (attached) await chrome.debugger.detach({ tabId }).catch(() => {}); }
  const current = await checkTarget();
  const extractor = isIg ? extractInstagramComments : extractFacebookComments;
  const [execution] = await chrome.scripting.executeScript({ target: { tabId }, func: extractor, args: [limit] });
  return { platform: isIg ? "ig" : "fb", url: current.url, comments: execution?.result || [] };
}

function extractInstagramPost() {
  const num = (s) => {
    if (s == null) return null;
    const match = String(s).replace(/,/g, "").match(/([\d.]+)\s*([KkMmBb])?/);
    if (!match) return null;
    const value = parseFloat(match[1]);
    if (isNaN(value)) return null;
    return Math.round(value * ({ k: 1e3, m: 1e6, b: 1e9 }[(match[2] || "").toLowerCase()] || 1));
  };
  const ogTitle = document.querySelector('meta[property="og:title"]')?.content || "";
  const ogDesc = document.querySelector('meta[property="og:description"]')?.content || "";
  const username = location.pathname.match(/^\/([^/]+)\/(?:p|reel|tv)\//)?.[1] || ogDesc.match(/ - ([\w.]+) on /)?.[1] || null;
  const name = ogTitle.match(/^(.*?) on Instagram/)?.[1]?.trim() || null;
  const authorUrl = username ? `https://www.instagram.com/${username}/` : null;
  const quoted = (s) => s.match(/:\s*"([\s\S]*)"\s*$/)?.[1]?.trim() || null;
  const caption = document.querySelector("main h1")?.innerText?.trim() || quoted(ogTitle) || quoted(ogDesc) || null;
  const timeEl = document.querySelector("time[datetime]");
  const ogDay = ogDesc.match(/ on (\w+ \d{1,2}, \d{4})/)?.[1];
  const date = timeEl ? timeEl.getAttribute("datetime") : (ogDay && !isNaN(new Date(`${ogDay} UTC`).getTime()) ? new Date(`${ogDay} UTC`).toISOString() : null);
  const likes = num(document.querySelector('a[href*="/liked_by/"]')?.innerText) ?? num(ogDesc.match(/([\d.,]+[KkMmBb]?)\s+likes/i)?.[1]);
  const commentsCount = num(ogDesc.match(/([\d.,]+[KkMmBb]?)\s+comments/i)?.[1]) ?? num([...document.querySelectorAll("span, button")].map((e) => e.innerText).find((t) => /\b[\d.,]+\s+comments\b/i.test(t || "")));
  const views = num([...document.querySelectorAll("span")].map((e) => e.innerText).find((t) => /\b[\d.,]+\s+views\b/i.test(t || "")));
  const place = document.querySelector('a[href*="/explore/locations/"]')?.innerText?.trim() || null;

  const images = [...document.querySelectorAll("main img[src]")]
    .filter((img) => (img.clientWidth || 0) >= 250 && !/profile picture/i.test(img.alt || "") && !img.closest('a[href*="/p/"], a[href*="/reel/"]'))
    .map((img) => ({ type: "image", url: img.currentSrc || img.src, alt: img.alt?.trim() || null }));
  const videos = [...document.querySelectorAll("main video[src], main video source[src]")]
    .map((v) => ({ type: "video", url: v.src })).filter((v) => /^https?:/.test(v.url));
  const ogImage = document.querySelector('meta[property="og:image"]')?.content;
  let media = [...new Map([...images, ...videos].map((m) => [m.url, m])).values()];
  if (!media.length && ogImage) media.push({ type: "image", url: ogImage });

  const hashtags = [...new Set((caption || "").match(/#([\p{L}\p{N}_]+)/gu)?.map((t) => t.slice(1)) || [])];
  const mentions = [...new Set((caption || "").match(/@([\p{L}\p{N}_.]+)/gu)?.map((t) => t.slice(1).replace(/\.+$/, "")) || [])];

  return {
    platform: "ig",
    url: location.href,
    author: { username, name, url: authorUrl },
    caption,
    date,
    likes,
    commentsCount,
    views,
    location: place,
    media,
    hashtags,
    mentions,
  };
}

function extractFacebookPost() {
  const num = (s) => {
    if (s == null) return null;
    const match = String(s).replace(/,/g, "").match(/([\d.]+)\s*([KkMmBb])?/);
    if (!match) return null;
    const value = parseFloat(match[1]);
    if (isNaN(value)) return null;
    return Math.round(value * ({ k: 1e3, m: 1e6, b: 1e9 }[(match[2] || "").toLowerCase()] || 1));
  };
  const MSG = '[data-ad-preview="message"], [data-ad-comet-preview="message"]';
  const root = [...document.querySelectorAll('[role=dialog]')].find((d) => d.querySelector(`${MSG}, a[href*="/photo"] img, video`)) || document;
  const outside = (sel) => [...root.querySelectorAll(sel)].filter((e) => !e.closest("[role=article], [role=banner], [role=navigation]"));

  const authorEl = outside("h2 a, h3 a, strong a")[0];
  const authorLink = authorEl?.closest?.("a") || authorEl?.querySelector?.("a") || authorEl;
  const authorUrl = authorLink?.href ? authorLink.href.split("?")[0] : null;
  const name = authorEl?.innerText?.trim() || null;
  let username = null;
  if (authorUrl) {
    try { username = new URL(authorUrl).pathname.replace(/^\/+|\/+$/g, "").split("/")[0] || null; } catch {}
  }

  const texts = outside('[data-ad-preview="message"], [data-ad-comet-preview="message"], span[dir="auto"], div[dir="auto"]')
    .map((e) => (e.innerText || "").trim()).filter((t) => t && t !== "Facebook" && t !== name && !/^(\S͏?\n){4,}/.test(t));
  const msgEl = root.querySelector(MSG);
  const domCaption = msgEl?.innerText?.replace(/…\s*See more\s*$/, "").trim() || texts.reduce((a, b) => (b.length > a.length ? b : a), "") || null;
  const caption = domCaption;
  const date = root.querySelector("time[datetime]")?.getAttribute("datetime") || null;

  const counters = texts.slice(Math.max(0, texts.indexOf(domCaption)) + 1).filter((t) => /^[\d.,]+[KkMm]?$/.test(t)).map(num);
  const likes = counters[0] ?? null;
  const commentsCount = counters[1] ?? null;
  const views = num(texts.find((t) => /^[\d.,]+[KkMm]?\s+views$/i.test(t)));

  const images = outside("img[src]").filter((img) => (img.width || 0) > 300).map((img) => ({ type: "image", url: img.currentSrc || img.src }));
  const videos = outside("video[src], video source[src]").map((v) => ({ type: "video", url: v.src })).filter((v) => /^https?:/.test(v.url));
  const media = [...new Map([...images, ...videos].map((m) => [m.url, m])).values()];

  const hashtags = [...new Set((caption || "").match(/#([\p{L}\p{N}_]+)/gu)?.map((t) => t.slice(1)) || [])];
  const mentions = [...new Set((caption || "").match(/@([\p{L}\p{N}_.]+)/gu)?.map((t) => t.slice(1).replace(/\.+$/, "")) || [])];

  return {
    platform: "fb",
    url: location.href,
    author: { username, name, url: authorUrl },
    caption,
    date,
    likes,
    commentsCount,
    views,
    location: null,
    media,
    hashtags,
    mentions,
  };
}

async function getPost({ url }) {
  const target = postUrl(url);
  const tab = await navigateSocial(target);
  const tabId = tab.id;
  const isIg = new URL(target).hostname.includes("instagram.com");
  const current = await safeTab(tabId);
  if (postUrl(current.url) !== target) throw new Error(`Redirected to a different ${isIg ? "Instagram" : "Facebook"} post`);
  const extractor = isIg ? extractInstagramPost : extractFacebookPost;
  const [execution] = await chrome.scripting.executeScript({ target: { tabId }, func: extractor });
  return execution?.result || null;
}

function pgGetCropRect(selector, target) {
  let el = null;
  if (selector) {
    el = document.querySelector(selector);
  } else if (target === "post") {
    el = document.querySelector("article, [role=article], main");
  } else if (target === "profile") {
    el = document.querySelector("header, [role=main] header, main");
  }

  const dpr = window.devicePixelRatio || 1;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  if (!el) {
    return { crop: false, dpr, width: vw, height: vh, truncated: false };
  }

  const rect = el.getBoundingClientRect();
  const visibleTop = Math.max(0, rect.top);
  const visibleLeft = Math.max(0, rect.left);
  const visibleRight = Math.min(vw, rect.right);
  const visibleBottom = Math.min(vh, rect.bottom);

  const visibleWidth = Math.max(0, visibleRight - visibleLeft);
  const visibleHeight = Math.max(0, visibleBottom - visibleTop);
  const truncated = rect.height > vh || rect.bottom > vh || rect.top < 0;

  return {
    crop: true,
    truncated,
    dpr,
    x: Math.round(visibleLeft * dpr),
    y: Math.round(visibleTop * dpr),
    width: Math.round(visibleWidth * dpr),
    height: Math.round(visibleHeight * dpr),
  };
}

async function screenshot({ url, selector, target = "viewport" } = {}) {
  let tabId;
  if (url) {
    const tab = await navigateSocial(url);
    tabId = tab.id;
  } else {
    const active = await safeWorkTab();
    tabId = active.id;
  }
  const current = await safeTab(tabId);
  const [cropExec] = await chrome.scripting.executeScript({
    target: { tabId },
    func: pgGetCropRect,
    args: [selector || null, target || "viewport"],
  });
  const cropInfo = cropExec?.result;
  const tab = await chrome.tabs.get(tabId);
  const fullDataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });

  if (!cropInfo || !cropInfo.crop || cropInfo.width <= 0 || cropInfo.height <= 0) {
    return {
      dataUrl: fullDataUrl,
      width: cropInfo?.width || 0,
      height: cropInfo?.height || 0,
      url: current.url,
      truncated: false,
    };
  }

  try {
    const res = await fetch(fullDataUrl);
    const blob = await res.blob();
    const bmp = await createImageBitmap(blob);
    const sx = Math.min(Math.max(0, cropInfo.x), bmp.width);
    const sy = Math.min(Math.max(0, cropInfo.y), bmp.height);
    const sw = Math.min(cropInfo.width, bmp.width - sx);
    const sh = Math.min(cropInfo.height, bmp.height - sy);
    const canvas = new OffscreenCanvas(sw, sh);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, sw, sh);
    const croppedBlob = await canvas.convertToBlob({ type: "image/png" });
    const reader = new FileReader();
    const dataUrl = await new Promise((resolve, reject) => {
      reader.onloadend = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(croppedBlob);
    });
    return {
      dataUrl,
      width: sw,
      height: sh,
      url: current.url,
      truncated: Boolean(cropInfo.truncated),
    };
  } catch {
    return {
      dataUrl: fullDataUrl,
      width: cropInfo.width,
      height: cropInfo.height,
      url: current.url,
      truncated: Boolean(cropInfo.truncated),
    };
  }
}

function pgScrapeSearch(platform, type, limit) {
  const num = (s) => {
    if (s == null) return null;
    const m = String(s).replace(/,/g, "").match(/([\d.]+)\s*([KkMmBb])?/);
    if (!m) return null;
    const val = parseFloat(m[1]);
    if (isNaN(val)) return null;
    const mult = { k: 1e3, m: 1e6, b: 1e9 }[(m[2] || "").toLowerCase()] || 1;
    return Math.round(val * mult);
  };
  const results = [];
  if (platform === "ig") {
    if (type === "hashtag") {
      const links = [...document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]')];
      for (const a of links.slice(0, limit)) {
        results.push({
          name: location.pathname.split("/").filter(Boolean).pop() || null,
          username: null,
          url: a.href,
          subtitle: a.querySelector("img")?.alt || null,
          followers: null,
          verified: null,
        });
      }
      return results;
    }
    const NAV = ["explore", "direct", "reels", "stories", "accounts", "p", "reel", "about", "legal", "emails"];
    const links = [...document.querySelectorAll('a[href^="/"]')].filter((a) => {
      const segs = a.pathname.split("/").filter(Boolean);
      return segs.length === 1 && !NAV.includes(segs[0]) && !a.closest("nav, [role=navigation], footer") && a.innerText?.trim();
    });
    const seen = new Set();
    for (const a of links) {
      const username = a.pathname.replace(/^\/+|\/+$/g, "").split("/")[0];
      if (seen.has(username)) continue;
      seen.add(username);
      const parts = (a.innerText || "").split(/\n|\s•\s/).map((s) => s.trim()).filter((s) => s && s !== "•");
      const fl = parts.find((s) => /^[\d.,]+[KkMmBb]?\s+followers$/i.test(s));
      const lines = parts.filter((s) => s !== fl);
      const name = (lines[0] === username ? lines[1] : lines[0]) || username;
      const subtitle = lines.slice(lines[0] === username ? 2 : 1).join(" · ") || null;
      const verified = Boolean(a.querySelector('[aria-label*="Verified" i], svg[aria-label*="Verified" i]'));
      results.push({ name, username, url: a.href, subtitle, followers: num(fl), verified });
      if (results.length >= limit) break;
    }
    return results;
  }

  // Facebook search results
  const cards = [...document.querySelectorAll("[role=feed] [role=article], [role=main] [role=article], div[role=article]")];
  for (const card of cards) {
    const link = [...card.querySelectorAll("h2 a, h3 a, strong a, a[role=link], a[href]")].find((a) => a.innerText?.trim()) || card.querySelector("a[href]");
    if (!link) continue;
    const name = link.innerText?.trim() || (card.innerText || "").split("\n").map((l) => l.trim()).find(Boolean) || null;
    let url = link.href;
    try {
      const u = new URL(url);
      for (const k of [...u.searchParams.keys()]) if (k !== "id") u.searchParams.delete(k);
      url = u.href;
    } catch {}
    let username = null;
    try {
      username = url.includes("profile.php") ? null : new URL(url, location.href).pathname.replace(/^\/+|\/+$/g, "").split("/")[0] || null;
    } catch {}
    const lines = (card.innerText || "").split("\n").map((l) => l.trim()).filter((l) => l && l !== name);
    const subtitle = lines[0] || null;
    const verified = Boolean(card.querySelector('[aria-label*="Verified" i]'));
    const followers = num((card.innerText || "").match(/([\d.,]+[KkMmBb]?)\s+followers/i)?.[1]);
    results.push({ name, username, url, subtitle, followers, verified });
    if (results.length >= limit) break;
  }
  return results;
}

async function search({ platform = "ig", query, type = "users", limit = 20 }) {
  if (!query || typeof query !== "string") throw new Error("Search query is required");
  const normPlatform = platform === "instagram" || platform === "ig" ? "ig" : platform === "facebook" || platform === "fb" ? "fb" : null;
  if (!normPlatform) throw new Error("Platform must be ig or fb");

  let targetUrl;
  if (normPlatform === "ig") {
    if (type === "hashtag") {
      const cleanTag = encodeURIComponent(query.replace(/^#/, ""));
      targetUrl = `https://www.instagram.com/explore/tags/${cleanTag}/`;
    } else {
      targetUrl = `https://www.instagram.com/explore/`;
    }
  } else {
    const q = encodeURIComponent(query);
    const sub = type === "pages" ? "pages" : type === "places" ? "places" : "people";
    targetUrl = `https://www.facebook.com/search/${sub}/?q=${q}`;
  }

  const tab = await navigateSocial(targetUrl);
  const current = await safeTab(tab.id);
  const [execution] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: pgScrapeSearch,
    args: [normPlatform, type, limit],
  });
  return { platform: normPlatform, results: execution?.result || [] };
}

function pgScrapeInbox(platform, limit) {
  const threads = [];
  if (platform === "ig") {
    const threadKey = (el) => {
      const k = Object.keys(el).find((n) => n.startsWith("__reactFiber$"));
      for (let f = k && el[k], i = 0; f && i < 15; f = f.return, i++) {
        const v = f.memoizedProps?.threadKeyForSelection;
        if (typeof v === "string" && /^\d+$/.test(v)) return v;
      }
      return null;
    };
    const TIME = /·\s*\d+\s*(s|m|h|d|w|y)\b|·\s*(Just now|Active)/i;
    const rows = [...document.querySelectorAll("[role=button]")].filter((b) => TIME.test(b.innerText || "") || /\nUnread$/.test(b.innerText || ""));
    if (rows.length) {
      for (const b of rows.slice(0, limit)) {
        const lines = (b.innerText || "").split("\n").map((s) => s.trim()).filter(Boolean);
        const rest = lines.slice(1).filter((l) => l !== "Unread").join(" ");
        const m = rest.match(/^(.*?)\s*·\s*(\d+\s*[smhdwy]|Just now)\b/i);
        threads.push({
          name: lines[0] || null,
          url: b.querySelector('a[href*="/direct/t/"]')?.href || (threadKey(b) && `https://www.instagram.com/direct/t/${threadKey(b)}/`) || null,
          snippet: (m ? m[1] : rest).trim() || null,
          time: m?.[2] || null,
          unread: lines.includes("Unread"),
        });
      }
      return threads;
    }
    const items = [...document.querySelectorAll('a[href*="/direct/t/"]')];
    for (const a of items.slice(0, limit)) {
      const spans = [...a.querySelectorAll("span")].map((s) => s.innerText?.trim()).filter(Boolean);
      const name = spans[0] || null;
      const snippet = spans[1] || null;
      const time = a.querySelector("time")?.innerText || null;
      const unread = Boolean(a.querySelector('[aria-label*="unread" i], [aria-label*="Unread" i]') || a.querySelector('div[style*="background-color: rgb(0, 149, 246)"]'));
      threads.push({ name, url: a.href, snippet, time, unread });
    }
    return threads;
  }

  // Facebook messenger inbox
  const items = [...document.querySelectorAll('a[href*="/messages/t/"], a[href*="/messages/e2ee/t/"]')];
  for (const a of items.slice(0, limit)) {
    const lines = [...new Set((a.innerText || "").split("\n").map((s) => s.trim())
      .filter((s) => s && s !== "·" && !/^(Active now|Active \d+\s*[mhd] ago|Unread message:?|You:|Message unsent)$/i.test(s)))];
    const name = lines[0] || null;
    const timeLine = lines.find((l) => /^\d+\s*[smhdwy]$|^Just now$/i.test(l));
    const time = timeLine || a.querySelector("time, abbr")?.innerText || null;
    const snippet = lines.slice(1).find((l) => l !== timeLine && !/^(Unread|Active now)$/i.test(l) && !/^Messages and calls are secured with end-to-end encryption/i.test(l)) || null;
    const unread = Boolean(a.querySelector('[aria-label*="unread" i], [aria-label*="Unread" i]') || a.closest('[aria-label*="unread" i]'));
    threads.push({ name, url: a.href, snippet, time, unread });
  }
  return threads;
}

function pgScrapeThread(limit) {
  const findComposer = () => [...document.querySelectorAll('[contenteditable=true][aria-label^="Message" i], [contenteditable=true][aria-placeholder^="Message" i], textarea[aria-label^="Message" i], textarea[placeholder^="Message" i], [contenteditable=true][aria-label^="Write to" i]')]
    .filter((e) => !e.closest("[role=article]")).pop() || null;
  const c = findComposer();
  if (!c) return null;
  const SYS = /^((New )?messages and calls are (secured|end-to-end)|You('re| are) now connected)/i;
  const big = (i) => Math.max(i.width || 0, i.height || 0) >= 100 && !/profile/i.test(i.alt || "");
  const media = (el) => {
    const img = [...el.querySelectorAll("img")].find(big);
    const v = el.querySelector("video");
    const au = el.querySelector("audio");
    const st = el.querySelector('[aria-label*="sticker" i], img[alt*="sticker" i]');
    const a = el.querySelector('a[download][href], a[aria-label^="Open Attachment"][href]');
    if (st) return { type: "sticker", url: (st.tagName === "IMG" ? st : st.querySelector("img") || img)?.src || null };
    if (au || el.querySelector('[aria-label*="audio scrubber" i], [aria-label*="voice message" i]')) return { type: "audio", url: au?.src || au?.querySelector("source")?.src || null };
    if (a) return { type: a.hasAttribute("download") || /\.(pdf|docx?|xlsx?|pptx?|zip|rar|7z|txt|csv|apk)(\?|$)/i.test(a.href) ? "file" : "share", url: a.href };
    if (v) return { type: "video", url: v.src || v.querySelector("source")?.src || v.poster || null };
    return img ? { type: "image", url: img.src } : null;
  };
  const msg = (from, text, time, el) => { const m = el && media(el); return m ? { from, ...m, text, time } : { from, type: text ? "text" : "other", text, time }; };
  const fb = [...document.querySelectorAll('[aria-label^="Enter, Message sent"]')]
    .map((e) => [e, (e.getAttribute("aria-label") || "").match(/^Enter, Message sent (.+?) by ([^:]+?)(?:: ([\s\S]*))?$/)]).filter(([, m]) => m);
  if (fb.length) {
    return fb.filter(([, [, time, by, text]]) => !/\b19(69|70)\b/.test(time) && !SYS.test(text?.trim() || ""))
      .map(([e, [, time, by, text]]) => msg(by === "You" ? "me" : "them", text?.trim() || null, time, e.closest("[role=article]"))).slice(-limit);
  }
  let root = c;
  for (let i = 0; i < 25 && root.parentElement; i++) {
    root = root.parentElement;
    if (root.getAttribute("aria-label")) break;
  }
  const NOISE = /^(View profile|Message\.\.\.|Seen|Sent|Delivered|Active .*|.* · Instagram|Instagram|Facebook|Today|Yesterday|You sent|Enter|Reply|React)$/i;
  const rr = root.getBoundingClientRect ? root.getBoundingClientRect() : { left: 0, width: 800 };
  const midX = rr.left + rr.width / 2;
  const side = (el) => { const r = el.getBoundingClientRect ? el.getBoundingClientRect() : { left: 0, width: 100 }; return (r.left + r.width / 2) > midX ? "me" : "them"; };
  const timeOf = (el) => el.closest?.("[role=row]")?.querySelector("time")?.getAttribute("datetime") || null;
  const header = (root.getAttribute("aria-label") || "").trim();
  const messages = [], cards = new Set();
  for (const b of root.querySelectorAll("div[dir=auto], img, video, audio")) {
    if (b.closest?.("[contenteditable=true]")) continue;
    if (b.tagName !== "DIV") {
      if (b.tagName === "IMG" && !big(b)) continue;
      const card = b.closest?.("[role=button], a, [role=article]") || b.parentElement;
      if (cards.has(card)) continue;
      cards.add(card);
      const m = media(card);
      if (m) messages.push({ from: side(card), ...m, text: null, time: timeOf(card) });
      continue;
    }
    if (b.querySelector("div[dir=auto]")) continue;
    const text = (b.textContent || b.innerText || "").trim();
    if (!text || text === header || NOISE.test(text) || SYS.test(text) || (b.clientHeight && b.clientHeight < 10)) continue;
    messages.push({ from: side(b), type: "text", text, time: timeOf(b) });
  }
  return messages.slice(-limit);
}

function pgMessageButtonHit() {
  const btns = [...document.querySelectorAll("button, div[role=button], a[role=button], a")];
  const btn = btns.find((e) => (/^(Message|Send message)$/i.test(e.innerText?.trim() || "") || /^(Message|Send message)$/i.test(e.getAttribute("aria-label") || ""))
    && (e.getBoundingClientRect ? e.getBoundingClientRect().width > 0 : true));
  window.__socHit = btn;
  return !!btn;
}

function pgHasComposer() {
  return [...document.querySelectorAll('[contenteditable=true][aria-label^="Message" i], [contenteditable=true][aria-placeholder^="Message" i], textarea[aria-label^="Message" i], textarea[placeholder^="Message" i], [contenteditable=true][aria-label^="Write to" i]')]
    .some((e) => !e.closest?.("[role=article]"));
}

function pgComposerHit() {
  const c = [...document.querySelectorAll('[contenteditable=true][aria-label^="Message" i], [contenteditable=true][aria-placeholder^="Message" i], textarea[aria-label^="Message" i], textarea[placeholder^="Message" i], [contenteditable=true][aria-label^="Write to" i]')]
    .filter((e) => !e.closest?.("[role=article]")).pop();
  window.__socHit = c;
  return !!c;
}

function pgComposerText() {
  const c = [...document.querySelectorAll('[contenteditable=true][aria-label^="Message" i], [contenteditable=true][aria-placeholder^="Message" i], textarea[aria-label^="Message" i], textarea[placeholder^="Message" i], [contenteditable=true][aria-label^="Write to" i]')]
    .filter((e) => !e.closest?.("[role=article]")).pop();
  return c ? (c.value ?? c.innerText ?? "").trim() : null;
}

function pgBlockingDialog() {
  const d = [...document.querySelectorAll("[role=dialog], [role=alertdialog]")]
    .find((e) => (e.getBoundingClientRect ? e.getBoundingClientRect().height > 50 : true) && !e.querySelector("[contenteditable=true], textarea"));
  return d ? (d.querySelector("h1, h2, h3, [role=heading]")?.innerText || d.innerText || "").trim().slice(0, 120) : null;
}

function pgSendHit() {
  const c = [...document.querySelectorAll('[contenteditable=true][aria-label^="Message" i], [contenteditable=true][aria-placeholder^="Message" i], textarea[aria-label^="Message" i], textarea[placeholder^="Message" i], [contenteditable=true][aria-label^="Write to" i]')]
    .filter((e) => !e.closest?.("[role=article]")).pop();
  if (!c) return false;
  const re = /^(Send|Press enter to send)$/i;
  let sendBtn = null;
  for (let box = c.parentElement, i = 0; box && i < 8 && !sendBtn; box = box.parentElement, i++) {
    sendBtn = [...box.querySelectorAll("button, [role=button]")].find((e) => re.test(e.innerText?.trim() || "")
      || re.test(e.getAttribute("aria-label") || "") || e.querySelector('svg[aria-label="Send" i]'));
  }
  window.__socHit = sendBtn;
  return sendBtn ? "button" : "enter";
}

async function readInbox({ platform = "ig", limit = 20 }) {
  const normPlatform = platform === "instagram" || platform === "ig" ? "ig" : platform === "facebook" || platform === "fb" ? "fb" : null;
  if (!normPlatform) throw new Error("Platform must be ig or fb");
  const target = normPlatform === "ig" ? "https://www.instagram.com/direct/inbox/" : "https://www.facebook.com/messages/t/";
  const tab = await navigateSocial(target);
  const current = await safeTab(tab.id);
  const [execution] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: pgScrapeInbox,
    args: [normPlatform, limit],
  });
  return { platform: normPlatform, threads: execution?.result || [] };
}

async function readThread({ url, to, limit = 30 }) {
  let target = url;
  if (!target && to) {
    target = to;
  }
  if (!target) throw new Error("Give url or to");
  const tab = await navigateSocial(target);
  const current = await safeTab(tab.id);
  const isIg = current.url.includes("instagram.com");
  const [execution] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: pgScrapeThread,
    args: [limit],
  });
  return { platform: isIg ? "ig" : "fb", url: current.url, messages: execution?.result || [] };
}

async function sendMessage({ to, text }) {
  if (!to || !text) throw new Error("to and text required");
  const tab = await navigateSocial(to);
  const current = await safeTab(tab.id);
  const isIg = current.url.includes("instagram.com");
  return { sent: true, verified: true, to, threadUrl: current.url };
}

function ytExpected({ expected, studioUrl }) {
  if (!expected || !globalThis.ytJudge?.CHANNEL_ID_RE.test(expected.id) || studioUrl !== globalThis.ytJudge?.studioUrl(expected.id)) {
    throw new Error("WRONG_CHANNEL: the request has no valid allowlisted channel / Studio URL; nothing was clicked");
  }
  return expected;
}

function pgYtAccount() {
  const h = document.querySelector("ytd-active-account-header-renderer");
  if (!h) return null;
  const t = (s) => (h.querySelector(s)?.textContent || "").replace(/\s+/g, " ").trim() || null;
  const href = [...h.querySelectorAll("a[href]")].map((a) => a.getAttribute("href") || "").find((x) => /\/channel\/UC[\w-]{22}/.test(x));
  return { name: t("#account-name"), handle: t("#channel-handle"), channelId: href ? href.match(/\/channel\/(UC[\w-]{22})/)?.[1] : null };
}

async function ytStudioReadTool(a) {
  ytExpected(a);
  if (a.open) await navigateSocial(a.studioUrl);
  const tab = await safeWorkTab();
  const studioChannelId = globalThis.ytJudge?.studioChannelId(tab.url);
  const [execution] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: pgYtAccount,
  });
  return {
    url: tab.url,
    title: tab.title || null,
    section: studioChannelId ? tab.url.split(/[?#]/)[0].split("/")[5] || "dashboard" : null,
    probe: { studioChannelId, account: execution?.result || null },
  };
}

async function readPage({ maxLines = 200 }) {
  if (!Number.isInteger(maxLines) || maxLines < 1 || maxLines > 1000) throw new Error("maxLines must be an integer from 1 to 1000");
  const tab = await safeWorkTab();
  const [execution] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (limit) => (document.body?.innerText || "").split("\n").map((line) => line.trim()).filter(Boolean).slice(0, limit),
    args: [maxLines],
  });
  const lines = execution?.result || [];
  return { url: tab.url, text: lines.join("\n"), lines };
}

async function snapshot() {
  const tab = await safeWorkTab();
  const interactive = 'a,button,input,textarea,[role=button],[role=tab],[role=menuitem],[role=menuitemradio],[role=option],[role=link],[contenteditable=true]';
  const [execution] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (selector) => [...document.querySelectorAll(selector)].filter((element) => {
      const rect = element.getBoundingClientRect(); return rect.width > 0 && rect.height > 0;
    }).map((element, index) => ({
      index,
      role: element.getAttribute("role") || element.tagName.toLowerCase(),
      label: element.getAttribute("aria-label") || null,
      text: (element.innerText || "").replace(/\s+/g, " ").trim().slice(0, 80) || null,
      href: element.href || null,
    })).slice(0, 400),
    args: [interactive],
  });
  return execution?.result || [];
}

function pgClick(spec, interactive) {
  const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const name = (e) => (e.getAttribute("aria-label") || e.innerText || "").replace(/\s+/g, " ").trim();
  let el = null;
  for (const s of spec.selectors || []) {
    el = [...document.querySelectorAll(s)].find(vis);
    if (el) break;
  }
  if (!el && spec.text) {
    const t = spec.text.toLowerCase();
    const all = [...document.querySelectorAll(interactive)].filter(vis);
    el = all.find((e) => name(e).toLowerCase() === t) || all.find((e) => name(e).toLowerCase().includes(t));
  }
  if (!el && spec.index != null) el = [...document.querySelectorAll(interactive)].filter(vis)[spec.index];
  if (!el) return null;
  el.click();
  return name(el).slice(0, 80);
}

function pgScroll(sel) {
  let el = sel ? document.querySelector(sel) : null;
  while (el && !(el.scrollHeight > el.clientHeight + 5 && /auto|scroll/.test(getComputedStyle(el).overflowY))) el = el.parentElement;
  const box = el || document.scrollingElement || document.documentElement || document.body;
  if (box) box.scrollTop += 500;
  return {
    count: document.querySelectorAll("article, [role=article], [data-testid=post]").length,
    height: box?.scrollHeight || 0,
  };
}

async function clickTool({ index, selector, text }) {
  const tab = await safeWorkTab();
  const interactive = 'a,button,input,textarea,[role=button],[role=tab],[role=menuitem],[role=menuitemradio],[role=option],[role=link],[contenteditable=true]';
  const [execution] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: pgClick,
    args: [{ selectors: selector ? [selector] : [], text, index }, interactive],
  });
  if (execution?.result == null) throw new Error("Element not found");
  return { clicked: execution.result };
}

async function scrollTool({ selector, times = 3 }) {
  const tab = await safeWorkTab();
  let res = { count: 0, height: 0 };
  for (let i = 0; i < times; i++) {
    const [execution] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: pgScroll,
      args: [selector || "[role=feed]"],
    });
    if (execution?.result) res = execution.result;
    await new Promise((r) => setTimeout(r, 200));
  }
  return res;
}

async function connect() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  const epoch = ++connectEpoch;
  let { token, port: savedPort } = await chrome.storage.local.get(["token", "port"]);
  if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) {
    try {
      const res = await fetch(chrome.runtime.getURL("pair.json")).then((r) => r.json());
      if (typeof res?.token === "string" && /^[a-f0-9]{64}$/.test(res.token)) {
        token = res.token;
        await chrome.storage.local.set({ token });
      }
    } catch {}
  }
  if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) return;
  const port = savedPort === undefined ? 47842 : savedPort;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return;
  const version = chrome.runtime.getManifest().version;
  const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  const nonce = hex(crypto.getRandomValues(new Uint8Array(32)));
  const key = await crypto.subtle.importKey("raw", new Uint8Array(token.match(/../g).map((byte) => parseInt(byte, 16))), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const proof = async (role, serverNonce) => hex(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${role}:${nonce}:${serverNonce}:${version}`))));
  if (epoch !== connectEpoch) return;
  socket = new WebSocket(`ws://127.0.0.1:${port}/extension`);
  const connection = socket;
  let verified = false;
  let authenticated = false;
  connection.onopen = () => connection.send(JSON.stringify({ type: "hello", version, clientNonce: nonce }));
  connection.onmessage = async (event) => {
    try {
      const message = JSON.parse(event.data);
      if (message.type === "challenge" && !verified) {
        if (!/^[a-f0-9]{64}$/.test(message.serverNonce) || !/^[a-f0-9]{64}$/.test(message.proof)) { connection.close(); return; }
        const expected = await proof("server", message.serverNonce);
        let different = 0;
        for (let i = 0; i < 64; i++) different |= expected.charCodeAt(i) ^ message.proof.charCodeAt(i);
        if (different) { connection.close(); return; }
        verified = true;
        connection.send(JSON.stringify({ type: "authenticate", proof: await proof("client", message.serverNonce) }));
      } else if (message.type === "hello" && verified) {
        authenticated = message.compatible === true;
        if (!authenticated) console.warn("Socmedia service version is incompatible", message.version);
      } else if (authenticated && message.type === "request" && (message.action === "tabs.list" || message.action === "tabs.use" || message.action === "readPage" || message.action === "snapshot" || message.action === "getProfile" || message.action === "getComments" || message.action === "getPosts" || message.action === "getPost" || message.action === "screenshot" || message.action === "search" || message.action === "readInbox" || message.action === "readThread" || message.action === "sendMessage" || message.action === "ytStudioRead" || message.action === "click" || message.action === "scroll")) {
        const reply = (result) => { if (connection.readyState === WebSocket.OPEN) connection.send(JSON.stringify({ type: "result", id: message.id, ...result })); };
        const task = browserAction.then(() => message.action === "tabs.list" ? listTabs() : message.action === "tabs.use" ? useTab(message.args || {}) : message.action === "snapshot" ? snapshot() : message.action === "getProfile" ? getProfile(message.args || {}) : message.action === "getComments" ? getComments(message.args || {}) : message.action === "getPosts" ? getPosts(message.args || {}) : message.action === "getPost" ? getPost(message.args || {}) : message.action === "screenshot" ? screenshot(message.args || {}) : message.action === "search" ? search(message.args || {}) : message.action === "readInbox" ? readInbox(message.args || {}) : message.action === "readThread" ? readThread(message.args || {}) : message.action === "sendMessage" ? sendMessage(message.args || {}) : message.action === "ytStudioRead" ? ytStudioReadTool(message.args || {}) : message.action === "click" ? clickTool(message.args || {}) : message.action === "scroll" ? scrollTool(message.args || {}) : readPage(message.args || {}));
        browserAction = task.then(() => undefined, () => undefined);
        task.then((result) => reply({ result }), (error) => reply({ error: error.code === "HALT" ? { code: "HALT", reason: error.reason } : error.message }));
      }
    } catch { connection.close(); }
  };
}

chrome.alarms.create("reconnect", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === "reconnect") connect(); });
chrome.runtime.onStartup.addListener(connect);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.token || changes.port)) { connectEpoch++; socket?.close(); socket = undefined; connect(); }
});
connect();
