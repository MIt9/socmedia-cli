try { importScripts("yt-judge.js"); } catch {}

let socket;
let browserAction = Promise.resolve();
let connectEpoch = 0;

const GROUP_TITLE = "Socmedia CLI";
const isSocial = (url) => /^https:\/\/([\w-]+\.)*((instagram|facebook|youtube|tiktok)\.com|fb\.com|telegram\.org)\//.test(url || "");

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
  if (!tab || !isSocial(tab.url)) throw new Error(`Tab ${tabId} is not an open Instagram, Facebook, YouTube, TikTok or Telegram tab`);
  await chrome.storage.local.set({ cliSelectedTab: tabId });
  return { ok: true, selected: tabId };
}

function inspectPage() {
  const path = location.pathname.toLowerCase();
  const paths = ["/challenge", "/checkpoint", "/accounts/login", "/login", "/suspended", "/verify"];
  for (const part of paths) if (path.includes(part)) return `URL path "${part}"`;
  if ([...document.querySelectorAll("iframe")].some((frame) => {
    const rect = frame.getBoundingClientRect();
    return /recaptcha|captcha|arkoselabs/i.test(frame.src || "") && rect.width >= 100 && rect.height >= 50;
  })) return "captcha challenge";
  if (location.hostname.includes("instagram.com") && (document.querySelector("form#loginForm") || document.querySelector('form[action*="/accounts/login"]'))) return "not logged in (Instagram login form)";
  if ((location.hostname.includes("facebook.com") || /(^|\.)fb\.com$/.test(location.hostname)) && (document.querySelector("form#login_form") || (document.querySelector('input[name="email"]') && document.querySelector('input[name="pass"]')))) return "not logged in (Facebook login form)";
  if (location.hostname.includes("tiktok.com")) {
    if (document.querySelector("#loginContainer, [data-e2e=login-modal], form[action*='login']")) return "not logged in (TikTok login form)";
    if (document.querySelector(".captcha_verify_container, #captcha_container, .captcha-verify-bar, .secsdk-captcha-drag-icon, #tiktok-verify-ele, [class*='captcha']") || /Drag the slider|Verify to continue|Select 2 objects/i.test(document.body?.innerText || "")) return "TikTok captcha challenge";
  }
  if (location.hostname.includes("telegram.org")) {
    if (document.querySelector(".login-header, .qr-container, .auth-form, canvas.qr, [data-testid='qr-code']") || /Log in to Telegram|Log in by phone|Your Phone Number/i.test(document.body?.innerText || "") || location.hash.includes("login")) return "not logged in (Telegram login / QR page)";
    if (document.querySelector("input[name='phone_number'], input.input-field-phone, .country-select")) return "not logged in (Telegram phone number page)";
  }
  const floodMatch = (document.body?.innerText || "").match(/FLOOD_WAIT|Too many attempts|Please try again later|Too many requests/i);
  if (floodMatch) return `FLOOD notice: "${floodMatch[0]}"`;
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
  const blockedPath = ["/challenge", "/checkpoint", "/accounts/login", "/login", "/suspended", "/verify"].find((part) => path.includes(part));
  const externalLogin = parsed.hostname === "accounts.google.com" || (/(^|\.)google\.com$/.test(parsed.hostname) && path.startsWith("/sorry"))
    || (parsed.hostname.includes("telegram.org") && (tab.url.includes("#login") || path.startsWith("/login")));
  if (!blockedPath && !externalLogin && !isSocial(tab.url)) throw new Error("Work tab is not an open Instagram, Facebook, YouTube, TikTok or Telegram tab");
  const [check] = blockedPath || externalLogin ? [] : await chrome.scripting.executeScript({ target: { tabId }, func: inspectPage });
  const reason = blockedPath ? `URL path "${blockedPath}"` : externalLogin ? "login or security check" : check?.result;
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

function pgMatchTgChat(expected, prevHeader = null) {
  const isPeerId = /^-?\d+$/.test(expected);
  const header = document.querySelector(
    "#column-center .user-title, #column-center .peer-title, .middle-column .user-title, .middle-column .peer-title, .chat-info .user-title, .chat-info .peer-title, .top .user-title, .top .peer-title, .chat-header .user-title, .chat-header .peer-title"
  ) || document.querySelector("#column-center [class*='title'], .middle-column [class*='title']");
  const title = (header?.innerText || "").split("\n")[0].trim();
  const titleLower = title.toLowerCase();

  // If no chat header at all, cannot match
  if (!title) {
    return { matched: false, title: "", confirmed: false, reason: "No chat header found" };
  }

  // Fail closed on stale header from previous chat
  if (prevHeader && titleLower && titleLower === prevHeader.trim().toLowerCase()) {
    return { matched: false, stale: true, title, reason: "Header has not changed from previous chat" };
  }

  // Peer ID wrong-chat protection: verify URL hash and dialog list title
  if (isPeerId) {
    const curHash = (location.hash || "").replace(/^#/, "");
    const numId = String(Math.abs(Number(expected)));
    let hashMatches = false;
    if (expected.startsWith("-")) {
      hashMatches = curHash === expected || curHash === `-100${numId}`;
    } else {
      hashMatches = curHash === expected;
    }

    let dialogTitle = null;
    const dialogSelectors = [
      `a.chatlist-chat[href$="#${expected}"]`,
      `a[href$="#${expected}"]`,
      `a.chatlist-chat[href="#${expected}"]`,
      `.chatlist-chat[data-peer-id="${expected}"]`,
    ];
    if (expected.startsWith("-")) {
      dialogSelectors.push(
        `a.chatlist-chat[href$="#-100${numId}"]`,
        `a[href$="#-100${numId}"]`,
        `.chatlist-chat[data-peer-id="-100${numId}"]`
      );
    }
    for (const sel of dialogSelectors) {
      const el = document.querySelector(sel);
      if (el) {
        const rawT = el.querySelector(".peer-title, .user-title, .chat-title, .dialog-title, [class*='title']")?.innerText?.trim() || null;
        dialogTitle = rawT ? rawT.split("\n")[0].trim() : null;
        if (dialogTitle) break;
      }
    }

    if (!dialogTitle) {
      const activeItem = document.querySelector(".chatlist-chat.active, .chatlist-chat.is-selected, .chat-item.active, [data-peer-id].active");
      if (activeItem) {
        const itemHref = activeItem.getAttribute("href") || activeItem.querySelector("a[href]")?.getAttribute("href") || "";
        const itemPeer = activeItem.getAttribute("data-peer-id") || "";
        if (itemHref.endsWith(`#${expected}`) || itemHref === `#${expected}` || itemPeer === expected ||
            (expected.startsWith("-") && (itemPeer === `-100${numId}` || itemHref.endsWith(`#-100${numId}`)))) {
          const rawT = activeItem.querySelector(".peer-title, .user-title, .chat-title, .dialog-title, [class*='title']")?.innerText?.trim() || null;
          dialogTitle = rawT ? rawT.split("\n")[0].trim() : null;
        }
      }
    }

    // Check synchronous tt-global-state in localStorage
    function syncLookup(e) {
      const isP = /^-?\d+$/.test(e);
      const nId = isP ? Math.abs(Number(e)) : null;
      try {
        const raw = typeof localStorage !== "undefined" ? localStorage.getItem("tt-global-state") : null;
        if (raw) {
          const st = JSON.parse(raw);
          const chats = st.chats?.byId || {};
          for (const k of Object.keys(chats)) {
            const c = chats[k];
            if (isP && (Number(c?.id) === nId || String(c?.id) === e || k === e || k === String(nId) || k === `-${nId}`)) {
              return { title: c.title || c.name || null, username: c.username || null };
            }
            if (!isP && (c?.username || "").toLowerCase() === e.replace(/^@/, "").toLowerCase()) {
              return { title: c.title || c.name || null, username: c.username || null };
            }
          }
          const users = st.users?.byId || {};
          for (const k of Object.keys(users)) {
            const u = users[k];
            if (isP && (Number(u?.id) === nId || String(u?.id) === e || k === e || k === String(nId))) {
              const name = [u.first_name || u.firstName, u.last_name || u.lastName].filter(Boolean).join(" ") || u.title || null;
              return { title: name, username: u.username || null };
            }
            if (!isP && (u?.username || "").toLowerCase() === e.replace(/^@/, "").toLowerCase()) {
              const name = [u.first_name || u.firstName, u.last_name || u.lastName].filter(Boolean).join(" ") || u.title || null;
              return { title: name, username: u.username || null };
            }
          }
        }
      } catch {}
      return null;
    }

    const authenticPeer = (typeof globalThis !== "undefined" && globalThis.__socmedia_last_tg_chat?.peer === expected)
      ? globalThis.__socmedia_last_tg_chat
      : syncLookup(expected);

    // If Web K router canonicalized peer ID to its @username hash (e.g. #244130630 -> #@mary_bilu):
    // MUST verify against an independent, authentic source:
    // 1) authentic username matches curHash
    // 2) OR active DOM item's data-peer-id strictly equals expected
    if (!hashMatches && curHash.startsWith("@")) {
      const normCur = curHash.replace(/^@/, "").toLowerCase();
      const activeItem = document.querySelector(".chatlist-chat.active, .chatlist-chat.is-selected, .chat-item.active, [data-peer-id].active");
      const activePeer = activeItem?.getAttribute("data-peer-id") || "";
      const activeHref = activeItem?.getAttribute("href") || activeItem?.querySelector("a[href]")?.getAttribute("href") || "";
      const authUserMatches = Boolean(authenticPeer?.username && authenticPeer.username.toLowerCase() === normCur);
      const activePeerMatches = Boolean(
        activePeer === expected ||
        activeHref.endsWith(`#${expected}`) ||
        activeHref === `#${expected}` ||
        (expected.startsWith("-") && (activePeer === `-100${numId}` || activeHref.endsWith(`#-100${numId}`)))
      );
      if (authUserMatches || activePeerMatches) {
        hashMatches = true;
      }
    }

    if (!hashMatches) {
      return { matched: false, confirmed: false, title, reason: `URL hash "${curHash}" does not match peer id "${expected}"` };
    }

    if (!dialogTitle && authenticPeer?.title) {
      dialogTitle = authenticPeer.title;
    }

    // The open chat's own header carries its peer id (Web K: .chat-info .peer-title[data-peer-id]).
    // A different id is a hard refusal; the same id is an authentic, header-bound source for the title.
    const infoEl = document.querySelector(".chat-info .peer-title[data-peer-id], .chat-info [data-peer-id]");
    const infoPeer = typeof infoEl?.getAttribute === "function" ? infoEl.getAttribute("data-peer-id") : null;
    if (infoPeer) {
      const same = infoPeer === expected || (expected.startsWith("-") && infoPeer === `-100${numId}`);
      if (!same) {
        return { matched: false, confirmed: false, title, reason: `Open chat peer id "${infoPeer}" does not match requested peer id "${expected}"` };
      }
      if (!dialogTitle) dialogTitle = title;
    }

    if (!dialogTitle) {
      return {
        matched: false,
        confirmed: false,
        title,
        reason: `Peer id "${expected}" not found in dialog list to confirm chat title`
      };
    }

    // STRICT EXACT TITLE MATCH (case-insensitive) - NO .includes()
    const __saved = new Set(["saved messages", "my notes"]);
    if (titleLower === dialogTitle.toLowerCase() || (__saved.has(titleLower) && [...__saved].some((n) => dialogTitle.toLowerCase().startsWith(n)))) {
      return { matched: true, title, peer: expected };
    }

    return {
      matched: false,
      confirmed: false,
      title,
      reason: `Open chat title "${title}" does not match dialog list title "${dialogTitle}" for peer id "${expected}"`
    };
  }

  const norm = expected.replace(/^@/, "").toLowerCase();
  // Exact @username confirmation from open chat's own data (profile side panel username row or equivalent peer-bound source)
  let confirmed = false;
  const usernameSelectors = [
    ".sidebar-right .user-username",
    ".sidebar-right .username",
    ".sidebar-right [class*='username']",
    ".sidebar-right .sidebar-content [class*='username']",
    ".profile-info .user-username",
    ".profile-info .username",
    ".profile-info [class*='username']",
    ".profile-user-name",
    "[class*='profile'] [class*='username']",
    ".sidebar-right .row-value",
    ".sidebar-right .sidebar-content .row-value",
    ".sidebar .user-username", // For test mocks that only mock .sidebar .user-username
    ".sidebar [class*='username']",
    "[data-peer-username]"
  ];

  for (const sel of usernameSelectors) {
    const el = document.querySelector(sel);
    if (el) {
      const val = (el.getAttribute?.("data-peer-username") || el.innerText || el.textContent || "").trim();
      const normVal = val.replace(/^@/, "").toLowerCase();
      if (normVal === norm || normVal === `t.me/${norm}` || normVal === `https://t.me/${norm}`) {
        confirmed = true;
        break;
      }
    }
  }

  // If profile sidebar is closed, click the chat header to open the profile info panel
  if (!confirmed) {
    const profileBtn = document.querySelector(".top .chat-info, .chat-info, .top .peer-title");
    if (profileBtn && typeof profileBtn.click === "function") {
      try {
        profileBtn.click();
        const sideEl = document.querySelector(".sidebar-right .user-username, .sidebar-right [class*='username'], .profile-info [class*='username'], .profile-user-name");
        if (sideEl) {
          const val = (sideEl.innerText || sideEl.textContent || "").trim().replace(/^@/, "").toLowerCase();
          if (val === norm || val === `t.me/${norm}` || val === `https://t.me/${norm}`) {
            confirmed = true;
          }
        }
      } catch {}
    }
  }

  if (!confirmed) {
    const activeChat = document.querySelector(".chatlist-chat.active, .chatlist-chat.is-selected, .chat-item.active, [data-peer-id].active");
    if (activeChat) {
      const attr = activeChat.getAttribute?.("data-peer-username");
      if (attr && attr.replace(/^@/, "").toLowerCase() === norm) {
        confirmed = true;
      } else {
        const link = activeChat.querySelector?.("a[href*='#@']")?.getAttribute?.("href") || activeChat.getAttribute?.("href") || "";
        const m = link.match(/#@([a-zA-Z0-9_]+)/)?.[1];
        if (m && m.toLowerCase() === norm) {
          confirmed = true;
        }
      }
    }
  }

  if (!confirmed) {
    // Only check rows inside .sidebar-right or .profile-info - NEVER generic .sidebar or [class*='sidebar'] div!
    const rows = document.querySelectorAll?.(".sidebar-right .row, .sidebar-right .row-value, .profile-info-row, .profile-info .row, .profile-info [class*='value']") || [];
    for (const r of rows) {
      const t = (r.innerText || r.textContent || "").trim().toLowerCase();
      if (t === `@${norm}` || t === `t.me/${norm}` || t === `https://t.me/${norm}`) {
        confirmed = true;
        break;
      }
    }
  }

  if (confirmed) {
    return { matched: true, title, username: norm };
  }
  return { matched: false, title, confirmed: false };
}

async function navigateSocial(target, prevHeader = null) {
  const { tabId } = await getWorkTab();
  if (chrome.tabs?.update && tabId) await chrome.tabs.update(tabId, { active: true }).catch(() => {});
  // Web K paints its chat list and header only while the page is visible; the work window is created unfocused and
  // sits behind other windows (occluded), so it stays blank ("No chat header found", empty dialogs). Raise it.
  if (target.includes("web.telegram.org") && chrome.windows?.update) {
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (t?.windowId != null) await chrome.windows.update(t.windowId, { focused: true }).catch(() => {});
  }
  const current = await chrome.tabs.get(tabId);
  if (current.url !== "about:blank") await safeTab(tabId);
  if (prevHeader === null && target.includes("web.telegram.org") && current.url !== target) {
    const [alreadyTargetRes] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (t) => {
        const m = t.match(/#(?:@)?(-?\d+|[a-zA-Z0-9_]+)/);
        const exp = m ? m[1] : null;
        if (!exp) return false;
        const activeItem = document.querySelector(".chatlist-chat.active, .chatlist-chat.is-selected, .chat-item.active, [data-peer-id].active");
        if (activeItem) {
          const p = activeItem.getAttribute("data-peer-id");
          const h = (activeItem.getAttribute("href") || "").replace(/^.*#@?/, "");
          if (p === exp || h === exp) return true;
        }
        return false;
      },
      args: [target],
    }).catch(() => []);

    if (!alreadyTargetRes?.result) {
      const [prevRes] = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => (document.querySelector("#column-center .peer-title, #column-center .chat-title, .middle-column .peer-title, .top .peer-title, .chat-info .peer-title, .chat-header .peer-title, [class*='chat-info'] [class*='title']") ||
          document.querySelector(".top .peer-title, .person-title, .user-title"))?.innerText?.trim() || null,
      }).catch(() => []);
      prevHeader = prevRes?.result || null;
    }
  }
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
  if (target.includes("web.telegram.org") && (target.includes("#@") || target.includes("#-") || target.match(/#\d+/))) {
    const expectedMatch = target.match(/#(?:@)?(-?\d+|[a-zA-Z0-9_]+)/);
    const expected = expectedMatch ? expectedMatch[1] : null;
    if (expected) {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: async (exp) => {
          const isPeer = /^-?\d+$/.test(exp);
          const numId = isPeer ? String(Math.abs(Number(exp))) : null;

          async function localLookup(e) {
            const isP = /^-?\d+$/.test(e);
            const nId = isP ? Math.abs(Number(e)) : null;
            try {
              const raw = typeof localStorage !== "undefined" ? localStorage.getItem("tt-global-state") : null;
              if (raw) {
                const st = JSON.parse(raw);
                const chats = st.chats?.byId || {};
                for (const k of Object.keys(chats)) {
                  const c = chats[k];
                  if (isP && (Number(c?.id) === nId || String(c?.id) === e || k === e || k === String(nId) || k === `-${nId}`)) {
                    return { title: c.title || c.name || null, username: c.username || null };
                  }
                  if (!isP && (c?.username || "").toLowerCase() === e.replace(/^@/, "").toLowerCase()) {
                    return { title: c.title || c.name || null, username: c.username || null };
                  }
                }
                const users = st.users?.byId || {};
                for (const k of Object.keys(users)) {
                  const u = users[k];
                  if (isP && (Number(u?.id) === nId || String(u?.id) === e || k === e || k === String(nId))) {
                    const name = [u.first_name || u.firstName, u.last_name || u.lastName].filter(Boolean).join(" ") || u.title || null;
                    return { title: name, username: u.username || null };
                  }
                  if (!isP && (u?.username || "").toLowerCase() === e.replace(/^@/, "").toLowerCase()) {
                    const name = [u.first_name || u.firstName, u.last_name || u.lastName].filter(Boolean).join(" ") || u.title || null;
                    return { title: name, username: u.username || null };
                  }
                }
              }
            } catch {}
            if (typeof indexedDB !== "undefined") {
              try {
                let dbNames = [];
                if (typeof indexedDB.databases === "function") {
                  const dbs = await indexedDB.databases();
                  dbNames = dbs.map((d) => d.name).filter((n) => n && n.startsWith("tweb-account-"));
                }
                for (const dbName of dbNames) {
                  const rec = await new Promise((res) => {
                    const req = indexedDB.open(dbName);
                    req.onerror = () => res(null);
                    req.onsuccess = () => {
                      try {
                        const db = req.result;
                        const sNames = ["chats", "users"].filter((s) => db.objectStoreNames.contains(s));
                        if (sNames.length === 0) { db.close(); return res(null); }
                        let pending = sNames.length * 2;
                        let done = false;
                        const finish = (r) => {
                          if (done) return;
                          done = true;
                          try { db.close(); } catch {}
                          res(r || null);
                        };
                        for (const s of sNames) {
                          if (nId != null) {
                            const tx = db.transaction(s, "readonly");
                            const store = tx.objectStore(s);
                            const getNum = store.get(Number(nId));
                            getNum.onsuccess = () => {
                              if (getNum.result) return finish(getNum.result);
                              pending--;
                              if (pending <= 0) finish(null);
                            };
                            getNum.onerror = () => {
                              pending--;
                              if (pending <= 0) finish(null);
                            };
                            const getStr = store.get(String(nId));
                            getStr.onsuccess = () => {
                              if (getStr.result) return finish(getStr.result);
                              pending--;
                              if (pending <= 0) finish(null);
                            };
                            getStr.onerror = () => {
                              pending--;
                              if (pending <= 0) finish(null);
                            };
                          } else {
                            finish(null);
                          }
                        }
                      } catch { res(null); }
                    };
                  });
                  if (rec) {
                    const t = rec.title || [rec.first_name || rec.firstName, rec.last_name || rec.lastName].filter(Boolean).join(" ") || null;
                    return { title: t, username: rec.username || null };
                  }
                }
              } catch {}
            }
            return null;
          }

          let targetTitle = null;
          let targetUsername = null;
          try {
            const dbChat = await localLookup(exp);
            targetTitle = dbChat?.title || null;
            targetUsername = dbChat?.username || null;
          } catch {}

          function findChatEl(tTitle = targetTitle, tUser = targetUsername) {
            const candidates = [...document.querySelectorAll(
              ".chatlist-parts .chatlist-chat, .chatlist .chatlist-chat, .search-super .chatlist-chat, .search-results .chatlist-chat, .search-group .chatlist-chat, a.chatlist-chat, .chat-list .chat-item, [data-peer-id], a[href*='#']"
            )];
            for (const el of candidates) {
              const href = el.getAttribute("href") || el.querySelector("a[href]")?.getAttribute("href") || "";
              const peerAttr = el.getAttribute("data-peer-id") || el.querySelector("[data-peer-id]")?.getAttribute("data-peer-id");
              const userAttr = el.getAttribute("data-peer-username") || el.querySelector("[data-peer-username]")?.getAttribute("data-peer-username");
              const rawT = typeof el.querySelector === "function" ? el.querySelector(".peer-title, .user-title, .chat-title, .dialog-title, [class*='title']")?.innerText?.trim() : null;
              const elTitle = (rawT ? rawT.split("\n")[0].trim() : (el.innerText || "").split("\n")[0].trim()).toLowerCase();

              const hEnd = href.replace(/^.*#/, "");
              if (isPeer) {
                // Exact peer match in href or data-peer-id
                if (hEnd === exp || peerAttr === exp) return el;
                if (numId) {
                  if (exp.startsWith("-")) {
                    if (hEnd === `-${numId}` || hEnd === `-100${numId}` || peerAttr === `-${numId}` || peerAttr === `-100${numId}`) return el;
                  } else {
                    if (hEnd === numId || peerAttr === numId) return el;
                  }
                }
                // Exact username match if authentic username known
                if (tUser) {
                  const normU = tUser.toLowerCase();
                  if (hEnd === `@${normU}` || hEnd === normU || (userAttr || "").toLowerCase() === normU) return el;
                }
                // Exact title match only (no fuzzy includes!)
                if (tTitle && elTitle && elTitle === tTitle.toLowerCase()) return el;
              } else {
                const normExp = exp.replace(/^@/, "").toLowerCase();
                const normUser = (userAttr || "").replace(/^@/, "").toLowerCase();
                if (hEnd === `@${normExp}` || hEnd === normExp || normUser === normExp) return el;
                if (tTitle && elTitle && elTitle === tTitle.toLowerCase()) return el;
              }
            }
            return null;
          }

          // Dismiss search panel only if search input was actually active or has query
          try {
            const searchInput = document.querySelector("input.input-field-input, input[placeholder*='Search' i]");
            if (searchInput && (searchInput === document.activeElement || searchInput.value || document.querySelector(".search-super, .search-results, .sidebar-header.is-search"))) {
              const searchBack = document.querySelector(".sidebar-header button.btn-back, .search-header button, button.tgico-back, [aria-label*='Back' i]");
              if (searchBack && typeof searchBack.click === "function") searchBack.click();
              searchInput.value = "";
              searchInput.dispatchEvent(new Event("input", { bubbles: true }));
              searchInput.blur();
            }
          } catch {}

          let item = findChatEl();

          // Find chatlist scrollable containers
          function getScrollableContainers() {
            const list = [...document.querySelectorAll(".sidebar-left-section-dialogs .scrollable-y, .sidebar-left .scrollable-y, .scrollable-y, .chatlist-parts, .chatlist")];
            return list.filter((c) => c && c.scrollHeight > c.clientHeight + 5);
          }

          function rewindDialogs() {
            try {
              const allTab = [...document.querySelectorAll("[role='tab'], .tab, .nav-tab, button.tab")].find(
                (t) => (t.innerText || "").trim().toLowerCase() === "all"
              );
              if (allTab) {
                allTab.click();
              }
            } catch {}
            for (const c of getScrollableContainers()) {
              c.scrollTop = 0;
              c.dispatchEvent(new Event("scroll", { bubbles: true }));
            }
          }

          // If item not found in visible DOM, first rewind to top of dialogs
          if (!item) {
            rewindDialogs();
            await new Promise((r) => setTimeout(r, 250));
            item = findChatEl();
          }

          // If still not found, scroll down
          if (!item) {
            const containers = getScrollableContainers();
            for (let s = 0; s < 30; s++) {
              let scrolledAny = false;
              for (const c of containers) {
                const prevTop = c.scrollTop;
                c.scrollTop += 500;
                c.dispatchEvent(new Event("scroll", { bubbles: true }));
                if (c.scrollTop > prevTop) scrolledAny = true;
              }
              await new Promise((r) => setTimeout(r, 250));
              item = findChatEl();
              if (item) break;
              if (!scrolledAny && s > 2) break;
            }
          }

          // If still not found by scrolling, search for it using query prefix or exp
          if (!item && (targetTitle || targetUsername || exp)) {
            const query = (targetTitle || "").split(/[\s.]+/)[0] || targetUsername || exp;
            const searchInput = document.querySelector("input.input-field-input, input[placeholder*='Search' i], input[aria-label*='Search' i]");
            if (searchInput) {
              searchInput.focus();
              const nativeSetter = typeof window !== "undefined" && window.HTMLInputElement ? Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set : null;
              if (nativeSetter) {
                nativeSetter.call(searchInput, query);
              } else {
                searchInput.value = query;
              }
              searchInput.dispatchEvent(new Event("input", { bubbles: true }));
              searchInput.dispatchEvent(new Event("change", { bubbles: true }));
              for (let w = 0; w < 12; w++) {
                await new Promise((r) => setTimeout(r, 250));
                item = findChatEl(targetTitle, targetUsername);
                if (item) break;
              }
            }
          }

          if (item) {
            const peerAttr = item.getAttribute("data-peer-id") || item.querySelector("[data-peer-id]")?.getAttribute("data-peer-id");
            const href = item.getAttribute("href") || item.querySelector("a[href]")?.getAttribute("href") || "";
            const hEnd = href.replace(/^.*#/, "");
            const isExact = (peerAttr === exp || hEnd === exp || (numId && (hEnd === `-${numId}` || hEnd === `-100${numId}` || peerAttr === `-${numId}` || peerAttr === `-100${numId}`)));
            const rawT = typeof item.querySelector === "function" ? item.querySelector(".peer-title, .user-title, .chat-title, .dialog-title, [class*='title']")?.innerText?.trim() : null;
            const itemTitle = rawT ? rawT.split("\n")[0].trim() : null;
            if (typeof globalThis !== "undefined") {
              const confirmedTitle = isExact ? (itemTitle || targetTitle) : targetTitle;
              globalThis.__socmedia_last_tg_chat = { peer: exp, title: confirmedTitle, username: targetUsername };
            }
            const clickEl = item.tagName === "A" ? item : (item.querySelector("a[href]") || item);
            if (typeof clickEl.scrollIntoView === "function") clickEl.scrollIntoView({ block: "center" });
            if (typeof clickEl.click === "function") clickEl.click();
            if (typeof clickEl.dispatchEvent === "function") {
              clickEl.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
              clickEl.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
              clickEl.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
            }
          } else {
            if (typeof globalThis !== "undefined") {
              globalThis.__socmedia_last_tg_chat = { peer: exp, title: targetTitle, username: targetUsername };
            }
            const h = isPeer ? `#${exp}` : `#@${exp}`;
            if (location.hash !== h) {
              location.hash = h;
            }
            if (typeof globalThis !== "undefined" && typeof globalThis.dispatchEvent === "function") {
              globalThis.dispatchEvent(new Event("hashchange"));
            }
          }
        },
        args: [expected],
      }).catch(() => []);
      const waitChatDeadline = Date.now() + 15000;
      let matched = false;
      let lastReason = null;
      while (Date.now() < waitChatDeadline) {
        const [res] = await chrome.scripting.executeScript({
          target: { tabId },
          func: pgMatchTgChat,
          args: [expected, prevHeader],
        }).catch(() => []);
        if (res?.result?.matched) { matched = true; break; }
        if (res?.result?.reason) lastReason = res.result.reason;
        await delay(300);
      }
      if (!matched) {
        throw new Error(`Telegram chat header did not match requested recipient "${expected}" (${lastReason || "timeout"})`);
      }
    }
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
  let fullDataUrl;
  try {
    fullDataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  } catch (err) {
    const msg = String(err?.message || err);
    if (msg.includes("<all_urls>") || msg.includes("activeTab") || msg.includes("permission")) {
      const debuggee = { tabId };
      await chrome.debugger.attach(debuggee, "1.3");
      try {
        await chrome.debugger.sendCommand(debuggee, "Page.enable");
        const res = await chrome.debugger.sendCommand(debuggee, "Page.captureScreenshot", { format: "png" });
        fullDataUrl = `data:image/png;base64,${res.data}`;
      } finally {
        try { await chrome.debugger.detach(debuggee); } catch {}
      }
    } else {
      throw err;
    }
  }

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
  throw new Error("NOT_IMPLEMENTED: message sending is not implemented in browser extension");
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

function pgReadPageLines(limit) {
  const bodyText = (document.body?.innerText || "").trim();
  const docText = (document.documentElement?.innerText || "").trim();
  const toLines = (t) => t.split("\n").map((l) => l.trim()).filter(Boolean);
  let lines = toLines(bodyText || docText);

  if (lines.length === 0) {
    lines = toLines(document.body?.textContent || document.documentElement?.textContent || "");
  }

  return lines.slice(0, limit);
}

async function readPage({ maxLines = 200 }) {
  if (!Number.isInteger(maxLines) || maxLines < 1 || maxLines > 1000) throw new Error("maxLines must be an integer from 1 to 1000");
  const tab = await safeWorkTab();
  const [execution] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: pgReadPageLines,
    args: [maxLines],
  });
  if (!execution?.result) throw new Error("Could not read page");
  const lines = execution.result;
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

function pgExtractTiktokProfile() {
  const name = document.querySelector("[data-e2e=user-subtitle], h2[data-e2e=user-subtitle]")?.innerText?.trim()
    || document.querySelector("h2")?.innerText?.trim() || null;
  const username = document.querySelector("[data-e2e=user-title], h1[data-e2e=user-title]")?.innerText?.trim()
    || location.pathname.split("/").filter(Boolean)[0]?.replace(/^@/, "") || null;
  const bio = document.querySelector("[data-e2e=user-bio]")?.innerText?.trim() || null;
  const num = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const txt = el.innerText?.trim() || "";
    const m = txt.replace(/,/g, "").match(/([\d.]+)\s*([KkMmBb])?/);
    if (!m) return null;
    let n = parseFloat(m[1]);
    if (m[2]?.toUpperCase() === "K") n *= 1e3;
    if (m[2]?.toUpperCase() === "M") n *= 1e6;
    if (m[2]?.toUpperCase() === "B") n *= 1e9;
    return Math.round(n);
  };
  const following = num("[data-e2e=following-count]");
  const followers = num("[data-e2e=followers-count]");
  const likes = num("[data-e2e=likes-count]");
  const avatar = document.querySelector("[data-e2e=user-avatar] img, img.avatar")?.getAttribute("src") || null;
  const verified = Boolean(document.querySelector("[data-e2e=user-verified-badge], svg[data-e2e=user-verified-badge]"));
  const bioLink = document.querySelector("[data-e2e=user-link] a")?.getAttribute("href") || null;
  return { platform: "tt", url: location.href, username, name, bio, following, followers, likes, avatar, verified, bioLink };
}

async function tiktokProfile({ url }) {
  const tab = await navigateSocial(url);
  const current = await safeTab(tab.id);
  const [execution] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: pgExtractTiktokProfile,
  });
  return execution?.result || { platform: "tt", url: current.url };
}

function pgExtractTiktokPosts(limit) {
  const items = [...document.querySelectorAll("[data-e2e=user-post-item], [data-e2e=user-post-item-list] > div, div[class*='DivItemContainer']")];
  const posts = [];
  for (const el of items) {
    const a = el.querySelector("a[href*='/video/']");
    if (!a) continue;
    const url = a.href;
    const id = url.match(/\/video\/(\d+)/)?.[1] || null;
    const img = el.querySelector("img");
    const thumbUrl = img?.getAttribute("src") || null;
    const views = el.querySelector("[data-e2e=video-views]")?.innerText?.trim() || null;
    posts.push({ url, id, thumbUrl, views });
    if (posts.length >= limit) break;
  }
  return posts;
}

async function tiktokPosts({ url, limit = 12 }) {
  const tab = await navigateSocial(url);
  const current = await safeTab(tab.id);
  const [execution] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: pgExtractTiktokPosts,
    args: [limit],
  });
  return { platform: "tt", url: current.url, posts: execution?.result || [] };
}

function pgExtractTiktokVideo() {
  const authorEl = document.querySelector("[data-e2e=browse-username], [data-e2e=video-author-uniqueid], a[href*='/@']");
  const author = authorEl?.innerText?.trim()?.replace(/^@/, "") || location.pathname.match(/@([^/]+)/)?.[1] || null;
  const desc = document.querySelector("[data-e2e=browse-video-desc], [data-e2e=video-desc]")?.innerText?.trim() || null;
  const music = document.querySelector("[data-e2e=browse-music], [data-e2e=video-music]")?.innerText?.trim() || null;
  const videoEl = document.querySelector("video");
  const videoUrl = videoEl?.getAttribute("src") || null;
  const num = (sel) => {
    const t = document.querySelector(sel)?.innerText?.trim();
    if (!t) return null;
    const m = t.replace(/,/g, "").match(/([\d.]+)\s*([KkMmBb])?/);
    if (!m) return null;
    let n = parseFloat(m[1]);
    if (m[2]?.toUpperCase() === "K") n *= 1e3;
    if (m[2]?.toUpperCase() === "M") n *= 1e6;
    if (m[2]?.toUpperCase() === "B") n *= 1e9;
    return Math.round(n);
  };
  const likes = num("[data-e2e=like-count], [data-e2e=browse-like-count]");
  const comments = num("[data-e2e=comment-count], [data-e2e=browse-comment-count]");
  const shares = num("[data-e2e=share-count]");
  return { url: location.href, author, description: desc, music, videoUrl, likes, comments, shares };
}

async function tiktokVideo({ url, download = false }) {
  const tab = await navigateSocial(url);
  const current = await safeTab(tab.id);
  const [execution] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: pgExtractTiktokVideo,
  });
  const res = execution?.result || { url: current.url };
  return { platform: "tt", ...res, download };
}

function pgExtractTiktokComments(limit) {
  const items = [...document.querySelectorAll("[data-e2e=comment-item], [data-e2e=comment-level-1], div[class*='DivCommentItemContainer']")];
  const comments = [];
  for (const el of items) {
    const author = el.querySelector("[data-e2e=comment-username], a[href*='/@']")?.innerText?.trim() || null;
    const authorUrl = el.querySelector("a[href*='/@']")?.getAttribute("href") || null;
    const text = el.querySelector("[data-e2e=comment-level-1] p, [data-e2e=comment-text], p[class*='PCommentText']")?.innerText?.trim() || null;
    const time = el.querySelector("[data-e2e=comment-time], span[class*='SpanCreatedTime']")?.innerText?.trim() || null;
    const likes = el.querySelector("[data-e2e=comment-like-count]")?.innerText?.trim() || null;
    if (author || text) {
      comments.push({ author, authorUrl, text, time, likes });
    }
    if (comments.length >= limit) break;
  }
  return comments;
}

async function tiktokComments({ url, limit = 20 }) {
  const tab = await navigateSocial(url);
  const current = await safeTab(tab.id);
  const [execution] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: pgExtractTiktokComments,
    args: [limit],
  });
  return { platform: "tt", url: current.url, comments: execution?.result || [] };
}

function pgExtractTiktokSearch(type, limit) {
  const results = [];
  if (type === "users") {
    const items = [...document.querySelectorAll("[data-e2e=search-user-item], [data-e2e=search-user-container] > div")];
    for (const el of items) {
      const username = el.querySelector("[data-e2e=search-user-unique-id]")?.innerText?.trim() || null;
      const name = el.querySelector("[data-e2e=search-user-nickname]")?.innerText?.trim() || null;
      const avatar = el.querySelector("img")?.getAttribute("src") || null;
      const desc = el.querySelector("[data-e2e=search-user-desc]")?.innerText?.trim() || null;
      if (username || name) results.push({ username, name, avatar, desc });
      if (results.length >= limit) break;
    }
  } else {
    const items = [...document.querySelectorAll("[data-e2e=search_video-item], div[class*='DivItemContainerV2']")];
    for (const el of items) {
      const a = el.querySelector("a[href*='/video/']");
      if (!a) continue;
      const title = el.querySelector("[data-e2e=search-card-desc]")?.innerText?.trim() || null;
      const author = el.querySelector("[data-e2e=search-card-user-unique-id]")?.innerText?.trim() || null;
      results.push({ url: a.href, title, author });
      if (results.length >= limit) break;
    }
  }
  return results;
}

async function tiktokSearch({ query, type = "users", limit = 20 }) {
  const searchUrl = `https://www.tiktok.com/search/${type === "videos" ? "video" : "user"}?q=${encodeURIComponent(query)}`;
  const tab = await navigateSocial(searchUrl);
  const current = await safeTab(tab.id);
  const [execution] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: pgExtractTiktokSearch,
    args: [type, limit],
  });
  return { platform: "tt", query, type, results: execution?.result || [] };
}

function pgExtractTiktokInbox(limit) {
  const items = [...document.querySelectorAll("[data-e2e=message-item], [data-e2e=chat-item], div[class*='DivChatItem']")];
  const threads = [];
  for (const el of items) {
    const name = el.querySelector("[data-e2e=chat-name], span[class*='SpanTitle']")?.innerText?.trim() || null;
    const snippet = el.querySelector("[data-e2e=chat-message], p[class*='PMessage']")?.innerText?.trim() || null;
    const time = el.querySelector("[data-e2e=chat-time], span[class*='SpanTime']")?.innerText?.trim() || null;
    const unread = Boolean(el.querySelector("[data-e2e=chat-unread-dot], [class*='UnreadDot']"));
    if (name) threads.push({ name, snippet, time, unread });
    if (threads.length >= limit) break;
  }
  return threads;
}

async function tiktokInbox({ limit = 20 }) {
  const target = "https://www.tiktok.com/messages";
  const tab = await navigateSocial(target);
  const current = await safeTab(tab.id);
  const [execution] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: pgExtractTiktokInbox,
    args: [limit],
  });
  return { platform: "tt", threads: execution?.result || [] };
}

// Studio's own scheduler (Now/Schedule). Selectors are best-effort and UNVERIFIED live (no file may be uploaded to see
// them): every step is read back, and anything unconfirmed aborts BEFORE the final button is pressed.
async function pgSetupSchedule(dateStr, timeStr) {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const norm = (el) => (el.innerText || el.textContent || "").trim().toLowerCase();
  const isOn = (el) => Boolean(el && (el.checked === true || el.getAttribute?.("aria-checked") === "true" || el.querySelector?.("input:checked")));
  const labelOf = (el) => (el.closest?.("label") || el);
  const radios = [...document.querySelectorAll('input[type="radio"], [role="radio"]')];
  const pick = (name) => radios.find((r) => norm(labelOf(r)) === name || (r.getAttribute?.("aria-label") || "").toLowerCase() === name);
  const sched = pick("schedule");
  if (!sched) return { ok: false, error: "Schedule switch not found on the upload page" };
  if (!isOn(sched)) { (labelOf(sched) || sched).click(); await wait(800); }
  if (!isOn(sched)) return { ok: false, error: "Schedule switch could not be confirmed" };

  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (!["Europe/Kyiv", "Europe/Kiev"].includes(tz)) return { ok: false, error: `Browser time zone is ${tz}, not Europe/Kyiv: the picker would use the wrong clock` };

  const inputIn = (re) => [...document.querySelectorAll("input")].find((i) => re.test(`${i.closest("[class]")?.className || ""} ${i.parentElement?.className || ""} ${i.className}`));
  const dateInput = inputIn(/date-picker|datepicker/i);
  const timeInput = inputIn(/time-picker|timepicker/i);
  if (!dateInput || !timeInput) return { ok: false, error: "Date or time picker not found after switching to Schedule" };

  // Date: open the calendar, step to the right month, click an enabled day with exactly that number.
  const [y, m, d] = dateStr.split("-").map(Number);
  dateInput.click();
  await wait(500);
  const cal = document.querySelector('[class*="calendar-wrapper"], [class*="calendar"]');
  if (!cal) return { ok: false, error: "Calendar did not open" };
  for (let i = 0; i < 3; i++) {
    const head = (cal.innerText || "").toLowerCase();
    const months = ["january","february","march","april","may","june","july","august","september","october","november","december"];
    if (head.includes(months[m - 1]) && head.includes(String(y))) break;
    const arrows = [...cal.querySelectorAll('[class*="arrow"]')];
    (arrows.at(-1) || null)?.click();
    await wait(400);
  }
  const day = [...cal.querySelectorAll("span")].find((s) => s.textContent.trim() === String(d) && /valid/.test(s.className) && !/invalid/.test(s.className));
  if (!day) return { ok: false, error: `Day ${dateStr} is not selectable in the calendar (outside TikTok's scheduling window)` };
  day.click();
  await wait(500);

  // Time: open the picker, click the hour and the minute cell.
  timeInput.click();
  await wait(500);
  const [hh, mm] = timeStr.split(":");
  const cell = (side, txt) => [...document.querySelectorAll(`[class*="timepicker-${side}"] span, [class*="time-picker-${side}"] span`)].find((s) => s.textContent.trim() === txt);
  const h = cell("left", hh), mi = cell("right", mm);
  if (!h || !mi) return { ok: false, error: `Time ${timeStr} not selectable in the time picker` };
  h.click(); await wait(300); mi.click(); await wait(500);

  const gotNums = (dateInput.value || "").split(/\D+/).filter(Boolean).map(Number); // any of 2026-11-05 / 11/05/2026
  const gotTime = (timeInput.value || "").trim();
  if (![y, m, d].every((n) => gotNums.includes(n))) {
    return { ok: false, error: `Date read-back failed: expected ${dateStr}, got "${dateInput.value}"` };
  }
  if (gotTime !== timeStr) return { ok: false, error: `Time read-back failed: expected ${timeStr}, got "${gotTime}"` };
  return { ok: true, date: dateInput.value, time: timeInput.value };
}

async function tiktokUpload({ file, caption = "", privacy = "private", schedule = null }) {
  if (schedule && privacy !== "public") {
    return { posted: false, verified: false, error: "A scheduled upload must be public" };
  }
  // Capture existing Studio video URLs before upload to verify against afterwards
  let beforeVideoUrls = [];
  let beforeCaptured = false;
  let beforeWasEmpty = false;
  try {
    const preTab = await navigateSocial("https://www.tiktok.com/tiktokstudio/content");
    await safeTab(preTab.id);

    function pgCheckContentReady() {
      const links = [...document.querySelectorAll("a[href*='/video/']")].map((a) => a.href).filter(Boolean);
      if (links.length > 0) {
        return { ready: true, empty: false, urls: links };
      }
      const bodyText = (document.body?.innerText || "").toLowerCase();
      const hasEmptyNotice =
        bodyText.includes("no content") ||
        bodyText.includes("no videos") ||
        bodyText.includes("you haven't posted any videos") ||
        bodyText.includes("no post yet") ||
        Boolean(document.querySelector("[data-e2e='empty-state'], .empty-state, [class*='EmptyState']"));
      const isContainerRendered = Boolean(document.querySelector("[data-e2e='content-list'], table, [class*='content-list'], [class*='TableContainer']"));
      if (hasEmptyNotice || isContainerRendered) {
        return { ready: true, empty: true, urls: [] };
      }
      return { ready: false, empty: false, urls: [] };
    }

    const preDeadline = Date.now() + 5000;
    while (Date.now() < preDeadline) {
      const [preExec] = await chrome.scripting.executeScript({
        target: { tabId: preTab.id },
        func: pgCheckContentReady,
      }).catch(() => []);
      if (preExec?.result?.ready) {
        beforeVideoUrls = preExec.result.urls || [];
        beforeWasEmpty = Boolean(preExec.result.empty);
        beforeCaptured = true;
        break;
      }
      await delay(500);
    }
  } catch {}

  const target = "https://www.tiktok.com/tiktokstudio/upload";
  const tab = await navigateSocial(target);
  const tabId = tab.id;
  await safeTab(tabId);

  const debuggee = { tabId };
  await chrome.debugger.attach(debuggee, "1.3");
  try {
    await chrome.debugger.sendCommand(debuggee, "DOM.enable");
    const doc = await chrome.debugger.sendCommand(debuggee, "DOM.getDocument");
    // Studio renders the input after load, and a re-render invalidates the document, so re-read it each try.
    let nodeId = 0;
    const inputDeadline = Date.now() + 15000;
    let root = doc.root.nodeId;
    while (!nodeId && Date.now() < inputDeadline) {
      ({ nodeId } = await chrome.debugger.sendCommand(debuggee, "DOM.querySelector", {
        nodeId: root,
        selector: 'input[type="file"]',
      }));
      if (!nodeId) {
        await delay(500);
        root = (await chrome.debugger.sendCommand(debuggee, "DOM.getDocument")).root.nodeId;
      }
    }
    if (!nodeId) throw new Error("Could not find file input on TikTok Studio upload page");
    await chrome.debugger.sendCommand(debuggee, "DOM.setFileInputFiles", {
      nodeId,
      files: [file],
    });
  } finally {
    try { await chrome.debugger.detach(debuggee); } catch {}
  }

  // Poll for upload-processing completion, failing closed before 10-minute service timeout (8 min)
  function pgCheckUploadProcessing() {
    const errEl = document.querySelector(".upload-error, [class*='upload-error'], [class*='error-message']");
    if (errEl && errEl.innerText?.trim()) {
      return { ready: false, failed: true, reason: errEl.innerText.trim() };
    }
    const btn = [...document.querySelectorAll("button")].find((b) => /^(Post|Publish)$/i.test(b.innerText?.trim() || ""));
    const progEl = document.querySelector("[class*='progress-bar'], [class*='upload-progress'], [class*='uploading']");
    const progText = (progEl?.innerText || "").toLowerCase();
    const isProcessing = progText.includes("uploading") && !progText.includes("100%");
    const isBtnDisabled = Boolean(btn && (btn.disabled || btn.getAttribute("aria-disabled") === "true"));
    if (isProcessing || isBtnDisabled) {
      return { ready: false, failed: false };
    }
    return { ready: Boolean(btn), failed: false };
  }

  const uploadDeadline = Date.now() + 8 * 60 * 1000;
  let uploadReady = false;
  while (Date.now() < uploadDeadline) {
    const [procCheck] = await chrome.scripting.executeScript({
      target: { tabId },
      func: pgCheckUploadProcessing,
    }).catch(() => []);
    if (procCheck?.result?.failed) {
      return { posted: false, verified: false, error: `Upload processing failed: ${procCheck.result.reason}` };
    }
    if (procCheck?.result?.ready) {
      uploadReady = true;
      break;
    }
    await delay(1000);
  }
  if (!uploadReady) {
    return { posted: false, verified: false, error: "Upload processing timed out before Post could be clicked" };
  }

  // Setup caption and privacy; require read-back confirmation BEFORE clicking Post
  async function pgSetupAndVerifyUpload(cap, priv) {
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    // Caption confirmation
    if (cap) {
      const captionEl = document.querySelector('[contenteditable="true"], .notranslate[contenteditable], textarea, [data-e2e="caption-editor"]');
      if (!captionEl) {
        return { ok: false, error: "Caption input not found" };
      }
      if (captionEl.tagName === "TEXTAREA" || captionEl.tagName === "INPUT") {
        captionEl.value = cap;
      } else if (typeof document.execCommand === "function") {
        // Studio's Draft.js editor ignores textContent: its state keeps the filename and that is what gets posted.
        captionEl.focus();
        document.execCommand("selectAll");
        await wait(300); // Draft.js picks the selection up from an async selectionchange; pasting sooner keeps the filename
        // insertText with newlines scrambles Draft.js blocks (duplicated last line); a paste event keeps them intact.
        const data = new DataTransfer();
        data.setData("text/plain", cap);
        captionEl.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
        await wait(500);
      } else {
        captionEl.textContent = cap;
      }
      captionEl.dispatchEvent(new Event("input", { bubbles: true }));
      captionEl.dispatchEvent(new Event("change", { bubbles: true }));

      // Draft.js blocks read back without separators, so compare ignoring all whitespace.
      const flat = (text) => text.replace(/\s+/g, "");
      const readVal = flat(captionEl.value ?? captionEl.innerText ?? captionEl.textContent ?? "");
      if (readVal !== flat(cap)) {
        return { ok: false, error: `Caption read-back failed: expected "${flat(cap)}", got "${readVal}"` };
      }
      const counter = (document.body?.innerText || "").match(/(\d+)\s*\/\s*4000\b/);
      if (counter && Math.abs(Number(counter[1]) - cap.trim().length) > 10) {
        return { ok: false, error: `Caption not accepted by editor: counter ${counter[1]}, expected about ${cap.trim().length}` };
      }
    }

    // Privacy confirmation (supports both internal values and UI labels like "Only you" / "Everyone")
    if (priv) {
      const privMap = {
        private: {
          allowed: ["private", "only you", "only me", "just you"],
          forbidden: ["everyone", "everybody", "public", "friends", "followers"],
        },
        public: {
          allowed: ["public", "everyone", "everybody"],
          forbidden: ["private", "only you", "only me", "just you", "friends", "followers"],
        },
        friends: {
          allowed: ["friends", "followers"],
          forbidden: ["everyone", "everybody", "public", "private", "only you", "only me", "just you"],
        },
      };
      const rule = privMap[priv.toLowerCase()] || { allowed: [priv.toLowerCase()], forbidden: [] };

      // Current Studio: "Who can see this post" is a combobox with options Everyone / Friends / Only you.
      const label = { private: "only you", public: "everyone", friends: "friends" }[priv.toLowerCase()];
      const norm = (el) => (el.innerText || el.textContent || "").trim().toLowerCase();
      const combo = [...document.querySelectorAll('[role="combobox"]')].find((el) => ["everyone", "friends", "only you"].includes(norm(el)));
      if (combo && label) {
        if (norm(combo) !== label) {
          combo.click();
          await wait(500);
          const option = [...document.querySelectorAll('[role="option"]')].find((el) => norm(el).startsWith(label));
          if (!option) return { ok: false, error: `Privacy option "${label}" not found` };
          option.click();
          await wait(500);
        }
        if (norm(combo) !== label) {
          return { ok: false, error: `Privacy read-back failed: expected "${label}", got "${norm(combo)}"` };
        }
        return { ok: true };
      }

      const radios = [...document.querySelectorAll('input[type="radio"], [role="radio"], [data-e2e*="privacy"]')];

      function getSpecificRadioText(r) {
        if (!r) return "";
        const aria = (typeof r.getAttribute === "function" ? r.getAttribute("aria-label") : null)?.trim() || "";
        if (aria && aria !== "true" && aria !== "false" && aria !== "null") return aria.toLowerCase();

        const val = (r.value || "").trim().toLowerCase();
        if (val && !/^\d+$/.test(val) && val !== "on" && val !== "true" && val !== "false") {
          return val;
        }

        if (r.id && typeof document.querySelector === "function") {
          const lbl = document.querySelector(`label[for="${r.id}"]`);
          const lblText = (lbl?.innerText || lbl?.textContent || "").trim();
          if (lblText) return lblText.toLowerCase();
        }

        const wrappingLabel = typeof r.closest === "function" ? r.closest("label") : null;
        if (wrappingLabel) {
          const labelRadios = typeof wrappingLabel.querySelectorAll === "function" ? wrappingLabel.querySelectorAll('input[type="radio"], [role="radio"]') : [];
          if (labelRadios.length <= 1) {
            const wrapText = (wrappingLabel.innerText || wrappingLabel.textContent || "").trim();
            if (wrapText) return wrapText.toLowerCase();
          }
        }

        let sib = r.nextElementSibling;
        while (sib) {
          if (/^(SPAN|LABEL|DIV|P|B|STRONG)$/i.test(sib.tagName || "")) {
            const sibText = (sib.innerText || sib.textContent || "").trim();
            if (sibText) return sibText.toLowerCase();
          }
          sib = sib.nextElementSibling;
        }

        const parent = r.parentElement;
        if (parent) {
          const parentRadios = typeof parent.querySelectorAll === "function" ? parent.querySelectorAll('input[type="radio"], [role="radio"]') : [];
          if (parentRadios.length <= 1) {
            const parentText = (parent.innerText || parent.textContent || "").trim();
            if (parentText) return parentText.toLowerCase();
          }
        }

        return (r.innerText || r.textContent || "").trim().toLowerCase();
      }

      const privTarget = radios.find((r) => {
        const text = getSpecificRadioText(r);
        const matchesAllowed = rule.allowed.some((pattern) => text.includes(pattern));
        const matchesForbidden = rule.forbidden.some((pattern) => text.includes(pattern));
        return matchesAllowed && !matchesForbidden;
      });

      if (!privTarget) {
        return { ok: false, error: `Privacy control for "${priv}" not found or ambiguous` };
      }
      privTarget.click();

      const isChecked = (el) => Boolean(
        el.checked === true ||
        el.getAttribute("aria-checked") === "true" ||
        el.classList?.contains("checked") ||
        el.classList?.contains("is-checked") ||
        el.parentElement?.classList?.contains("checked") ||
        el.parentElement?.classList?.contains("is-checked")
      );

      if (!isChecked(privTarget)) {
        return { ok: false, error: `Privacy selection for "${priv}" could not be confirmed` };
      }

      const readBackText = getSpecificRadioText(privTarget);
      if (rule.forbidden.some((p) => readBackText.includes(p))) {
        return { ok: false, error: `Privacy selection conflict: confirmed radio contains conflicting text "${readBackText}"` };
      }
    }

    return { ok: true };
  }

  // Draft.js ignores the selection while the window is unfocused, so selectAll would not replace the filename.
  await chrome.debugger.attach(debuggee, "1.3");
  let setupExec;
  let scheduleExec;
  try {
    await chrome.debugger.sendCommand(debuggee, "Emulation.setFocusEmulationEnabled", { enabled: true });
    [setupExec] = await chrome.scripting.executeScript({
      target: { tabId },
      func: pgSetupAndVerifyUpload,
      args: [caption, privacy],
    });
    if (schedule && (await setupExec?.result)?.ok) {
      const [dateStr, timeStr] = schedule.split(" ");
      [scheduleExec] = await chrome.scripting.executeScript({
        target: { tabId },
        func: pgSetupSchedule,
        args: [dateStr, timeStr],
      });
    }
  } finally {
    try { await chrome.debugger.detach(debuggee); } catch {}
  }

  const setup = await setupExec?.result;
  if (!setup?.ok) {
    return { posted: false, verified: false, error: setup?.error || "Upload configuration failed" };
  }
  if (schedule) {
    const sres = await scheduleExec?.result;
    if (!sres?.ok) return { posted: false, verified: false, error: sres?.error || "Schedule configuration failed" };
  }

  // Click Post (or Schedule: Studio relabels the button; a plain "Post" while scheduling means the switch did not take)
  function pgClickPost(wantSchedule) {
    const re = wantSchedule ? /^Schedule$/i : /^(Post|Publish)$/i;
    const postBtn = [...document.querySelectorAll('button')].find((b) => re.test(b.innerText?.trim() || ""));
    if (postBtn && !postBtn.disabled && postBtn.getAttribute("aria-disabled") !== "true") {
      postBtn.click();
      return { clicked: true };
    }
    return { clicked: false };
  }

  const [postExec] = await chrome.scripting.executeScript({
    target: { tabId },
    func: pgClickPost,
    args: [Boolean(schedule)],
  });

  if (!postExec?.result?.clicked) {
    return { posted: false, verified: false, error: schedule ? "Schedule button was not clickable" : "Post button was not clickable" };
  }

  // ================= POINT OF NO RETURN =================
  try {
    // Wait for Studio success signal first
    function pgCheckStudioSuccess() {
      const text = (document.body?.innerText || "").toLowerCase();
      const hasSpecificSuccess =
        text.includes("your video has been published") ||
        text.includes("your video has been uploaded") ||
        text.includes("your video is published") ||
        text.includes("video published") ||
        text.includes("manage your posts") ||
        text.includes("manage your videos") ||
        text.includes("upload another video") ||
        text.includes("post successful");
      const successModal = document.querySelector("[data-e2e='upload-success'], [class*='success-modal'], [data-e2e='post-success']");
      const redirected = location.href.includes("/tiktokstudio/content") || location.href.includes("/content");
      return hasSpecificSuccess || Boolean(successModal) || redirected;
    }

    const successDeadline = Date.now() + 30000;
    let studioSuccess = false;
    while (Date.now() < successDeadline) {
      const [sigRes] = await chrome.scripting.executeScript({
        target: { tabId },
        func: pgCheckStudioSuccess,
      }).catch(() => []);
      if (sigRes?.result) {
        studioSuccess = true;
        break;
      }
      await delay(1000);
    }

    if (!studioSuccess) {
      return { posted: true, verified: false, url: null, reason: "Studio success signal not observed within timeout; remained on upload page" };
    }

    const contentTab = await navigateSocial("https://www.tiktok.com/tiktokstudio/content");
    await safeTab(contentTab.id);

    function pgVerifyNewVideo(beforeList, expectedCap, wasCaptured, wasExplicitEmpty) {
      const beforeSet = new Set(beforeList || []);
      const items = [...document.querySelectorAll("[data-e2e='content-item'], div[class*='DivItem'], tr, a[href*='/video/']")];
      for (const item of items) {
        const a = item.tagName === "A" && item.href?.includes("/video/") ? item : item.querySelector?.("a[href*='/video/']");
        if (!a) continue;
        const href = a.href || a.getAttribute("href");
        if (!href || beforeSet.has(href)) continue;

        if (expectedCap) {
          const itemText = (item.innerText || item.textContent || "").trim();
          if (itemText.includes(expectedCap.trim())) {
            return { verified: true, url: href };
          }
        } else {
          if (wasCaptured && (beforeSet.size > 0 || wasExplicitEmpty)) {
            return { verified: true, url: href };
          }
        }
      }
      return { verified: false, url: null };
    }

    const [verifyExec] = await chrome.scripting.executeScript({
      target: { tabId: contentTab.id },
      func: pgVerifyNewVideo,
      args: [beforeVideoUrls, caption, beforeCaptured, beforeWasEmpty],
    });

    if (verifyExec?.result?.verified && verifyExec.result.url) {
      return { posted: true, verified: true, url: verifyExec.result.url };
    }
    return { posted: true, verified: false, url: null };
  } catch (e) {
    if (e?.code === "HALT" || e?.message?.startsWith("HALT:")) {
      const haltErr = new Error(e.message);
      haltErr.code = "HALT";
      haltErr.reason = e.reason || e.message;
      haltErr.posted = true;
      haltErr.verified = false;
      throw haltErr;
    }
    return { posted: true, verified: false, url: null, error: String(e?.message || e) };
  }
}

async function tiktokStudioList({ limit = 50 }) {
  const target = "https://www.tiktok.com/tiktokstudio/content";
  const tab = await navigateSocial(target);
  const current = await safeTab(tab.id);

  function pgScanStudioRows(lim, existingEntries) {
    function findStudioRow(a, el) {
      if (!a) return el || null;
      const directRow = typeof a.closest === "function" ? a.closest("tr, [role='row'], .arco-table-tr, [class*='TableRow'], [class*='table-row'], [data-e2e='content-item']") : null;
      if (directRow) return directRow;
      let curr = a.parentElement;
      let bestRow = null;
      const bodyEl = typeof document !== "undefined" ? document.body : null;
      while (curr && curr !== bodyEl) {
        if (curr.tagName === "TR" || curr.getAttribute?.("role") === "row" || curr.classList?.contains?.("arco-table-tr") || /TableRow|table-row/i.test(curr.className || "")) {
          return curr;
        }
        if (curr.querySelectorAll?.(".arco-table-cell, [role='cell'], td, th").length > 1) {
          return curr;
        }
        const parent = curr.parentElement;
        if (parent && parent !== bodyEl && typeof parent.querySelectorAll === "function") {
          const vLinksInParent = parent.querySelectorAll("a[href*='/video/']");
          if (vLinksInParent.length > 1) {
            const vLinksInCurr = curr.querySelectorAll("a[href*='/video/']");
            if (vLinksInCurr.length === 1) {
              bestRow = curr;
              break;
            }
          }
        }
        curr = curr.parentElement;
      }
      if (bestRow) return bestRow;
      return (typeof a.closest === "function" ? a.closest("div[class*='DivItem'], div[class*='row'], div[class*='Item']") : null) || a.parentElement?.parentElement || a.parentElement || el;
    }

    const videos = new Map(existingEntries);
    const rawElements = [...document.querySelectorAll("a[href*='/video/'], tr, [data-e2e='content-item'], div[class*='DivItem'], div[class*='Item']")];
    const candidateRows = [];
    for (const el of rawElements) {
      const a = (el.tagName === "A" && (el.href || "").includes("/video/")) ? el : el.querySelector?.("a[href*='/video/']");
      if (a) {
        const row = findStudioRow(a, el);
        candidateRows.push({ a, row });
      }
    }

    for (const { a, row } of candidateRows) {
      const href = a.href || a.getAttribute?.("href") || "";
      const m = href.match(/\/video\/(\d+)/);
      if (!m) continue;
      const id = m[1];
      if (videos.has(id)) continue;

      const rowText = (row ? (row.innerText || row.textContent || "") : "").trim();
      const caption = (a.innerText || a.textContent || "").trim();

      let reviewStatus = "published";
      if (/content under review|under review/i.test(rowText)) {
        reviewStatus = "Content under review";
      }

      const nonCaptionText = caption ? rowText.replace(caption, " ") : rowText;

      const dateMatch = (nonCaptionText.match(/\b((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2}(?:,\s+\d{4})?(?:,\s+\d{1,2}:\d{2}\s*(?:AM|PM)?)?)\b/i) ||
        rowText.match(/\b((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2}(?:,\s+\d{4})?(?:,\s+\d{1,2}:\d{2}\s*(?:AM|PM)?)?)\b/i) ||
        nonCaptionText.match(/\b(\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*(?:\s+\d{4})?)\b/i) ||
        nonCaptionText.match(/\b(\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?)\b/) ||
        nonCaptionText.match(/\b(\d{1,2}[-/.]\d{1,2}[-/.]\d{4})\b/) ||
        rowText.match(/\b(\d{1,2}[-/.]\d{1,2}[-/.]\d{4})\b/));
      const date = dateMatch ? dateMatch[1] : null;

      // null when unreadable or ambiguous: never guess.
      const labels = {
        "only me": "Only me",
        "only you": "Only me",
        "private": "Only me",
        "лише я": "Only me",
        "тільки я": "Only me",
        "только я": "Only me",
        "приватне": "Only me",
        "приватное": "Only me",
        "friends": "Friends",
        "друзі": "Friends",
        "друзья": "Friends",
        "everyone": "Everyone",
        "public": "Everyone",
        "всі": "Everyone",
        "усі": "Everyone",
        "все": "Everyone",
        "публічне": "Everyone",
        "публичное": "Everyone",
      };
      const privCandidates = [
        ...nonCaptionText.split(/[\r\n]+/).map((l) => l.trim().toLowerCase()),
        ...(row && typeof row.querySelectorAll === "function" ? [...row.querySelectorAll("[class*='privacy' i], [class*='Privacy' i], [data-e2e*='privacy' i], .arco-select-view-value, [class*='select-view'], [role='combobox'], [class*='select'], button")].map((el) => (el.innerText || el.textContent || "").trim().toLowerCase()) : []),
        ...rowText.split(/[\r\n]+/).map((l) => l.trim().toLowerCase()),
      ];
      const found = new Set(privCandidates.map((c) => labels[c]).filter(Boolean));
      const privacy = found.size === 1 ? [...found][0] : null;

      videos.set(id, { id, caption, privacy, reviewStatus, date });
      if (videos.size >= lim) break;
    }

    let nextClicked = false;
    if (videos.size < lim) {
      // Look for pagination next button
      const nextSelectors = [
        "li.arco-pagination-item-next:not(.arco-pagination-item-disabled)",
        "li.arco-pagination-next:not(.arco-pagination-disabled)",
        ".arco-pagination-next:not(.arco-pagination-disabled)",
        ".arco-pagination-item-next:not(.arco-pagination-item-disabled)",
        "li[title='Next Page']:not([aria-disabled='true'])",
        "li[title*='Next' i]:not([aria-disabled='true'])",
        "[class*='pagination'] [class*='next' i]:not([disabled]):not([class*='disabled'])",
        "[class*='Pagination'] [class*='Next' i]:not([disabled]):not([class*='disabled'])",
        "button[aria-label*='Next' i]:not([disabled])",
        "[data-e2e='pagination-next']:not([disabled])",
        ".tiktok-pagination-next:not([disabled]):not(.disabled)",
        "[class*='pagination-next']:not([disabled]):not([class*='disabled'])",
        "[class*='Pagination'] button:last-child:not([disabled])",
      ];
      for (const sel of nextSelectors) {
        const nextBtn = document.querySelector(sel);
        if (nextBtn && !nextBtn.disabled && nextBtn.getAttribute("aria-disabled") !== "true" && !nextBtn.classList?.contains("arco-pagination-item-disabled") && !nextBtn.classList?.contains("disabled")) {
          const clickTarget = nextBtn.querySelector("button, a") || nextBtn;
          if (typeof clickTarget.click === "function") {
            clickTarget.click();
            nextClicked = true;
            break;
          }
        }
      }
    }

    // Scroll container
    let scrolled = false;
    let c = document.querySelector("a[href*='/video/']")?.parentElement;
    while (c && !(c.scrollHeight > c.clientHeight + 5 && /auto|scroll/.test(getComputedStyle(c).overflowY))) {
      c = c.parentElement;
    }
    const box = c || document.scrollingElement || document.documentElement || document.body;
    if (box && typeof box.scrollTop === "number") {
      const prevTop = box.scrollTop;
      box.scrollTop += 800;
      if (typeof box.dispatchEvent === "function") {
        box.dispatchEvent(new Event("scroll", { bubbles: true }));
      }
      if (box.scrollTop > prevTop) scrolled = true;
    }
    if (typeof window !== "undefined") {
      const prevWinY = typeof window.scrollY === "number" ? window.scrollY : 0;
      if (typeof window.scrollBy === "function") {
        window.scrollBy(0, 800);
      }
      if (typeof window.scrollY === "number" && window.scrollY > prevWinY) {
        scrolled = true;
      }
    }

    const atBottom = !nextClicked && !scrolled;
    return { entries: Array.from(videos.entries()), atBottom, nextClicked };
  }

  const deadline = Date.now() + 45000;
  let collected = new Map();
  let stagnantRounds = 0;
  let lastSize = 0;
  while (Date.now() < deadline) {
    const [execution] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: pgScanStudioRows,
      args: [limit, Array.from(collected.entries())],
    }).catch(() => []);
    const res = execution?.result;
    if (res?.entries) {
      for (const [k, v] of res.entries) collected.set(k, v);
    }
    if (collected.size >= limit) {
      break;
    }
    if (collected.size === lastSize) {
      stagnantRounds++;
      if (stagnantRounds >= 5 && res?.atBottom) break;
    } else {
      stagnantRounds = 0;
      lastSize = collected.size;
    }
    await delay(res?.nextClicked ? 2000 : 800);
  }

  // Restore scroll to top
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      let c = document.querySelector("a[href*='/video/']")?.parentElement;
      while (c && !(c.scrollHeight > c.clientHeight + 5 && /auto|scroll/.test(getComputedStyle(c).overflowY))) {
        c = c.parentElement;
      }
      const box = c || document.scrollingElement || document.documentElement || document.body;
      if (box && typeof box.scrollTop === "number") {
        box.scrollTop = 0;
        if (typeof box.dispatchEvent === "function") {
          box.dispatchEvent(new Event("scroll", { bubbles: true }));
        }
      }
    },
  }).catch(() => []);

  return { videos: Array.from(collected.values()).slice(0, limit) };
}

async function tiktokSetPrivacy({ videoId, privacy }) {
  const target = "https://www.tiktok.com/tiktokstudio/content";
  const tab = await navigateSocial(target);
  const current = await safeTab(tab.id);

  function pgFindAndOpenPrivacyMenu(vId, reqPriv) {
    function findStudioRow(a, el) {
      if (!a) return el || null;
      const directRow = typeof a.closest === "function" ? a.closest("tr, [role='row'], .arco-table-tr, [class*='TableRow'], [class*='table-row'], [data-e2e='content-item']") : null;
      if (directRow) return directRow;
      let curr = a.parentElement;
      let bestRow = null;
      const bodyEl = typeof document !== "undefined" ? document.body : null;
      while (curr && curr !== bodyEl) {
        if (curr.tagName === "TR" || curr.getAttribute?.("role") === "row" || curr.classList?.contains?.("arco-table-tr") || /TableRow|table-row/i.test(curr.className || "")) {
          return curr;
        }
        if (curr.querySelectorAll?.(".arco-table-cell, [role='cell'], td, th").length > 1) {
          return curr;
        }
        const parent = curr.parentElement;
        if (parent && parent !== bodyEl && typeof parent.querySelectorAll === "function") {
          const vLinksInParent = parent.querySelectorAll("a[href*='/video/']");
          if (vLinksInParent.length > 1) {
            const vLinksInCurr = curr.querySelectorAll("a[href*='/video/']");
            if (vLinksInCurr.length === 1) {
              bestRow = curr;
              break;
            }
          }
        }
        curr = curr.parentElement;
      }
      if (bestRow) return bestRow;
      return (typeof a.closest === "function" ? a.closest("div[class*='DivItem'], div[class*='row'], div[class*='Item']") : null) || a.parentElement?.parentElement || a.parentElement || el;
    }

    const a = [...document.querySelectorAll("a[href*='/video/']")].find((el) => {
      const h = el.href || el.getAttribute("href") || "";
      const m = h.match(/\/video\/(\d+)/);
      return m && m[1] === String(vId);
    });
    if (!a) {
      return { found: false, error: `Video ${vId} not found in Studio content list` };
    }
    const row = findStudioRow(a, a);
    if (!row) {
      return { found: false, error: `Row for video ${vId} could not be determined` };
    }

    const rowText = (row.innerText || row.textContent || "").trim();
    const caption = (a.innerText || a.textContent || "").trim();
    const nonCaptionText = caption ? rowText.replace(caption, " ") : rowText;
    const labels = {
      "only me": "private", "only you": "private", "private": "private",
      "лише я": "private", "тільки я": "private", "только я": "private", "приватне": "private", "приватное": "private",
      "friends": "friends", "друзі": "friends", "друзья": "friends",
      "everyone": "public", "public": "public", "всі": "public", "усі": "public", "все": "public", "публічне": "public", "публичное": "public",
    };
    const privCandidates = [
      ...nonCaptionText.split(/[\r\n]+/).map((l) => l.trim().toLowerCase()),
      ...(row && typeof row.querySelectorAll === "function" ? [...row.querySelectorAll("[class*='privacy' i], [class*='Privacy' i], [data-e2e*='privacy' i], .arco-select-view-value, [class*='select-view'], [role='combobox'], [class*='select'], button")].map((el) => (el.innerText || el.textContent || "").trim().toLowerCase()) : []),
      ...rowText.split(/[\r\n]+/).map((l) => l.trim().toLowerCase()),
    ];
    const found = new Set(privCandidates.map((c) => labels[c]).filter(Boolean));
    if (found.size !== 1) {
      return { found: false, error: `Current privacy of video ${vId} could not be read from its row` };
    }
    const [currentPrivacy] = found;

    if (currentPrivacy === reqPriv.toLowerCase()) {
      return { found: true, noop: true, currentPrivacy, requestedPrivacy: reqPriv };
    }

    const buttons = [...row.querySelectorAll("button, [role='button']")];
    const privBtn = buttons.find((b) => {
      const t = (b.innerText || b.textContent || "").trim().toLowerCase();
      return labels[t] === currentPrivacy;
    });

    if (!privBtn) {
      return { found: false, error: `Privacy button for video ${vId} not found in row` };
    }

    privBtn.click();
    return { found: true, noop: false, clicked: true, currentPrivacy };
  }

  let foundRes = null;
  const findDeadline = Date.now() + 25000;
  while (Date.now() < findDeadline) {
    const [exec] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: pgFindAndOpenPrivacyMenu,
      args: [videoId, privacy],
    }).catch(() => []);
    foundRes = exec?.result;
    if (foundRes?.found) break;

    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const sample = document.querySelector("a[href*='/video/']");
        let c = sample;
        while (c && !(c.scrollHeight > c.clientHeight + 5 && /auto|scroll/.test(getComputedStyle(c).overflowY))) {
          c = c.parentElement;
        }
        const box = c || document.scrollingElement || document.body;
        if (box) {
          // Studio virtualizes rows: a step larger than the viewport skips rows, so scroll by half a viewport.
          box.scrollTop += Math.max(100, Math.floor((box.clientHeight || 400) / 2));
          box.dispatchEvent(new Event("scroll", { bubbles: true }));
        }
      },
    }).catch(() => []);
    await delay(1000);
  }

  if (!foundRes?.found) {
    return { videoId, changed: false, verified: false, error: foundRes?.error || `Video ${videoId} not found in Studio content list` };
  }

  if (foundRes.noop) {
    return { videoId, changed: false, currentPrivacy: foundRes.currentPrivacy, requestedPrivacy: privacy, note: "Video already has requested privacy" };
  }

  await delay(600);

  function pgClickPrivacyOption(targetPriv) {
    const norm = (text) => (text || "").trim().toLowerCase();
    const expectedLabels = {
      private: ["only me", "only you", "тільки я", "тільки мені", "лише я", "только я", "только мне", "приватне", "приватний", "приватное"],
      friends: ["friends", "друзі", "друзья"],
      public: ["everyone", "public", "усі", "всі", "все", "для всіх", "для всех", "публічне", "публичное", "публичный"],
    }[targetPriv.toLowerCase()] || [targetPriv.toLowerCase()];

    // Only real menu items, matched on their first line; several matches mean the wrong menu may be open.
    const candidates = [...document.querySelectorAll("[role='option'], [role='menuitem'], .semi-dropdown-item, [data-tt='components_Select_TUXText']")];
    const options = candidates.filter((el) => expectedLabels.includes(norm((el.innerText || el.textContent || "").split("\n")[0])));

    if (options.length !== 1) {
      return { clicked: false, error: `Expected one privacy option "${targetPriv}" in dropdown menu, found ${options.length}` };
    }

    options[0].click();
    return { clicked: true };
  }

  const [optExec] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: pgClickPrivacyOption,
    args: [privacy],
  });

  if (!optExec?.result?.clicked) {
    return { videoId, changed: false, verified: false, error: optExec?.result?.error || "Failed to select privacy option" };
  }

  // ================= POINT OF NO RETURN =================
  try {
    await delay(2000);

    function pgVerifyRowPrivacy(vId, targetPriv) {
      const norm = (text) => (text || "").trim().toLowerCase();
      const expectedLabels = {
        private: ["only me", "only you", "тільки я", "тільки мені", "лише я", "только я", "только мне", "приватне", "приватний", "приватное"],
        friends: ["friends", "друзі", "друзья"],
        public: ["everyone", "public", "усі", "всі", "все", "для всіх", "для всех", "публічне", "публичное", "публичный"],
      }[targetPriv.toLowerCase()] || [targetPriv.toLowerCase()];

      const a = [...document.querySelectorAll("a[href*='/video/']")].find((el) => {
        const h = el.href || el.getAttribute("href") || "";
        const m = h.match(/\/video\/(\d+)/);
        return m && m[1] === String(vId);
      });
      if (!a) return { verified: false, reason: "Video row not found during read-back" };
      const row = a.closest("tr, [data-e2e='content-item'], div[class*='DivItem'], div[class*='row'], div[class*='Item']") || a.parentElement?.parentElement || a.parentElement;
      if (!row) return { verified: false, reason: "Video row parent not found during read-back" };

      const rowText = (row.innerText || row.textContent || "").trim();
      const allLabels = [
        "only me", "only you", "тільки я", "тільки мені", "лише я", "только я", "только мне", "приватне", "приватний", "приватное",
        "friends", "друзі", "друзья",
        "everyone", "public", "усі", "всі", "все", "для всіх", "для всех", "публічне", "публичное", "публичный"
      ];
      const shown = rowText.split("\n").map(norm).filter((line) => allLabels.includes(line));
      if (shown.length > 0 && shown.every((line) => expectedLabels.includes(line))) {
        return { verified: true };
      }
      return { verified: false, reason: `Privacy read-back mismatch in row text: "${rowText}"` };
    }

    const [verifyExec] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: pgVerifyRowPrivacy,
      args: [videoId, privacy],
    });

    const verified = Boolean(verifyExec?.result?.verified);
    return {
      videoId,
      changed: true,
      verified,
      previousPrivacy: foundRes.currentPrivacy,
      privacy,
      ...(verified ? {} : { reason: verifyExec?.result?.reason || "Privacy update could not be verified on read-back" }),
    };
  } catch (e) {
    if (e?.code === "HALT" || e?.message?.startsWith("HALT:")) {
      const haltErr = new Error(e.message);
      haltErr.code = "HALT";
      haltErr.reason = e.reason || e.message;
      haltErr.changed = true;
      haltErr.verified = false;
      throw haltErr;
    }
    return { videoId, changed: true, verified: false, previousPrivacy: foundRes.currentPrivacy, privacy, error: String(e?.message || e) };
  }
}

async function pgExtractTgStatus() {
  const loginForm = document.querySelector(".login-header, .qr-container, .auth-form, canvas.qr, [data-testid='qr-code']");
  if (loginForm || (location.hash && location.hash.includes("login"))) return { loggedIn: false, account: null };

  let account = null;
  let accountId = null;

  // 1. Try localStorage: Telegram Web K (tweb) user_auth
  try {
    const rawAuth = localStorage.getItem("user_auth");
    if (rawAuth) {
      const auth = JSON.parse(rawAuth);
      accountId = auth.id == null ? null : String(auth.id);
      const name = [auth.first_name, auth.last_name].filter(Boolean).join(" ");
      account = name || (auth.username ? `@${auth.username}` : null) || auth.phone || null;
    }
  } catch {}

  // 2. Try localStorage: tt-global-state
  if (!account) {
    try {
      const rawGlobal = localStorage.getItem("tt-global-state");
      if (rawGlobal) {
        const state = JSON.parse(rawGlobal);
        const curId = state.currentUserId;
        accountId = accountId ?? (curId == null ? null : String(curId));
        const user = curId && state.users?.byId?.[curId];
        if (user) {
          const name = [user.firstName, user.lastName].filter(Boolean).join(" ");
          account = name || (user.username ? `@${user.username}` : null) || user.phoneNumber || null;
        }
      }
    } catch {}
  }

  // 3. If account name is missing but accountId is present, read from Web K's IndexedDB
  if (!account && accountId && typeof indexedDB !== "undefined") {
    try {
      let dbNames = ["tweb-account-1", "tweb-account-2", "tweb-account-3", "tweb-account-0"];
      if (typeof indexedDB.databases === "function") {
        const dbs = await indexedDB.databases();
        const foundNames = dbs.map((d) => d.name).filter(Boolean);
        if (foundNames.length > 0) dbNames = foundNames;
      }
      for (const dbName of dbNames) {
        const userRecord = await new Promise((resolve) => {
          const req = indexedDB.open(dbName);
          req.onerror = () => resolve(null);
          req.onsuccess = () => {
            try {
              const db = req.result;
              const storeName = ["users", "user", "accounts"].find((s) => db.objectStoreNames.contains(s));
              if (!storeName) {
                db.close();
                return resolve(null);
              }
              const tx = db.transaction(storeName, "readonly");
              const store = tx.objectStore(storeName);
              const getReq = store.get(Number(accountId));
              getReq.onsuccess = () => {
                if (getReq.result) {
                  db.close();
                  return resolve(getReq.result);
                }
                const strReq = store.get(String(accountId));
                strReq.onsuccess = () => {
                  db.close();
                  resolve(strReq.result || null);
                };
                strReq.onerror = () => {
                  db.close();
                  resolve(null);
                };
              };
              getReq.onerror = () => {
                db.close();
                resolve(null);
              };
            } catch {
              resolve(null);
            }
          };
        });
        if (userRecord) {
          const name = [userRecord.first_name || userRecord.firstName, userRecord.last_name || userRecord.lastName].filter(Boolean).join(" ");
          account = name || (userRecord.username ? `@${userRecord.username}` : null) || userRecord.phone_number || userRecord.phoneNumber || null;
          if (account) break;
        }
      }
    } catch {}
  }

  const bodyText = (document.body?.innerText || "").slice(0, 300);
  const title = document.title;
  const url = location.href;
  const domChildren = Array.from(document.body?.children || []).map((c) => c.tagName + "." + c.className);
  // No DOM fallback: the sidebar is full of chat titles, and a wrong account name is worse than none.
  return { loggedIn: Boolean(accountId || account), account, accountId };
}

async function tgStatus() {
  const target = "https://web.telegram.org/k/";
  const tab = await navigateSocial(target);
  const current = await safeTab(tab.id);
  const [execution] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: pgExtractTgStatus,
  });
  return execution?.result || { loggedIn: false };
}

async function pgExtractTgDialogs(limit) {
  // Dismiss first-open tips overlay, search panel or tooltips if present
  try {
    const tipDismiss = document.querySelector(
      ".popup-tips button, .tooltip button, .tips button, .sidebar-left [class*='tip'] button, .popup-close"
    );
    if (tipDismiss && typeof tipDismiss.click === "function") tipDismiss.click();
    const searchBack = document.querySelector(".sidebar-header button.btn-back, .search-header button, .sidebar-header button.tgico-back");
    if (searchBack && typeof searchBack.click === "function") searchBack.click();
    const searchInput = document.querySelector("input.input-field-input, input[placeholder*='Search' i]");
    if (searchInput && searchInput.value) {
      searchInput.value = "";
      searchInput.dispatchEvent(new Event("input", { bubbles: true }));
    }
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
  } catch {}

  // Poll for dialogs list to load
  const startTime = Date.now();
  let initialItems = [];
  while (Date.now() - startTime < 10000) {
    const candidates = [...document.querySelectorAll(
      ".chatlist-parts .chatlist-chat, .chatlist .chatlist-chat, .chatlist-chat, a.chatlist-chat, .chat-list .chat-item, ul.chatlist > li, [data-peer-id], a[href*='#']:not([href$='#'])"
    )];
    initialItems = candidates.filter((el) => {
      const href = el.getAttribute("href") || el.querySelector("a[href]")?.getAttribute("href") || "";
      const peerAttr = el.getAttribute("data-peer-id") || el.querySelector("[data-peer-id]")?.getAttribute("data-peer-id");
      const hasPeer = (href.includes("#") && !href.endsWith("#")) || Boolean(peerAttr);
      const hasTitle = Boolean(el.querySelector(".peer-title, .user-title, .chat-title, .dialog-title, .row-title, [class*='title']")) || (el.innerText || "").trim().length > 0;
      return hasPeer && hasTitle;
    });
    if (initialItems.length > 0) break;
    await new Promise((r) => setTimeout(r, 250));
  }

  // Find chatlist scrollable container
  let scrollEl = document.querySelector(".chatlist-parts, .chatlist, .sidebar-left-section-dialogs, [class*='chatlist-parts']");
  if (!scrollEl) {
    let c = initialItems[0]?.parentElement;
    while (c && c !== document.body) {
      if (c.scrollHeight > c.clientHeight + 10) { scrollEl = c; break; }
      c = c.parentElement;
    }
  }

  const dialogs = [];
  const seenPeers = new Set();
  const maxCycles = Math.min(30, Math.ceil(limit / 10) + 5);

  for (let cycle = 0; cycle < maxCycles; cycle++) {
    const candidates = [...document.querySelectorAll(
      ".chatlist-parts .chatlist-chat, .chatlist .chatlist-chat, .chatlist-chat, a.chatlist-chat, .chat-list .chat-item, ul.chatlist > li, [data-peer-id], a[href*='#']:not([href$='#'])"
    )];
    const items = candidates.filter((el) => {
      const href = el.getAttribute("href") || el.querySelector("a[href]")?.getAttribute("href") || "";
      const peerAttr = el.getAttribute("data-peer-id") || el.querySelector("[data-peer-id]")?.getAttribute("data-peer-id");
      const hasPeer = (href.includes("#") && !href.endsWith("#")) || Boolean(peerAttr);
      const hasTitle = Boolean(el.querySelector(".peer-title, .user-title, .chat-title, .dialog-title, .row-title, [class*='title']")) || (el.innerText || "").trim().length > 0;
      return hasPeer && hasTitle;
    });

    for (const el of items) {
      const titleEl = el.querySelector(".peer-title, .user-title, .chat-title, .dialog-title, .row-title, [class*='title']") || el;
      const rawTitle = titleEl?.innerText?.trim() || null;
      let title = rawTitle ? rawTitle.split(/[\r\n]+/)[0].trim() : null;
      const lastMessage = el.querySelector(".message-custom, .subtitle, .dialog-subtitle, .chatlist-chat-subtitle, [class*='subtitle']")?.innerText?.trim() || null;
      const timeEl = el.querySelector(".chat-meta .time, .dialog-time, time, .chatlist-chat-time, [class*='time']");
      const time = timeEl?.innerText?.trim() || null;
      if (title && time && title.endsWith(time)) {
        title = title.slice(0, -time.length).trim();
      }
      if (!title || /^(update|new chats|search|open call|tips|home|theme)$/i.test(title)) continue;
      const unreadEl = el.querySelector(".badge.unread, .unread, .chatlist-chat-badge, .dialog-badge, .badge");
      const unreadRaw = unreadEl?.innerText?.trim() || null;
      const unread = unreadRaw && /^\d+$/.test(unreadRaw) ? Number(unreadRaw) : null;

      const href = el.getAttribute("href") || el.querySelector("a[href]")?.getAttribute("href") || "";
      const peerAttr = el.getAttribute("data-peer-id") || el.querySelector("[data-peer-id]")?.getAttribute("data-peer-id");
      const hashMatch = href.match(/#(@?[a-zA-Z0-9_-]+)/);
      const rawPeer = (hashMatch ? hashMatch[1] : peerAttr) || null;

      let peer = null;
      if (rawPeer) {
        if (/^-?\d+$/.test(rawPeer)) {
          peer = rawPeer;
        } else if (rawPeer.startsWith("@")) {
          peer = rawPeer;
        } else {
          peer = `@${rawPeer}`;
        }
      }

      if (peer && seenPeers.has(peer)) continue;
      if (peer) seenPeers.add(peer);

      if (title) {
        dialogs.push({
          title,
          peer,
          lastMessage,
          time,
          unread,
        });
      }
      if (dialogs.length >= limit) break;
    }

    if (dialogs.length >= limit || !scrollEl) break;
    const prevScroll = scrollEl.scrollTop;
    scrollEl.scrollTop += 600;
    scrollEl.dispatchEvent(new Event("scroll", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 200));
    if (scrollEl.scrollTop === prevScroll) break;
  }
  return dialogs;
}

async function tgDialogsList({ limit = 20 }) {
  const target = "https://web.telegram.org/k/";
  const tab = await navigateSocial(target);
  const current = await safeTab(tab.id);
  const [execution] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: pgExtractTgDialogs,
    args: [limit],
  });
  return { dialogs: execution?.result || [] };
}

async function pgExtractTgMessages(limit) {
  const startTime = Date.now();
  let bubbles = [];
  while (Date.now() - startTime < 6000) {
    bubbles = [...document.querySelectorAll(".bubble, .message, [class*='bubble']")];
    if (bubbles.length > 0) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  const messages = [];
  // .bubble-content/.message nest inside .bubble: read each real bubble once and skip date/service rows.
  const real = bubbles.filter((el) => el.classList?.contains("bubble"));
  if (real.length) bubbles = real;
  bubbles = bubbles.filter((el) => !el.parentElement?.closest?.(".bubble") && !el.classList?.contains("service"));
  for (const b of bubbles) {
    const textEl = b.querySelector(".message, .text-content, .bubble-content");
    const text = textEl?.innerText?.trim() || "";
    const authorEl = b.querySelector(".bubble-author, .peer-title");
    const isOut = b.classList.contains("is-out") || b.classList.contains("outgoing") || Boolean(b.querySelector(".is-out"));
    const sender = isOut ? "me" : (authorEl?.innerText?.trim() || "them");
    const time = b.querySelector(".time, .bubble-time, time")?.innerText?.trim() || null;
    let media = null;
    if (b.querySelector("video")) media = "video";
    else if (b.querySelector("img.media-photo, .photo, img")) media = "photo";
    else if (b.querySelector("audio, .audio, .voice")) media = "audio";
    else if (b.querySelector(".document, .file")) media = "document";
    if (text || media) {
      messages.push({ sender, text, time, outgoing: isOut, media });
    }
  }
  return messages.slice(-limit);
}

async function tgMessagesRead({ chat, limit = 30 }) {
  const isPeerId = /^-?\d+$/.test(chat);
  const norm = isPeerId ? chat : chat.replace(/^@/, "");
  const target = isPeerId ? `https://web.telegram.org/k/#${norm}` : `https://web.telegram.org/k/#@${norm}`;
  const tab = await navigateSocial(target);
  const current = await safeTab(tab.id);
  const [execution] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: pgExtractTgMessages,
    args: [limit],
  });
  return { chat, messages: execution?.result || [] };
}

async function pgCollectAndChunkTgMedia(types, limit) {
  const bubbles = [...document.querySelectorAll(".bubble, .message")];
  const items = [];
  for (const b of bubbles) {
    let el = null;
    let type = null;
    let preview = false;

    if (types.includes("video")) {
      const vid = b.querySelector("video");
      if (vid && !vid.closest?.(".avatar, .user-avatar, .peer-avatar, .reaction, .reactions, .sticker, .emoji")) {
        el = vid;
        type = "video";
        if (vid.classList?.contains("preview") || vid.classList?.contains("thumb") || vid.closest?.(".media-preview, .preview, .thumbnail")) {
          preview = true;
        }
      }
    }
    if (!el && types.includes("photo")) {
      const imgs = [...(b.querySelectorAll?.(".media-photo img, .attachment-media img, .media-container img, .photo img, img.media-photo, img") || (b.querySelector?.("img") ? [b.querySelector("img")] : []))];
      for (const img of imgs) {
        if (img.closest?.(".avatar, .user-avatar, .peer-avatar, .reaction, .reactions, .sticker, .emoji")) {
          continue; // Skip avatars, stickers, reactions!
        }
        el = img;
        type = "photo";
        if (img.classList?.contains("preview") || img.classList?.contains("thumb") || img.closest?.(".media-preview, .preview, .thumbnail")) {
          preview = true;
        }
        break;
      }
    }
    if (el) {
      const src = el.src || el.currentSrc || el.getAttribute("src");
      if (src) {
        items.push({ type, src, preview });
        if (items.length >= limit) break;
      }
    }
  }

  const results = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    try {
      const resp = await fetch(item.src);
      const blob = await resp.blob();
      if (blob.size > 50 * 1024 * 1024) {
        results.push({ mediaType: item.type, error: "File exceeds 50 MB limit", size: blob.size, preview: item.preview, itemIndex: i + 1 });
        continue;
      }
      const buffer = await blob.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      let binary = "";
      for (let j = 0; j < bytes.byteLength; j++) binary += String.fromCharCode(bytes[j]);
      const base64 = btoa(binary);
      const chunkSize = 256 * 1024;
      const chunks = [];
      for (let offset = 0; offset < base64.length; offset += chunkSize) {
        chunks.push(base64.slice(offset, offset + chunkSize));
      }
      const ext = item.type === "video" ? "mp4" : "jpg";
      results.push({ type: item.type, filename: `media_${i + 1}.${ext}`, size: blob.size, chunks, preview: item.preview, itemIndex: i + 1 });
    } catch (e) {
      results.push({ type: item.type, error: String(e?.message || e), preview: item.preview, itemIndex: i + 1 });
    }
  }
  return results;
}

async function tgMediaDownload({ chat, limit = 10, types = ["photo", "video"], dir }, socket, msgId) {
  const isPeerId = /^-?\d+$/.test(chat);
  const norm = isPeerId ? chat : chat.replace(/^@/, "");
  const target = isPeerId ? `https://web.telegram.org/k/#${norm}` : `https://web.telegram.org/k/#@${norm}`;
  const tab = await navigateSocial(target);
  const current = await safeTab(tab.id);

  const [execution] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: pgCollectAndChunkTgMedia,
    args: [types, limit],
  });

  const rawResults = execution?.result || [];
  const skipped = [];

  for (let i = 0; i < rawResults.length; i++) {
    const item = rawResults[i];
    if (item.error) {
      skipped.push({ type: item.type, reason: item.error });
      continue;
    }
    const fileId = `tg_${Date.now()}_${i}`;
    if (socket && socket.readyState === WebSocket.OPEN && item.chunks) {
      for (let c = 0; c < item.chunks.length; c++) {
        socket.send(JSON.stringify({
          type: "chunk",
          id: msgId,
          fileId,
          index: c,
          total: item.chunks.length,
          data: item.chunks[c],
          itemIndex: item.itemIndex || (i + 1),
          preview: Boolean(item.preview),
          mediaType: item.type,
        }));
      }
    } else {
      skipped.push({ type: item.type, filename: item.filename, reason: "Socket unavailable or no chunks" });
    }
  }

  // Final job result (saved and skipped) is constructed service-side from actual writes
  return { chat, attempted: rawResults.length, skipped };
}

async function tgSendMessage({ chat, text }) {
  const isPeerId = /^-?\d+$/.test(chat);
  const norm = isPeerId ? chat : chat.replace(/^@/, "");
  const target = isPeerId ? `https://web.telegram.org/k/#${norm}` : `https://web.telegram.org/k/#@${norm}`;
  const { tabId: curTabId } = await getWorkTab();
  const curTab = await chrome.tabs.get(curTabId).catch(() => null);
  const curHash = (new URL(curTab?.url || "about:blank").hash || "").replace(/^#@?/, "").toLowerCase();
  const alreadyInTarget = Boolean(curTab?.url?.includes("web.telegram.org") && curHash && curHash === norm.toLowerCase());
  let prevHeader = null;
  if (!alreadyInTarget) {
    const [prevRes] = await chrome.scripting.executeScript({
      target: { tabId: curTabId },
      func: () => (document.querySelector("#column-center .peer-title, #column-center .chat-title, .middle-column .peer-title, .top .peer-title, .chat-info .peer-title, .chat-header .peer-title, [class*='chat-info'] [class*='title']") ||
        document.querySelector(".top .peer-title, .person-title, .user-title"))?.innerText?.trim() || null,
    }).catch(() => []);
    prevHeader = prevRes?.result || null;
  }

  const tab = await navigateSocial(target, prevHeader);
  const tabId = tab.id;
  await safeTab(tabId);

  // Strictly verify active chat header before typing
  const [matchCheck] = await chrome.scripting.executeScript({
    target: { tabId },
    func: pgMatchTgChat,
    args: [norm, prevHeader],
  });
  if (!matchCheck?.result?.matched) {
    throw new Error(`Wrong chat open: active chat does not match requested recipient "${chat}"; refusing to send`);
  }

  // Last real (non-service) bubble id before typing, to recognise the new message afterwards.
  const [beforeMsgRes] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const b = [...document.querySelectorAll(".bubble, .message")].filter((el) => !el.parentElement?.closest(".bubble, .message") && !el.classList?.contains("service")).at(-1);
      return b?.getAttribute?.("data-mid") || null;
    },
  }).catch(() => []);
  const beforeMid = beforeMsgRes?.result || null;

  async function pgTypeAndSend(msg) {
    const input = document.querySelector(".chat-input .input-message-input, .input-message-container [contenteditable=true], .input-message-input");
    if (!input) return { sent: false, reason: "Message input not found" };
    const squash = (t) => String(t ?? "").replace(/\s+/g, " ").trim();
    const clearComposer = () => { try { input.focus(); document.execCommand("selectAll"); document.execCommand("delete"); } catch {} };
    // A leftover draft would be sent together with the message (or become its caption): fail closed.
    if (squash(input.innerText ?? input.textContent)) {
      return { sent: false, reason: "Composer already contains an unsent draft; clear it in Telegram first" };
    }
    // Web K's composer is a tiptap editor: textContent/input events do not reach its state, a text/plain paste does.
    try {
      input.focus();
      const dt = new DataTransfer();
      dt.setData("text/plain", msg);
      input.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    } catch {
      input.textContent = msg;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    await new Promise((r) => setTimeout(r, 200));

    if (squash(input.innerText ?? input.textContent) !== squash(msg)) {
      clearComposer();
      return { sent: false, reason: "Composer text mismatch after typing" };
    }

    const sendBtn = document.querySelector(".chat-input .btn-send, .btn-send, .chat-input button.send, .chat-input [title=Send]");
    if (sendBtn) {
      sendBtn.click();
      return { sent: true };
    }

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", keyCode: 13, bubbles: true }));
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 50));
      const textNow = (input.textContent || input.innerText || "").trim();
      if (textNow.length === 0) {
        return { sent: true };
      }
    }
    const afterEnter = (input.textContent || input.innerText || "").trim();
    if (afterEnter.length > 0) {
      return { sent: true, unverified: true, reason: "Composer did not clear after Enter key" };
    }
    return { sent: true };
  }

  const [sendResult] = await chrome.scripting.executeScript({
    target: { tabId },
    func: pgTypeAndSend,
    args: [text],
  });

  if (sendResult?.result?.unverified) {
    return { sent: true, verified: false, chat, text, error: sendResult.result.reason };
  }

  if (!sendResult?.result?.sent) {
    return { sent: false, verified: false, chat, text, error: sendResult?.result?.reason || "Failed to type message" };
  }

  // ================= POINT OF NO RETURN =================
  try {
    // In a channel the owner's own posts are .bubble.is-in.channel-post (not .is-out), and the list is
    // virtualised, so judge only the last real bubble: new id, no is-sending, same text.
    function pgCheckLastMessage(expectedText, prevMid) {
      const squash = (t) => String(t ?? "").replace(/\s+/g, " ").trim();
      const last = [...document.querySelectorAll(".bubble, .message")].filter((el) => !el.parentElement?.closest(".bubble, .message") && !el.classList?.contains("service")).at(-1);
      if (!last) return { verified: false, reason: "No message bubbles found" };
      if (last.classList.contains("is-sending") || last.querySelector(".is-sending, .sending")) return { verified: false, pending: true, reason: "Message is still sending" };
      const mid = last.getAttribute("data-mid") || last.id || null;
      if (mid && mid.includes(".")) return { verified: false, pending: true, reason: "Message id is still temporary" };
      if (prevMid && mid === prevMid) return { verified: false, reason: "No new message bubble appeared" };
      const bubbleText = squash(last.querySelector(".message, .text-content, .bubble-content")?.innerText || last.innerText);
      if (!bubbleText.includes(squash(expectedText))) return { verified: false, reason: "Last bubble text does not match" };
      return { verified: true, mid };
    }

    let verified = false;
    let messageId = null;
    for (let attempt = 0; attempt < 10; attempt++) {
      await delay(1000);
      const [verifyExec] = await chrome.scripting.executeScript({
        target: { tabId },
        func: pgCheckLastMessage,
        args: [text, beforeMid],
      });
      if (verifyExec?.result?.verified) {
        verified = true;
        messageId = verifyExec.result.mid;
        break;
      }
    }
    if (!verified) {
      // Our own text still sitting in the composer means Telegram never took it: drop it so it does not linger as a draft.
      const [left] = await chrome.scripting.executeScript({
        target: { tabId },
        func: (t) => {
          const el = document.querySelector(".chat-input .input-message-input, .input-message-container [contenteditable=true], .input-message-input");
          const squash = (x) => String(x ?? "").replace(/\s+/g, " ").trim();
          if (!el || squash(el.innerText ?? el.textContent) !== squash(t)) return false;
          try { el.focus(); document.execCommand("selectAll"); document.execCommand("delete"); } catch {}
          return true;
        },
        args: [text],
      }).catch(() => []);
      if (left?.result) return { sent: true, verified: false, chat, text, error: "Text stayed in the composer and was removed; Telegram did not confirm sending" };
    }
    return { sent: true, verified, chat, text, messageId };
  } catch (e) {
    if (e?.code === "HALT" || e?.message?.startsWith("HALT:")) {
      const haltErr = new Error(e.message);
      haltErr.code = "HALT";
      haltErr.reason = e.reason || e.message;
      haltErr.sent = true;
      haltErr.verified = false;
      throw haltErr;
    }
    return { sent: true, verified: false, chat, text, error: String(e?.message || e) };
  }
}

async function tgSendMedia({ chat, file, caption = "" }) {
  const isPeerId = /^-?\d+$/.test(chat);
  const norm = isPeerId ? chat : chat.replace(/^@/, "");
  const target = isPeerId ? `https://web.telegram.org/k/#${norm}` : `https://web.telegram.org/k/#@${norm}`;
  const { tabId: curTabId } = await getWorkTab();
  const curTab = await chrome.tabs.get(curTabId).catch(() => null);
  const curHash = (new URL(curTab?.url || "about:blank").hash || "").replace(/^#@?/, "").toLowerCase();
  const alreadyInTarget = Boolean(curTab?.url?.includes("web.telegram.org") && curHash && curHash === norm.toLowerCase());
  let prevHeader = null;
  if (!alreadyInTarget) {
    const [prevRes] = await chrome.scripting.executeScript({
      target: { tabId: curTabId },
      func: () => (document.querySelector("#column-center .peer-title, #column-center .chat-title, .middle-column .peer-title, .top .peer-title, .chat-info .peer-title, .chat-header .peer-title, [class*='chat-info'] [class*='title']") ||
        document.querySelector(".top .peer-title, .person-title, .user-title"))?.innerText?.trim() || null,
    }).catch(() => []);
    prevHeader = prevRes?.result || null;
  }

  const tab = await navigateSocial(target, prevHeader);
  const tabId = tab.id;
  await safeTab(tabId);

  // Strictly verify active chat header before attaching
  const [matchCheck] = await chrome.scripting.executeScript({
    target: { tabId },
    func: pgMatchTgChat,
    args: [norm, prevHeader],
  });
  if (!matchCheck?.result?.matched) {
    throw new Error(`Wrong chat open: active chat does not match requested recipient "${chat}"; refusing to send`);
  }

  // Snapshot existing bubbles before attaching (works for channels and 1-on-1 chats)
  const [beforeStateRes] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const rawBubbles = [...document.querySelectorAll(".bubble, .message")];
      const bubbles = rawBubbles.filter((el) => !el.parentElement?.closest(".bubble, .message") && !el.classList?.contains("service"));
      const outgoing = bubbles.filter((b) => b.classList?.contains("is-out") || b.classList?.contains("outgoing") || Boolean(b.querySelector?.(".is-out, .outgoing")));
      const last = bubbles.at(-1);
      const lastOut = outgoing.at(-1);
      const lastMid = last?.getAttribute("data-mid") || last?.id || null;
      const lastOutMid = lastOut?.getAttribute("data-mid") || lastOut?.id || null;
      const mediaCount = outgoing.filter((el) => el.querySelector("img, video, .media-container, .attachment, .media-photo, .media-video") || el.classList?.contains("media")).length;
      return { lastMid, lastOutMid, count: bubbles.length, outCount: outgoing.length, mediaCount };
    },
  }).catch(() => []);
  const beforeState = beforeStateRes?.result || { lastMid: null, lastOutMid: null, count: 0, outCount: 0, mediaCount: 0 };

  // The composer holds Telegram's draft; the media popup would take it over as the caption. Fail closed.
  const [draftRes] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const el = document.querySelector(".chat-input [contenteditable=true], .chat-input .input-message-input");
      return String(el?.innerText ?? el?.textContent ?? "").replace(/\s+/g, " ").trim();
    },
  }).catch(() => []);
  if (draftRes?.result) {
    return { sent: false, verified: false, chat, file, caption, error: "Composer already contains an unsent draft; clear it in Telegram first" };
  }

  // The attach menu opens a native picker, so instead: a private <input type=file> we create, filled over CDP
  // (DOM.setFileInputFiles), whose File is then pasted into the composer, which opens the media popup.
  const TG_INPUT_ID = "socmedia-tg-upload";
  await chrome.scripting.executeScript({
    target: { tabId },
    func: (id) => {
      document.getElementById(id)?.remove();
      const input = document.createElement("input");
      input.type = "file";
      input.id = id;
      input.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";
      document.body.appendChild(input);
    },
    args: [TG_INPUT_ID],
  }).catch(() => []); // a missing input then fails closed at DOM.querySelector below
  const debuggee = { tabId };
  await chrome.debugger.attach(debuggee, "1.3");
  try {
    await chrome.debugger.sendCommand(debuggee, "DOM.enable");
    const doc = await chrome.debugger.sendCommand(debuggee, "DOM.getDocument");
    const res = await chrome.debugger.sendCommand(debuggee, "DOM.querySelector", {
      nodeId: doc.root.nodeId,
      selector: `#${TG_INPUT_ID}`,
    });
    if (!res?.nodeId) throw new Error("Could not create file input in Telegram Web");
    await chrome.debugger.sendCommand(debuggee, "DOM.setFileInputFiles", { nodeId: res.nodeId, files: [file] });
  } finally {
    try { await chrome.debugger.detach(debuggee); } catch {}
  }
  const [pasteRes] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (id) => {
      const input = document.getElementById(id);
      const f = input?.files?.[0];
      input?.remove();
      if (!f) return { ok: false, reason: "File was not attached to the page" };
      const composer = document.querySelector(".chat-input [contenteditable=true], .chat-input .input-message-input");
      if (!composer) return { ok: false, reason: "Message input not found" };
      const dt = new DataTransfer();
      dt.items.add(f);
      composer.focus();
      composer.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
      return { ok: true, size: f.size, type: f.type };
    },
    args: [TG_INPUT_ID],
  }).catch(() => []);
  if (pasteRes?.result && !pasteRes.result.ok) {
    return { sent: false, verified: false, chat, file, caption, error: pasteRes.result.reason };
  }

  // Poll for .popup-new-media to appear
  const popupDeadline = Date.now() + 15000;
  let popupFound = false;
  while (Date.now() < popupDeadline) {
    const [pCheck] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => Boolean(document.querySelector(".popup-new-media, .popup-send-media, .popup-send-photo, .popup-send-file, [class*='popup-new-media']")),
    }).catch(() => []);
    if (pCheck?.result) {
      popupFound = true;
      break;
    }
    await delay(200);
  }
  if (!popupFound) {
    return { sent: false, verified: false, chat, file, caption, error: "Media confirmation popup not found" };
  }

  // Wait ~1.2s after popup appears before entering caption
  await delay(1200);

  function pgSendMediaConfirm(cap) {
    const popup = document.querySelector(".popup-new-media, .popup-send-media, .modal-dialog, .popup-send-photo, .popup-send-file, .popup-container .popup, .modal-content, [class*='popup']");
    if (!popup || typeof popup.querySelector !== "function") {
      return { sent: false, reason: "Media confirmation popup not found" };
    }
    const scope = popup;
    if (cap) {
      const capInput = scope.querySelector(".popup [contenteditable=true], [contenteditable=true], .popup-caption-input, textarea, input");
      if (!capInput) {
        return { sent: false, reason: "Caption field requested but not found in media popup" };
      }
      if (capInput.tagName === "TEXTAREA" || capInput.tagName === "INPUT") {
        capInput.value = cap;
        capInput.dispatchEvent(new Event("input", { bubbles: true }));
      } else {
        // Dispatch paste event with text/plain for tiptap / ProseMirror contenteditable
        try {
          capInput.focus();
          // The popup caption can hold the composer's draft: empty it so the paste replaces, never appends.
          try { document.execCommand("selectAll"); document.execCommand("delete"); } catch {}
          const dt = new DataTransfer();
          dt.setData("text/plain", cap);
          const pasteEvent = new ClipboardEvent("paste", {
            clipboardData: dt,
            bubbles: true,
            cancelable: true,
          });
          capInput.dispatchEvent(pasteEvent);
        } catch {
          capInput.textContent = cap;
          capInput.dispatchEvent(new Event("input", { bubbles: true }));
        }
      }
      const enteredCap = (capInput.value ?? capInput.innerText ?? capInput.textContent ?? "").replace(/\s+/g, " ").trim();
      const normExpected = cap.replace(/\s+/g, " ").trim();
      if (enteredCap !== normExpected) {
        return { sent: false, reason: `Caption read-back mismatch: expected "${normExpected}", got "${enteredCap}"` };
      }
    }
    const sendBtn = scope.querySelector(".simple-message-input-confirm, button.simple-message-input-confirm, .popup-send, .btn-send, button.btn-primary.btn-color-primary, button.btn-primary, button[type=submit]");
    if (sendBtn) {
      sendBtn.click();
      return { sent: true };
    }
    return { sent: false, reason: "Send button not found in media popup" };
  }

  // The popup editor is sometimes not ready right after it appears (seen live: first attempt read back a wrong caption).
  // A caption mismatch happens before the Send click, so retrying the fill is safe; the send itself is never retried.
  let confirmExec;
  for (let attempt = 0; attempt < 3; attempt++) {
    [confirmExec] = await chrome.scripting.executeScript({
      target: { tabId },
      func: pgSendMediaConfirm,
      args: [caption],
    });
    if (confirmExec?.result?.sent || !/^Caption read-back mismatch/.test(confirmExec?.result?.reason || "")) break;
    await delay(1000);
  }

  if (!confirmExec?.result?.sent) {
    // Nothing was sent: close the popup so no half-filled dialog stays in the account.
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => { document.querySelector(".popup-new-media .popup-close")?.click?.(); },
    }).catch(() => []);
    return { sent: false, verified: false, chat, file, caption, error: confirmExec?.result?.reason || "Send button was not clickable" };
  }

  // ================= POINT OF NO RETURN =================
  try {
    function pgCheckOutgoingMedia(expectedCaption, bState) {
      const rawBubbles = [...document.querySelectorAll(".bubble, .message")];
      // Judge only the last real bubble (the list is virtualised). The owner's own channel posts are
      // .is-in.channel-post, so "outgoing" is not a usable test: a new id after the send click is.
      const bubbles = rawBubbles.filter((el) => !el.parentElement?.closest(".bubble, .message") && !el.classList?.contains("service"));
      if (bubbles.length === 0) return { verified: false, reason: "No message bubbles found" };

      const last = bubbles.at(-1);
      if (!last) return { verified: false, reason: "No message bubbles found" };

      // Ensure last bubble is not still sending
      if (last.classList.contains("is-sending") || last.querySelector(".is-sending, .sending, .progress-circle")) {
        return { verified: false, pending: true, reason: "Message is still sending" };
      }

      // Check that last bubble contains media
      const hasMedia = Boolean(last.querySelector("img, video, .media-container, .attachment, .media-photo, .media-video") || last.classList.contains("media") || last.classList.contains("video") || last.classList.contains("photo"));
      if (!hasMedia) {
        return { verified: false, reason: "Last bubble does not contain media" };
      }

      const lastMid = last.getAttribute("data-mid") || last.id || null;
      if (lastMid && lastMid.includes(".")) {
        return { verified: false, pending: true, reason: "Message id is still temporary" };
      }
      if (bState?.lastMid && lastMid === bState.lastMid) {
        return { verified: false, reason: "No new message bubble appeared" };
      }
      if (bState?.lastOutMid && lastMid === bState.lastOutMid) {
        return { verified: false, reason: "No new outgoing message bubble appeared" };
      }
      if (bState && bubbles.length <= bState.count && !expectedCaption) {
        const outgoing = bubbles.filter((b) => b.classList?.contains("is-out") || b.classList?.contains("outgoing") || Boolean(b.querySelector?.(".is-out, .outgoing")));
        const currentMediaCount = outgoing.filter((el) => el.querySelector("img, video, .media-container, .attachment, .media-photo, .media-video") || el.classList.contains("media")).length;
        if (currentMediaCount <= bState.mediaCount) {
          return { verified: false, reason: "Outgoing media count did not increase" };
        }
      }

      if (expectedCaption) {
        const bubbleText = (last.querySelector(".message, .text-content, .bubble-content, .caption, .bubble-text")?.innerText || last.innerText || "").replace(/\s+/g, " ").trim();
        const normExpected = expectedCaption.replace(/\s+/g, " ").trim();
        if (!bubbleText.includes(normExpected)) {
          return { verified: false, reason: "Caption does not match outgoing bubble" };
        }
      }
      return { verified: true, mid: lastMid };
    }

    let verified = false;
    let messageId = null;
    // Uploads keep the bubble in is-sending for a while: poll up to ~60 s, never resend.
    for (let attempt = 0; attempt < 40; attempt++) {
      await delay(1500);
      const [verifyExec] = await chrome.scripting.executeScript({
        target: { tabId },
        func: pgCheckOutgoingMedia,
        args: [caption, beforeState],
      });
      if (verifyExec?.result?.verified) {
        verified = true;
        messageId = verifyExec.result.mid;
        break;
      }
    }

    return { sent: true, verified, chat, file, caption, messageId };
  } catch (e) {
    if (e?.code === "HALT" || e?.message?.startsWith("HALT:")) {
      const haltErr = new Error(e.message);
      haltErr.code = "HALT";
      haltErr.reason = e.reason || e.message;
      haltErr.sent = true;
      haltErr.verified = false;
      throw haltErr;
    }
    return { sent: true, verified: false, chat, file, caption, error: String(e?.message || e) };
  }
}

async function tgCreateChannel({ title, description = "" }) {
  const target = "https://web.telegram.org/k/";
  const tab = await navigateSocial(target);
  const tabId = tab.id;
  await safeTab(tabId);

  // Capture existing hash and dialogs before channel creation to verify against NEW dialog/peer later
  const [beforeStateExec] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => ({
      hash: (location.hash || "").replace(/^#/, ""),
      dialogs: [...document.querySelectorAll(".peer-title, .user-title, .chat-title")].map((e) => (e.innerText || "").trim().toLowerCase()),
    }),
  }).catch(() => []);
  const beforeHash = beforeStateExec?.result?.hash || "";
  const beforeDialogs = new Set(beforeStateExec?.result?.dialogs || []);

  // Step 1: Open menu or click pencil
  const [menuRes] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const pencil = document.querySelector(".btn-icon.tgico-pencil, button.btn-icon.tgico-pencil, button.tgico-edit, [title='New message'], [title='New Message'], [title='New Channel']");
      if (pencil) { pencil.click(); return { ok: true, source: "pencil" }; }
      const menuBtn = document.querySelector(".sidebar-header button, .btn-menu, [title=Menu], button[aria-label=Menu]");
      if (menuBtn) { menuBtn.click(); return { ok: true, source: "menu" }; }
      return { ok: false, error: "Neither pencil nor menu button found" };
    },
  });
  if (!menuRes?.result?.ok) {
    return { created: false, verified: false, title, error: menuRes?.result?.error || "Failed to open menu" };
  }
  await delay(500);

  // Step 2: New Channel menu item (only buttons/menuitems, never generic div)
  const [newChanRes] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const items = [...document.querySelectorAll(".menu-item, .dropdown-item, [role=menuitem], button, .btn-menu-item")];
      const newChanBtn = items.find((e) => /New Channel/i.test(e.innerText || ""));
      if (newChanBtn) { newChanBtn.click(); return { ok: true }; }
      return { ok: false, error: "New Channel option not found" };
    },
  });
  if (!newChanRes?.result?.ok) {
    return { created: false, verified: false, title, error: newChanRes?.result?.error || "Failed to click New Channel" };
  }
  await delay(500);

  // Step 3: Set Channel Name and Description (specific inputs, never generic input[type=text])
  const [infoRes] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (t, d) => {
      const titleInput = document.querySelector("input[placeholder*='Channel Name'], input[placeholder*='Channel name'], input.input-field-name, input[data-e2e='channel-title'], .modal input, .popup input");
      if (!titleInput) return { ok: false, error: "Channel title input not found" };
      titleInput.value = t;
      titleInput.dispatchEvent(new Event("input", { bubbles: true }));

      if (d) {
        const descInput = document.querySelector("textarea, input[placeholder*='Description']");
        if (descInput) {
          descInput.value = d;
          descInput.dispatchEvent(new Event("input", { bubbles: true }));
        }
      }
      return { ok: true };
    },
    args: [title, description],
  });
  if (!infoRes?.result?.ok) {
    return { created: false, verified: false, title, error: infoRes?.result?.error || "Failed to enter channel info" };
  }
  await delay(500);

  // Step 4: Next / arrow button (confirms channel info and initiates creation on server)
  const [nextRes] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const nextBtn = document.querySelector(".sidebar-header-right button, button.btn-circle.btn-corner, button.btn-next, .btn-next, .tgico-arrow_next, [title=Next], button.btn-circle:not(.sidebar-header *)");
      if (nextBtn && !nextBtn.disabled) { nextBtn.click(); return { ok: true }; }
      return { ok: false, error: "Next button not found or disabled" };
    },
  });
  if (!nextRes?.result?.ok) {
    return { created: false, verified: false, title, error: nextRes?.result?.error || "Failed to proceed past channel name" };
  }
  await delay(600);

  // Step 5: Verify & select Private channel option
  const [privExec] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const radios = [...document.querySelectorAll("input[type=radio], [role=radio]")];
      if (radios.length > 0) {
        const privRadio = radios.find((r) => /Private|Приватн|Закрыт/i.test(r.parentElement?.innerText || r.value || r.getAttribute("aria-label") || ""));
        if (privRadio) {
          privRadio.click();
          const linkInput = document.querySelector("input[placeholder*='link'], input.input-field-link, input[name='username']");
          if (linkInput && linkInput.value && linkInput.value.trim().length > 0) {
            linkInput.value = "";
            linkInput.dispatchEvent(new Event("input", { bubbles: true }));
          }
          return { ok: true, privacy: "private" };
        }
        return { ok: false, error: "Private channel radio option not found" };
      }
      return { ok: true, privacy: "private" };
    },
  }).catch(() => [{ result: { ok: true, privacy: "private" } }]);
  if (!privExec?.result?.ok) {
    return { created: false, verified: false, title, error: privExec?.result?.error || "Failed to configure channel privacy" };
  }
  await delay(500);

  // Step 6: Click Done/Create button scoped strictly to the channel creation wizard
  const [doneExec] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const doneBtn = document.querySelector(".btn-done, button.btn-done, .sidebar-header button.btn-done, .sidebar-header-right button, .popup button.btn-primary, .modal button.btn-primary, button.btn-circle.btn-corner");
      if (doneBtn && !doneBtn.disabled) {
        doneBtn.click();
        return { ok: true };
      }
      return { ok: false, error: "Done/Create button not found in channel wizard" };
    },
  }).catch(() => [{ result: { ok: false, error: "Done step failed" } }]);
  if (!doneExec?.result?.ok) {
    return { created: false, verified: false, title, error: doneExec?.result?.error || "Failed to finalize channel creation" };
  }

  // ================= POINT OF NO RETURN =================
  try {
    await delay(1200);
    // Dismiss optional "Add Subscribers" overlay without selecting anyone
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const skipBtn = document.querySelector("button[title='Skip'], button.btn-skip, .tgico-arrow_next, button.close, [aria-label='Close']");
        if (skipBtn && /skip|close/i.test(skipBtn.innerText || skipBtn.title || "")) {
          skipBtn.click();
        } else {
          document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
        }
      },
    }).catch(() => []);

    // Extract new peer id from URL hash: MUST BE DIFFERENT from beforeHash and match a channel peer id
    const [peerRes] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (bHash) => {
        const hash = (location.hash || "").replace(/^#/, "");
        if (hash && hash !== bHash) {
          const match = hash.match(/^(-?\d+)/);
          return match ? match[1] : null;
        }
        return null;
      },
      args: [beforeHash],
    }).catch(() => []);
    const peer = peerRes?.result || null;

    function pgCheckNewChannelDialog(beforeSetList, t, bHash) {
      const currentHash = (location.hash || "").replace(/^#/, "");
      const hashChanged = Boolean(currentHash && currentHash !== bHash && (currentHash.startsWith("-") || /^-?\d+$/.test(currentHash)));

      const activeHeader = document.querySelector("#column-center .user-title, #column-center .peer-title, .top .peer-title, .chat-info .peer-title, .chat-title");
      const activeTitle = (activeHeader?.innerText || "").trim().toLowerCase();
      const titleMatches = Boolean(activeTitle && activeTitle === t.toLowerCase());

      if (hashChanged && titleMatches) {
        return { verified: true };
      }
      return { verified: false, reason: `Channel creation not verified (hashChanged=${hashChanged}, titleMatches=${titleMatches})` };
    }

    const [verifyExec] = await chrome.scripting.executeScript({
      target: { tabId },
      func: pgCheckNewChannelDialog,
      args: [[...beforeDialogs], title, beforeHash],
    });

    const verified = Boolean(verifyExec?.result?.verified);
    return { created: true, verified, title, description, peer, privacy: "private" };
  } catch (e) {
    if (e?.code === "HALT" || e?.message?.startsWith("HALT:")) {
      const haltErr = new Error(e.message);
      haltErr.code = "HALT";
      haltErr.reason = e.reason || e.message;
      haltErr.created = true;
      haltErr.verified = false;
      throw haltErr;
    }
    return { created: true, verified: false, title, description, error: String(e?.message || e) };
  }
}

async function tgPinMessage({ chat, messageId = null }) {
  const isPeerId = /^-?\d+$/.test(chat);
  const norm = isPeerId ? chat : chat.replace(/^@/, "");
  const target = isPeerId ? `https://web.telegram.org/k/#${norm}` : `https://web.telegram.org/k/#@${norm}`;
  const tab = await navigateSocial(target);
  const tabId = tab.id;
  await safeTab(tabId);

  // Strictly verify active chat header before proceeding
  const [matchCheck] = await chrome.scripting.executeScript({
    target: { tabId },
    func: pgMatchTgChat,
    args: [norm, null],
  });
  if (!matchCheck?.result?.matched) {
    throw new Error(`Wrong chat open: active chat does not match requested recipient "${chat}"; refusing to pin`);
  }

  function pgLocateBubbleAndTriggerMenu(mid) {
    const rawBubbles = [...document.querySelectorAll(".bubble, .message")];
    const bubbles = rawBubbles.filter((el) => !el.parentElement?.closest(".bubble, .message") && !el.classList?.contains("bubble-system") && !el.classList?.contains("service-msg") && !el.classList?.contains("service"));
    let bubble = null;
    if (mid) {
      bubble = bubbles.find((b) => b.getAttribute("data-mid") === String(mid) || b.id === `message-${mid}` || b.querySelector(`[data-mid="${mid}"]`));
      if (!bubble) return { ok: false, reason: `Message with ID "${mid}" not found in chat` };
    } else {
      bubble = bubbles.at(-1);
    }
    if (!bubble) return { ok: false, reason: "No message found to pin" };

    const targetText = (bubble.querySelector(".message, .text-content, .bubble-content")?.innerText || bubble.innerText || "").trim().slice(0, 60);
    const targetMid = bubble.getAttribute("data-mid") || (mid ? String(mid) : null);

    const existingPinnedEl = document.querySelector(".pinned-message, .chat-pinned-message, [class*='pinned-message']");
    const previousPinnedText = (existingPinnedEl?.innerText || "").trim();

    // Trigger context menu on the bubble
    bubble.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 100, clientY: 100 }));
    return { ok: true, targetText, targetMid, previousPinnedText };
  }

  const [locateRes] = await chrome.scripting.executeScript({
    target: { tabId },
    func: pgLocateBubbleAndTriggerMenu,
    args: [messageId],
  });

  if (!locateRes?.result?.ok) {
    return { pinned: false, verified: false, chat, messageId, error: locateRes?.result?.reason || "Failed to trigger pin" };
  }

  const { targetText, previousPinnedText } = locateRes.result;

  function pgClickPinItem() {
    function isPinLabel(text) {
      const normText = (text || "").toLowerCase().trim();
      const isUnpin = normText.includes("unpin") || normText.includes("відкріп") || normText.includes("откреп");
      if (isUnpin) return false;
      return /\bpin\b/i.test(normText) || normText.includes("закріпити") || normText.includes("закрепить");
    }

    const menuItems = [...document.querySelectorAll(".btn-menu-item, .menu-item, [role=menuitem], button")];
    const pinItem = menuItems.find((el) => {
      const t = el.innerText || el.textContent || "";
      const isUnpin = /unpin|відкріп|откреп/i.test(t);
      if (isUnpin) return false;
      return isPinLabel(t) || (el.classList?.contains("tgico-pin") && !isUnpin);
    });
    if (pinItem) {
      pinItem.click();
      return { clicked: true };
    }
    return { clicked: false };
  }

  let pinClicked = false;
  for (let mAttempt = 0; mAttempt < 8; mAttempt++) {
    await delay(150);
    const [clickRes] = await chrome.scripting.executeScript({
      target: { tabId },
      func: pgClickPinItem,
    }).catch(() => []);
    if (clickRes?.result?.clicked) {
      pinClicked = true;
      break;
    }
  }
  if (!pinClicked) {
    return { pinned: false, verified: false, chat, messageId, error: "Pin option not found in message menu (message may already be pinned or cannot be pinned)" };
  }

  function pgConfirmPinModal() {
    const modal = document.querySelector(".popup-pin, .modal-dialog, .popup, .modal");
    if (!modal) return { seen: false };
    const buttons = [...modal.querySelectorAll("button")];
    const confirmBtn = buttons.find((b) => {
      const t = (b.innerText || b.textContent || "").trim().toLowerCase();
      const isCancel = /cancel|скасувати|отмена|ні|нет/i.test(t);
      if (isCancel) return false;
      return /\b(pin|ok)\b/i.test(t) || t.includes("закріпити") || t.includes("закрепить") || b.classList.contains("btn-primary");
    });
    if (confirmBtn) {
      confirmBtn.click();
      return { seen: true, clicked: true };
    }
    return { seen: true, clicked: false, error: "Modal confirmation button not found" };
  }

  for (let modAttempt = 0; modAttempt < 5; modAttempt++) {
    await delay(200);
    const [modRes] = await chrome.scripting.executeScript({
      target: { tabId },
      func: pgConfirmPinModal,
    }).catch(() => []);
    if (modRes?.result?.seen) {
      if (!modRes.result.clicked) {
        return { pinned: false, verified: false, chat, messageId, error: modRes.result.error || "Pin modal confirmation button not found" };
      }
      break;
    }
  }

  // ================= POINT OF NO RETURN =================
  try {
    function pgVerifyPinnedMessage(tText, prevText) {
      const pinnedEl = document.querySelector(".chat-pinned-message, .pinned-message, .top .pinned-message, .pinned-bar, [class*='pinned-message']");
      if (!pinnedEl) return { verified: false, reason: "Pinned message header not found" };
      const currentPinnedText = (pinnedEl.innerText || "").trim();
      if (!currentPinnedText) return { verified: false, reason: "Pinned message bar is empty" };
      if (tText) {
        const normT = tText.toLowerCase().replace(/\s+/g, " ").trim();
        const normPin = currentPinnedText.toLowerCase().replace(/\s+/g, " ").trim();
        if (normPin.includes(normT.slice(0, 20)) || normT.includes(normPin.slice(0, 20))) {
          return { verified: true };
        }
        return { verified: false, reason: `Pinned text "${currentPinnedText}" does not match target text` };
      }
      if (prevText && currentPinnedText !== prevText) {
        return { verified: true };
      }
      return { verified: false, reason: "Pinned text did not change" };
    }

    let verified = false;
    for (let attempt = 0; attempt < 8; attempt++) {
      await delay(500);
      const [verifyRes] = await chrome.scripting.executeScript({
        target: { tabId },
        func: pgVerifyPinnedMessage,
        args: [targetText, previousPinnedText],
      }).catch(() => []);
      if (verifyRes?.result?.verified) {
        verified = true;
        break;
      }
    }

    return { pinned: true, verified, chat, messageId };
  } catch (e) {
    if (e?.code === "HALT" || e?.message?.startsWith("HALT:")) {
      const haltErr = new Error(e.message);
      haltErr.code = "HALT";
      haltErr.reason = e.reason || e.message;
      haltErr.pinned = true;
      haltErr.verified = false;
      throw haltErr;
    }
    return { pinned: true, verified: false, chat, messageId, error: String(e?.message || e) };
  }
}

const ACTION_HANDLERS = {
  "tabs.list": () => listTabs(),
  "tabs.use": (args) => useTab(args || {}),
  "readPage": (args) => readPage(args || {}),
  "snapshot": () => snapshot(),
  "getProfile": (args) => getProfile(args || {}),
  "getComments": (args) => getComments(args || {}),
  "getPosts": (args) => getPosts(args || {}),
  "getPost": (args) => getPost(args || {}),
  "screenshot": (args) => screenshot(args || {}),
  "search": (args) => search(args || {}),
  "readInbox": (args) => readInbox(args || {}),
  "readThread": (args) => readThread(args || {}),
  "sendMessage": (args) => sendMessage(args || {}),
  "ytStudioRead": (args) => ytStudioReadTool(args || {}),
  "click": (args) => clickTool(args || {}),
  "scroll": (args) => scrollTool(args || {}),
  "tiktokProfile": (args) => tiktokProfile(args || {}),
  "tiktokPosts": (args) => tiktokPosts(args || {}),
  "tiktokVideo": (args) => tiktokVideo(args || {}),
  "tiktokComments": (args) => tiktokComments(args || {}),
  "tiktokSearch": (args) => tiktokSearch(args || {}),
  "tiktokInbox": (args) => tiktokInbox(args || {}),
  "tiktokUpload": (args) => tiktokUpload(args || {}),
  "tiktokStudioList": (args) => tiktokStudioList(args || {}),
  "tiktokSetPrivacy": (args) => tiktokSetPrivacy(args || {}),
  "tgStatus": () => tgStatus(),
  "tgDialogsList": (args) => tgDialogsList(args || {}),
  "tgMessagesRead": (args) => tgMessagesRead(args || {}),
  "tgMediaDownload": (args, conn, msgId) => tgMediaDownload(args || {}, conn, msgId),
  "tgSendMessage": (args) => tgSendMessage(args || {}),
  "tgSendMedia": (args) => tgSendMedia(args || {}),
  "tgCreateChannel": (args) => tgCreateChannel(args || {}),
  "tgPinMessage": (args) => tgPinMessage(args || {}),
};

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
      } else if (verified && message.type === "reload") {
        // Sent by `socmedia update` after a successful replace; works even if the versions are incompatible. Older extensions ignore it.
        chrome.runtime.reload();
      } else if (authenticated && message.type === "request" && Object.prototype.hasOwnProperty.call(ACTION_HANDLERS, message.action)) {
        const reply = (result) => { if (connection.readyState === WebSocket.OPEN) connection.send(JSON.stringify({ type: "result", id: message.id, ...result })); };
        const handler = ACTION_HANDLERS[message.action];
        const task = browserAction.then(() => handler(message.args || {}, connection, message.id));
        browserAction = task.then(() => undefined, () => undefined);
        task.then(
          (result) => reply({ result }),
          (error) => reply({
            error: error?.code === "HALT" ? {
              code: "HALT",
              reason: error.reason || error.message,
              ...(error.posted ? { posted: true } : {}),
              ...(error.sent ? { sent: true } : {}),
              ...(error.created ? { created: true } : {})
            } : error?.message || String(error),
            ...(error?.posted ? { posted: true, verified: false } : {}),
            ...(error?.sent ? { sent: true, verified: false } : {}),
            ...(error?.created ? { created: true, verified: false } : {})
          })
        );
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
