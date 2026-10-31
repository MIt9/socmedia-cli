---
name: socmedia-cli-usage
description: How to drive the `socmedia` CLI (local Bun service + Chrome MV3 extension) to interact with Instagram, Facebook, and YouTube Studio — search profiles, read posts, download profile media, extract post comments, manage inboxes, send direct messages safely, upload YouTube Studio drafts, manage contacts, and inspect queue jobs. Use whenever asked to interact with Instagram, Facebook, or YouTube, read social media data, manage leads/contacts, send messages, or diagnose why the socmedia service or extension does not work.
---

# Socmedia CLI Usage

The CLI's `--help` is the source of truth; this skill mirrors and summarizes its operations. Always inspect `socmedia <command> --help` for full parameter options.

## Before Working

1. Verify environment and service health:
   ```bash
   socmedia doctor
   ```
   If any check fails, follow the printed `fix` instruction.
2. Start or inspect the local daemon:
   ```bash
   socmedia service start
   socmedia service status
   ```
   Verify that `running: true`, `pinnedId: "ingpbbhdgldgomideaihffffiinjgifj"`, and `extension.connected: true`.
3. If the extension is not yet loaded:
   ```bash
   socmedia extension install --open
   ```
   Load unpacked directory `~/.socmedia-cli/extension` in `chrome://extensions` with Developer Mode enabled.

## Agent Output Format & Ergonomics

- **Programmatic / Agent Shell**: When invoked without an interactive TTY (pipes, subshells, AI agent runners), `socmedia` automatically defaults to JSON output on `stdout`.
- **Human / Terminal Format**: Force plain text output with `--text` flag or `SOCMEDIA_CLI_FORMAT=text`.
- **Structured Errors**: Any CLI error writes `{ "error": "...", "hint": "...", "code": "..." }` to `stderr` with a nonzero exit code.

## Critical Safety Rails for AI Agents

1. **NEVER autonomously add `--confirm`**:
   - Commands with side effects (`socmedia message send`, `socmedia youtube upload`) feature a strict **Preview Gate**.
   - Running without `--confirm` returns a dry-run preview (`preview: {...}, sent: false`).
   - The agent MUST present this preview to the user and request explicit confirmation. The agent must NEVER pass `--confirm` on its own initiative without direct user instruction.
2. **Handling `HALT` (Security Challenges & Logins)**:
   - When Instagram or Facebook triggers a checkpoint, captcha, or login challenge, the service immediately enters `HALT` state and pauses the queue.
   - Do NOT retry the command or attempt automated workarounds!
   - Alert the user to open Google Chrome, navigate to the affected tab, complete the challenge or login manually, and then run:
     ```bash
     socmedia service resume
     ```
3. **Daily Message Limits & Slot Spacing**:
   - Messages are limited to a daily quota (`SOCMEDIA_MAX_MESSAGES_PER_DAY`, default: 20).
   - Duplicate messages to the same recipient within 7 days are automatically rejected.
   - Safe slot intervals (90s + jitter) are enforced between outgoing messages to prevent account flagging.
4. **YouTube Channel Allowlist**:
   - Write actions on YouTube are restricted to channels explicitly configured with `"write": true` in `~/.socmedia-cli/youtube.json`.

## Typical Scenarios & Commands

### Profiles, Posts, and Search
- **Search profiles/pages/hashtags**:
  ```bash
  socmedia search ig "techcrunch" --type users --limit 10
  socmedia search fb "software" --type pages --limit 10
  ```
- **Inspect profile**:
  ```bash
  socmedia profile get https://www.instagram.com/github/
  ```
  *(Automatically records or updates the user in local SQLite contacts).*
- **List profile posts**:
  ```bash
  socmedia profile posts https://www.instagram.com/github/ --limit 12
  ```
- **Get post details & download media**:
  ```bash
  socmedia post get https://www.instagram.com/p/POST_ID/ --download
  ```
- **Extract post comments** (uses Chrome debugger to expand nested threads):
  ```bash
  socmedia post comments https://www.instagram.com/p/POST_ID/ --limit 50
  ```
- **Full profile download** (orchestrates profile metadata, screenshot, posts, and media):
  ```bash
  socmedia profile download https://www.instagram.com/github/ --limit 10 --max-media 5
  ```

### Browser Automation & Screenshots
- **Take screenshot**:
  ```bash
  socmedia screenshot --url https://www.instagram.com/github/ --target profile
  ```
- **Inspect work page**:
  ```bash
  socmedia page read --max-lines 100
  socmedia page snapshot
  ```
- **Interact with page**:
  ```bash
  socmedia browser click --selector "button[type='submit']"
  socmedia browser scroll --times 3
  ```

### Contacts & Lead Management
- **List and filter contacts**:
  ```bash
  socmedia contacts list --platform ig --status new
  ```
- **Update status and notes**:
  ```bash
  socmedia contacts update ig:github --status replied --note "Interested in enterprise pilot"
  ```
- **Export contacts**:
  ```bash
  socmedia contacts export --format csv --path ~/socmedia-data/leads.csv
  ```
- **Import legacy contacts**:
  ```bash
  socmedia contacts import --from ~/.socmedia-mcp
  ```

### Direct Messaging & Inbox
- **List inbox threads**:
  ```bash
  socmedia inbox list ig --limit 20
  ```
- **Read thread messages**:
  ```bash
  socmedia inbox read --url https://www.instagram.com/direct/t/THREAD_ID/
  ```
- **Send message (Dry-run preview)**:
  ```bash
  socmedia message send --to https://www.instagram.com/direct/t/THREAD_ID/ --text "Hello from Socmedia"
  ```
- **Send message (Confirmed after user approval)**:
  ```bash
  socmedia message send --to https://www.instagram.com/direct/t/THREAD_ID/ --text "Hello from Socmedia" --confirm
  ```

### YouTube Studio
- **Verify allowed channels**:
  ```bash
  socmedia youtube channel
  ```
- **Check Studio session**:
  ```bash
  socmedia youtube studio status --open
  ```
- **Upload video draft (Dry-run preview)**:
  ```bash
  socmedia youtube upload ~/Videos/demo.mp4 --title "Product Demo" --privacy private
  ```

### Queue & Self-Maintenance
- **List, inspect, and cancel jobs**:
  ```bash
  socmedia queue list
  socmedia queue get 12
  socmedia queue cancel 12
  ```
- **Manage work tabs**:
  ```bash
  socmedia tabs list
  socmedia tabs use 12345
  socmedia tabs clear
  ```
- **Configure service port**:
  ```bash
  socmedia config get port
  socmedia config set port 47842
  socmedia config unset port
  ```
- **Diagnostic check**:
  ```bash
  socmedia doctor
  ```
- **Check for or apply updates**:
  ```bash
  socmedia update --check
  socmedia update
  ```
