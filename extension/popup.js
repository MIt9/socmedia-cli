const token = document.getElementById("token");
const message = document.getElementById("message");
const portInput = document.getElementById("port");
const portMessage = document.getElementById("port-message");
chrome.storage.local.get("port").then(({ port }) => { portInput.value = String(port ?? 47842); });
document.getElementById("save-port").addEventListener("click", async () => {
  const raw = portInput.value.trim();
  const port = Number(raw);
  if (!/^[1-9]\d*$/.test(raw) || port > 65535) { portMessage.textContent = "Enter a port from 1 to 65535."; return; }
  await chrome.storage.local.set({ port });
  portMessage.textContent = "Port saved. The extension will reconnect.";
});
document.getElementById("save").addEventListener("click", async () => {
  const value = token.value.trim();
  if (!/^[a-f0-9]{64}$/.test(value)) { message.textContent = "Enter the 64-character pairing secret."; return; }
  await chrome.storage.local.set({ token: value });
  token.value = "";
  message.textContent = "Saved. The extension will connect to the local service.";
});
