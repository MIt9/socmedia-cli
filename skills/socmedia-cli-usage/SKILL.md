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
   - Write/mutating operations (`socmedia message send`, `socmedia youtube upload`) enforce a strict **Preview Gate**.
   - Running without `--confirm` returns a dry-run preview (`{ preview: {...}, sent: false }` or `{ preview: {...}, uploaded: false }`).
   - The agent MUST show this preview to the user and await explicit confirmation. The agent must NEVER add `--confirm` without direct user request.
2. **Handling `HALT` (Checkpoints, Captchas, Logins)**:
   - When Instagram or Facebook displays an authentication challenge, captcha, or checkpoint, the daemon immediately enters `HALT` state and freezes queue execution.
   - Do NOT retry in a loop! Automated retries during a challenge risk account lockouts.
   - Notify the user to open Google Chrome, complete the challenge manually in the tab, and then run:
     ```bash
     socmedia service resume
     ```
3. **Daily Message Limits & Slot Spacing**:
   - Outgoing DMs are bounded by `SOCMEDIA_MAX_MESSAGES_PER_DAY` (default: 20).
   - Identical messages to the same recipient within 7 days are rejected as duplicate spam prevention.
   - Enforced slot pacing (90s + jitter) spaces out outgoing actions.
4. **YouTube Channel Allowlist**:
   - YouTube Studio operations only permit uploads to channels defined with `"write": true` in `~/.socmedia-cli/youtube.json`.
5. **Handling `unverified` Message Status**:
   - If a message send returns `unverified`, it means DOM insertion succeeded but UI readback confirmation was ambiguous. Inspect the thread before attempting any repeat.

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
- **Send direct message (Dry-run preview)**:
  ```bash
  socmedia message send --to https://www.instagram.com/direct/t/THREAD_ID/ --text "Hello!" [--json]
  ```
- **Send direct message (Confirmed)**:
  ```bash
  socmedia message send --to https://www.instagram.com/direct/t/THREAD_ID/ --text "Hello!" --confirm [--json]
  ```

### YouTube Studio Integration
- **List configured channels**:
  ```bash
  socmedia youtube channel [--channel KEY] [--json]
  ```
- **Inspect Studio session**:
  ```bash
  socmedia youtube studio status --open [--channel KEY] [--json]
  ```
- **Upload video draft (Dry-run preview)**:
  ```bash
  socmedia youtube upload ~/Videos/intro.mp4 --title "Introduction" --privacy private [--json]
  ```
- **Upload video draft (Confirmed)**:
  ```bash
  socmedia youtube upload ~/Videos/intro.mp4 --title "Introduction" --privacy private --confirm [--json]
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

- **DOM dependencies**: Web selectors depend on Instagram and Facebook DOM hierarchies. If a social platform updates their frontend, run `socmedia page snapshot` to identify updated selectors.
- **Live sessions required**: The extension runs in the user's Chrome instance; user must be logged in to target platforms.
