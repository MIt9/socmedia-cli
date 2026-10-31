const URL = "ws://127.0.0.1:47842/extension";
let socket;

async function listTabs() {
  const { selectedTab, workTabId, groupId } = await chrome.storage.local.get(["selectedTab", "workTabId", "groupId"]);
  let group = groupId != null ? await chrome.tabGroups.get(groupId).catch(() => null) : null;
  if (!group) {
    [group] = await chrome.tabGroups.query({ title: "Social bot" });
    await chrome.storage.local.set({ groupId: group?.id ?? null });
  }
  const tabs = group ? await chrome.tabs.query({ groupId: group.id }) : [];
  const selected = selectedTab != null ? await chrome.tabs.get(selectedTab).catch(() => null) : null;
  const validSelected = selected && /^https:\/\/([\w-]+\.)*(instagram|facebook|youtube)\.com\//.test(selected.url || "") ? selected : null;
  if (validSelected && !tabs.some((tab) => tab.id === validSelected.id)) tabs.push(validSelected);
  return tabs.map((tab) => ({ tabId: tab.id, windowId: tab.windowId, url: tab.url, title: tab.title, active: tab.active, selected: tab.id === validSelected?.id, work: tab.id === workTabId }));
}

async function connect() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  const { token } = await chrome.storage.local.get("token");
  if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) return;
  const version = chrome.runtime.getManifest().version;
  const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  const nonce = hex(crypto.getRandomValues(new Uint8Array(32)));
  const key = await crypto.subtle.importKey("raw", new Uint8Array(token.match(/../g).map((byte) => parseInt(byte, 16))), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const proof = async (role, serverNonce) => hex(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${role}:${nonce}:${serverNonce}:${version}`))));
  socket = new WebSocket(URL);
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
      } else if (authenticated && message.type === "request" && message.action === "tabs.list") {
        const reply = (result) => { if (connection.readyState === WebSocket.OPEN) connection.send(JSON.stringify({ type: "result", id: message.id, ...result })); };
        listTabs().then((result) => reply({ result }), (error) => reply({ error: error.message }));
      }
    } catch { connection.close(); }
  };
}

chrome.alarms.create("reconnect", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === "reconnect") connect(); });
chrome.runtime.onStartup.addListener(connect);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.token) { socket?.close(); socket = undefined; connect(); }
});
connect();
