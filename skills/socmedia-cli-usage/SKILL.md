---
name: socmedia-cli-usage
description: How to drive the `socmedia` CLI (local Bun service + Chrome MV3 extension) to interact with Instagram, Facebook, and YouTube Studio — search profiles, read posts, download profile media, extract post comments, manage inboxes, send direct messages safely, upload YouTube Studio drafts, manage contacts, configure ports, run doctor checks, and inspect queue jobs. Use whenever asked to interact with Instagram, Facebook, or YouTube, read social media data, manage leads/contacts, send messages, or diagnose why the socmedia service or extension does not work.
---

# Socmedia CLI Usage

The CLI's `--help` is the source of truth; this skill mirrors and summarizes its operations. Always inspect `socmedia <command> --help` (or `socmedia --help --json`) for full parameter options.

## Architecture & Ports

- **Background Daemon**: Local Bun process maintaining a UNIX socket (`~/.socmedia-cli/service.sock`) and an HTTP/WebSocket server listening on port `47842` (or configured via `SOCMEDIA_EXTENSION_PORT` / `socmedia config set port <port>`).
- **SQLite Queue**: Single source of truth for jobs, state, contacts, and message logs at `~/.socmedia-cli/state.sqlite`.
- **Chrome MV3 Extension**: Unpacked extension in `~/.socmedia-cli/extension` connecting over HMAC-SHA256 authenticated WebSocket. Operates exclusively within the "Socmedia CLI" Chrome tab group.
- **Pinned Extension ID**: Always `ingpbbhdgldgomideaihffffiinjgifj`.

## Before Working Checklist

1. Run diagnostics first:
   ```bash
   socmedia doctor
   ```
   If any check fails, execute the printed `fix` command (e.g. `chmod 700 ~/.socmedia-cli`, `socmedia extension install`).
2. Start and verify the service:
   ```bash
   socmedia service start
   socmedia service status
   ```
   Ensure `running: true`, `pinnedId: "ingpbbhdgldgomideaihffffiinjgifj"`, and `extension.connected: true`.
3. If the extension is not yet loaded into Google Chrome:
   ```bash
   socmedia extension install --open
   ```
   Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select `~/.socmedia-cli/extension`.

## Agent Output Format & Ergonomics

- **Automated / Agent Shells**: When running inside non-interactive environments (subshells, pipes, AI agent tool execution), output defaults to machine-readable **JSON** on `stdout`.
- **Human / Terminal Format**: Force human-formatted text with `--text` or `SOCMEDIA_CLI_FORMAT=text`.
- **Structured Error Reporting**: Errors emit `{ "error": "...", "hint": "...", "code": "..." }` to `stderr` with a non-zero exit code.

## Critical Safety Rails for AI Agents

1. **NEVER autonomously add `--confirm`**:
   - Write/mutating operations (`socmedia message send`, `socmedia youtube upload`, `socmedia tiktok upload`, `socmedia telegram message send`, `socmedia telegram media send`, `socmedia telegram channel create`) enforce a strict **Preview Gate**.
   - Running without `--confirm` returns a dry-run preview (`{ preview: {...}, sent: false }`, `{ preview: {...}, uploaded: false }`, or `{ preview: {...}, created: false }`).
   - The agent MUST show this preview to the user and await explicit confirmation. The agent must NEVER add `--confirm` without direct user request.
   - Note: execution with `--confirm` for `socmedia message send` and `socmedia youtube upload` is currently not implemented (`NOT_IMPLEMENTED`).
2. **Handling `HALT` (Checkpoints, Captchas, Logins, FLOOD)**:
   - When Instagram, Facebook, TikTok (login form or slider captcha), or Telegram (login/QR page, phone number prompt, or FLOOD/too-many-attempts notice) displays an authentication challenge, captcha, or checkpoint, the daemon immediately enters `HALT` state and freezes queue execution.
   - Do NOT retry in a loop! Automated retries during a challenge risk account lockouts.
   - Notify the user to open Google Chrome, complete the challenge manually in the tab, and then run:
     ```bash
     socmedia service resume
     ```
3. **Daily Limits & Slot Spacing**:
   - Outgoing DMs (Instagram, Facebook, Telegram) are bounded by `SOCMEDIA_MAX_MESSAGES_PER_DAY` (default: 20 per platform).
   - Identical messages to the same recipient within 7 days are rejected as duplicate spam prevention.
   - TikTok video uploads are bounded by `SOCMEDIA_MAX_TIKTOK_UPLOADS_PER_DAY` (default: 5). Identical files (by sha256) within 7 days are rejected.
   - Telegram private channel creation is bounded by `SOCMEDIA_MAX_TG_CHANNELS_PER_DAY` (default: 3).
   - Enforced slot pacing (90s + jitter) spaces out outgoing actions.
4. **YouTube Channel Allowlist**:
   - YouTube Studio operations only permit uploads to channels defined with `"write": true` in `~/.socmedia-cli/youtube.json`.
5. **Handling `unverified` Action Status & Result Fields**:
   - **Result fields**:
     - `sent` (boolean): true if message or media send action was dispatched.
     - `posted` (boolean): true if video upload was submitted past the point of no return.
     - `created` (boolean): true if channel creation was submitted.
     - `verified` (boolean): true ONLY if post-action verification succeeded (new video URL with matching caption, new outgoing bubble, or new dialog); false if interrupted or verification failed after the point of no return.
     - `saved` (array of `[{ path, type, preview }]`): files actually validated and written to disk by the service.
     - `skipped` (array of `[{ type, reason, preview }]`): media skipped during download with specific reason (e.g. `File exceeds 50 MB limit`, `Invalid or unsupported media format`).
     - `preview` (boolean): true for media thumbnails/previews or dry-run preview responses without `--confirm`.
   - Side-effect operations (`sendMessage`, `tiktokUpload`, `tgSendMessage`, `tgSendMedia`, `tgCreateChannel`) that encounter ambiguous UI readback, extension disconnect, restart, or timeout are recorded as `unverified` (`verified: false`) and NEVER automatically retried or requeued.
   - Inspect the state via `socmedia queue get <JOB_ID>` and verify in the browser before taking any repeat action. Do not retry side effects blindly.

## Commands Reference

### System, Diagnostics & Maintenance
- **System diagnostic health check**:
  ```bash
  socmedia doctor [--json]
  ```
- **Check for or apply CLI updates**:
  ```bash
  socmedia update --check [--json]
  socmedia update [--json]
  ```
- **Daemon lifecycle**:
  ```bash
  socmedia service start [--json]
  socmedia service status [--json]
  socmedia service stop [--json]
  socmedia service resume [--json]
  ```
- **Service port configuration**:
  ```bash
  socmedia config get port [--json]
  socmedia config set port 47842 [--json]
  socmedia config unset port [--json]
  ```

### Chrome Extension & Tabs
- **Install and pair extension**:
  ```bash
  socmedia extension install [--open] [--json]
  socmedia extension path [--json]
  socmedia extension pair --id <ID> [--json]
  ```
- **Manage work tabs**:
  ```bash
  socmedia tabs list [--json]
  socmedia tabs use <TAB_ID> [--json]
  socmedia tabs clear [--json]
  ```

### Profiles, Posts, and Search
- **Search users, pages, places, or hashtags**:
  ```bash
  socmedia search ig "techcrunch" --type users --limit 10 [--json]
  socmedia search fb "software" --type pages --limit 10 [--json]
  ```
- **Inspect social profile**:
  ```bash
  socmedia profile get https://www.instagram.com/github/ [--json]
  ```
  *(Automatically records or updates profile contact in SQLite contacts).*
- **List profile posts**:
  ```bash
  socmedia profile posts https://www.instagram.com/github/ --limit 12 [--json]
  ```
- **Download complete profile package**:
  ```bash
  socmedia profile download https://www.instagram.com/github/ --limit 10 --max-media 5 [--background] [--json]
  ```
- **Get post details and download media**:
  ```bash
  socmedia post get https://www.instagram.com/p/POST_ID/ --download [--json]
  ```
- **Extract post comments (via Chrome debugger)**:
  ```bash
  socmedia post comments https://www.instagram.com/p/POST_ID/ --limit 50 [--json]
  ```

### Browser Automation & Screenshots
- **Capture screenshot**:
  ```bash
  socmedia screenshot --url https://www.instagram.com/github/ --target profile [--json]
  socmedia screenshot --target viewport --selector "article" --path ~/screenshot.png [--json]
  ```
- **Inspect active work page**:
  ```bash
  socmedia page read --max-lines 100 [--json]
  socmedia page snapshot [--json]
  ```
- **Click and scroll interactions**:
  ```bash
  socmedia browser click --selector "button[type='submit']" [--json]
  socmedia browser click --index 3 [--json]
  socmedia browser scroll --times 3 [--json]
  ```

### Contacts & Lead Management
- **List and filter contacts**:
  ```bash
  socmedia contacts list --platform ig --status new [--json]
  ```
- **Update contact status and notes**:
  ```bash
  socmedia contacts update ig:github --status replied --note "Requested proposal" [--json]
  ```
- **Export contacts to CSV/JSON/JSONL inside home**:
  ```bash
  socmedia contacts export --format csv --path ~/socmedia-data/contacts.csv [--json]
  ```
- **Import legacy contacts from MCP directory**:
  ```bash
  socmedia contacts import --from ~/.socmedia-mcp [--json]
  ```

### Direct Messaging & Inbox
- **List conversations**:
  ```bash
  socmedia inbox list ig --limit 20 [--json]
  ```
- **Read conversation thread**:
  ```bash
  socmedia inbox read --url https://www.instagram.com/direct/t/THREAD_ID/ [--json]
  ```
- **Send direct message (preview, no `--confirm`)**:
  ```bash
  socmedia message send --to https://www.instagram.com/direct/t/THREAD_ID/ --text "Hello!" [--json]
  ```
- Only after the user explicitly approves this exact preview, re-run the identical command with `--confirm` appended; never before.

### YouTube Studio Integration
- **List configured channels**:
  ```bash
  socmedia youtube channel [--channel KEY] [--json]
  ```
- **Inspect Studio session**:
  ```bash
  socmedia youtube studio status --open [--channel KEY] [--json]
  ```
- **Upload video draft (preview, no `--confirm`)**:
  ```bash
  socmedia youtube upload ~/Videos/intro.mp4 --title "Introduction" --privacy private [--json]
  ```
- Same rule: re-run the identical upload with `--confirm` appended only after the user explicitly approves the preview.

### TikTok Operations
- **Read TikTok profile**:
  ```bash
  socmedia tiktok profile https://www.tiktok.com/@username [--json]
  ```
- **List TikTok posts**:
  ```bash
  socmedia tiktok posts https://www.tiktok.com/@username --limit 12 [--json]
  ```
- **Get video info and download**:
  ```bash
  socmedia tiktok video https://www.tiktok.com/@username/video/1234567890 --download [--json]
  ```
- **Read comments**:
  ```bash
  socmedia tiktok comments https://www.tiktok.com/@username/video/1234567890 --limit 20 [--json]
  ```
- **Search TikTok**:
  ```bash
  socmedia tiktok search "creator" --type users --limit 20 [--json]
  ```
- **List inbox messages (read-only; no send)**:
  ```bash
  socmedia tiktok inbox list [--limit 20] [--json]
  ```
  *(Note: TikTok inbox is strictly read-only; sending direct messages is not supported).*
- **Upload video draft (preview, no `--confirm`)**:
  ```bash
  socmedia tiktok upload ~/Videos/clip.mp4 --caption "My video" --privacy private [--json]
  ```

### Telegram Web K Operations
- **Check login status and account**:
  ```bash
  socmedia telegram status [--json]
  ```
- **List dialogs**:
  ```bash
  socmedia telegram dialogs list --limit 20 [--json]
  ```
- **Read messages from chat**:
  ```bash
  socmedia telegram messages read @username --limit 30 [--json]
  ```
- **Send text message (preview, no `--confirm`)**:
  ```bash
  socmedia telegram message send @username --text "Hello" [--json]
  ```
- **Download media from chat**:
  ```bash
  socmedia telegram media download @username --limit 10 --types photo,video [--dir ~/Downloads] [--json]
  ```
- **Send photo or video (preview, no `--confirm`)**:
  ```bash
  socmedia telegram media send @username ~/Photos/pic.jpg --caption "Photo" [--json]
  ```
- **Create private channel (preview, no `--confirm`)**:
  ```bash
  socmedia telegram channel create --title "My Channel" --description "Private channel" [--json]
  ```

### Queue Management
- **Inspect and cancel jobs**:
  ```bash
  socmedia queue list [--json]
  socmedia queue get <JOB_ID> [--json]
  socmedia queue cancel <JOB_ID> [--json]
  socmedia queue enqueue readPage --args '{"maxLines":50}' [--json]
  ```

## Troubleshooting & Edge Cases

- **`PORT_IN_USE` error**: Another process is occupying the configured port. Run `socmedia doctor` to inspect, or change the port via `socmedia config set port <PORT>` and restart with `socmedia service start`.
- **Extension disconnected**: If Chrome was closed or extension crashed, open Chrome, verify the extension at `chrome://extensions`, and check the popup connection button.
- **Queue recovery**: Any job interrupted by service stop or crash will automatically reset to `queued` on restart. Sequential FIFO processing guarantees no concurrent race conditions.

## Limitations

- **Unverified live DOM selectors**: All DOM selectors for TikTok (`www.tiktok.com`) and Telegram Web K (`web.telegram.org/k/`) were written from specification and memory and are **unverified live** in real Chrome. Instagram and Facebook selectors depend on frontend hierarchies. If a platform changes markup, run `socmedia page snapshot` to identify updated elements.
- **TikTok Inbox**: Read-only support. There is no direct message sending support (`no send`).
- **Daily caps and duplicate rules**: Outgoing message caps (20/day per platform), upload caps (5/day), and channel creation caps (3/day) include active queued and running jobs. 7-day duplicate checks enforce uniqueness on message text and upload file SHA256. Telegram messages enforce a strict 90s + 0..60s slot gap.
- **Live sessions required**: The extension runs in the user's Chrome instance; user must be logged in to target platforms.
