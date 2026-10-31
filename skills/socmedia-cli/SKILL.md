---
name: socmedia-cli
description: Social media automation CLI for Instagram, Facebook, and YouTube Studio via background daemon, SQLite queue, and Chrome MV3 extension.
---

# Socmedia CLI Skill

`socmedia` is a command-line interface for interacting with social media platforms (Instagram, Facebook, YouTube Studio) through a background daemon paired with an unpacked Google Chrome extension.

## Architecture

- **Daemon**: Runs locally over unix socket `~/.socmedia-cli/service.sock` and HTTP/WebSocket server on port 47842 (or random via env `SOCMEDIA_EXTENSION_PORT=0`).
- **SQLite Queue**: Manages state, jobs, contacts, and message logs at `~/.socmedia-cli/state.sqlite`.
- **Chrome Extension**: Unpacked MV3 extension controlling dedicated social media tabs in the "Socmedia CLI" tab group.
- **Safety Rails**:
  - `HALT` guard: Automatically pauses the queue if a security challenge, captcha, or login redirect is detected.
  - Preview gate: Destructive or sending actions require explicit `--confirm`; without it, dry-run previews are returned.
  - Daily sending caps and 7-day duplicate message protection.
  - YouTube allowlist in `~/.socmedia-cli/youtube.json`.

## Common Commands

### Service & Pairing
```bash
socmedia service start [--json]
socmedia service status [--json]
socmedia service resume [--json]
socmedia extension pair [--id <CHROME_EXTENSION_ID>] [--json]
socmedia extension install [--json]
```

### Profiles & Posts
```bash
socmedia profile get <URL> [--json]
socmedia profile posts <URL> [--limit N] [--json]
socmedia profile download <URL> [--limit N] [--max-media N] [--dir PATH] [--background] [--json]
socmedia post get <URL> [--download] [--json]
socmedia post comments <URL> [--limit N] [--json]
socmedia search <ig|fb> <query> [--type users|hashtag|pages|places] [--limit N] [--json]
```

### Inbox & Direct Messaging
```bash
socmedia inbox list <ig|fb> [--limit N] [--json]
socmedia inbox read [--url URL | --to PROFILE] [--limit N] [--json]
socmedia message send --to URL --text TEXT [--confirm] [--json]
```

### YouTube Studio
```bash
socmedia youtube channel [--channel KEY] [--json]
socmedia youtube studio status [--channel KEY] [--open] [--json]
socmedia youtube upload <FILE> [--title TEXT] [--description TEXT] [--privacy private|unlisted|public] [--confirm] [--json]
```

### Contacts & Queue
```bash
socmedia contacts list [--status STATUS] [--platform ig|fb] [--json]
socmedia contacts update <ID> [--status STATUS] [--note NOTE] [--json]
socmedia contacts export [--status STATUS] [--platform ig|fb] [--format csv|json|jsonl] [--path PATH] [--json]
socmedia queue list [--json]
socmedia queue get <ID> [--json]
socmedia queue cancel <ID> [--json]
```
