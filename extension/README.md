# Socmedia CLI Chrome bridge

1. Open `chrome://extensions`, enable Developer mode, select **Load unpacked**, and choose this `extension` directory. Copy its 32-character extension ID.
2. Run `bun run src/cli.ts extension pair --id EXTENSION_ID --json`. Copy the `token` value from the output; it is a secret. The service stores it locally in a mode-0600 file. Re-pairing replaces the old secret; restart an already running service to disconnect previously paired clients.
3. Open the Socmedia extension popup, paste the token into **Pairing secret**, and select **Save**. The extension stores it in its local Chrome storage.
4. Start the service with `bun run src/cli.ts service start --json`. Run `bun run src/cli.ts service status --json`; `extension.connected` reports the authenticated handshake, and `extension.compatible` reports an exact version match.

The extension connects to `127.0.0.1:47842`, separate from the old bridge. `SOCMEDIA_EXTENSION_PORT` changes the service port; the extension address must also be changed if you use an override. `socmedia tabs list --json` lists the Social bot group and selected tab; other browser actions are not implemented. The new extension has not yet been tested live in Chrome. Reload the extension in Chrome after updating its files.

Both sides authenticate with HMAC-SHA-256 challenges containing fresh nonces; the stored pairing secret is never sent over the WebSocket. Browser requests are accepted only after the extension verifies the service's proof. The service also checks the configured Chrome extension Origin before the handshake.
