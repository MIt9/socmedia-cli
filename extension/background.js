let socket;
let browserAction = Promise.resolve();
let connectEpoch = 0;

const GROUP_TITLE = "Socmedia CLI";
const isSocial = (url) => /^https:\/\/([\w-]+\.)*(instagram|facebook|youtube)\.com\//.test(url || "");

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
  if (location.hostname.includes("facebook.com") && (document.querySelector("form#login_form") || (document.querySelector('input[name="email"]') && document.querySelector('input[name="pass"]')))) return "not logged in (Facebook login form)";
  const pattern = /Try Again Later|We restrict certain activity|suspicious activity|Confirm it['’]s you|You['’]re Temporarily Blocked/i;
  const dialogs = [...document.querySelectorAll('[role=dialog], [role=alertdialog], [role=alert]')];
  if ((document.body?.innerText || "").length < 3000 && document.body) dialogs.push(document.body);
  for (const element of dialogs) { const match = (element?.innerText || "").match(pattern); if (match) return `security check: "${match[0]}"`; }
  return null;
}

async function readPage({ maxLines = 200 }) {
  if (!Number.isInteger(maxLines) || maxLines < 1 || maxLines > 1000) throw new Error("maxLines must be an integer from 1 to 1000");
  const { tabId } = await getWorkTab(false);
  const tab = await chrome.tabs.get(tabId);
  if (!isSocial(tab.url)) throw new Error("Work tab is not an open Instagram, Facebook or YouTube tab");
  const path = new URL(tab.url).pathname.toLowerCase();
  const blockedPath = ["/challenge", "/checkpoint", "/accounts/login", "/login", "/suspended"].find((part) => path.includes(part));
  const [check] = blockedPath ? [] : await chrome.scripting.executeScript({ target: { tabId }, func: inspectPage });
  const reason = blockedPath ? `URL path "${blockedPath}"` : check?.result;
  if (reason) {
    const error = new Error(`HALT: ${reason}`);
    error.code = "HALT";
    error.reason = reason;
    throw error;
  }
  const [execution] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (limit) => (document.body?.innerText || "").split("\n").map((line) => line.trim()).filter(Boolean).slice(0, limit),
    args: [maxLines],
  });
  const lines = execution?.result || [];
  return { url: tab.url, text: lines.join("\n"), lines };
}

async function connect() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  const epoch = ++connectEpoch;
  const { token, port: savedPort } = await chrome.storage.local.get(["token", "port"]);
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
      } else if (authenticated && message.type === "request" && (message.action === "tabs.list" || message.action === "tabs.use" || message.action === "readPage")) {
        const reply = (result) => { if (connection.readyState === WebSocket.OPEN) connection.send(JSON.stringify({ type: "result", id: message.id, ...result })); };
        const task = browserAction.then(() => message.action === "tabs.list" ? listTabs() : message.action === "tabs.use" ? useTab(message.args || {}) : readPage(message.args || {}));
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
