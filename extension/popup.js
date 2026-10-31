const token = document.getElementById("token");
const message = document.getElementById("message");
document.getElementById("save").addEventListener("click", async () => {
  const value = token.value.trim();
  if (!/^[a-f0-9]{64}$/.test(value)) { message.textContent = "Enter the 64-character pairing secret."; return; }
  await chrome.storage.local.set({ token: value });
  token.value = "";
  message.textContent = "Saved. The extension will connect to the local service.";
});
