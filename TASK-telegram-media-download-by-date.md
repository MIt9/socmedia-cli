# Task: `socmedia telegram media download` — date filter, scrolling, Saved Messages, dedupe

You are working in `/Users/d.bilukcha/work/socmedia-cli` (Bun + TypeScript CLI, local service, Chrome extension). Version seen live: v0.20.2.

Read first: `CONTRIBUTING.md`, `COMMANDS.md`, `skills/socmedia-cli-usage/SKILL.md`, `src/commands/telegram.ts`, `telegramChat` in `src/lib/validate.ts`, and the `tg*` functions in `extension/background.js` (media download, messages read, dialogs list).

## Goal

The owner asked an agent: "download all images from Saved Messages for today into a folder". The CLI cannot do this reliably. Seen live on 2026-11-04, Telegram Web K, logged in as the owner.

## Defects seen live

1. **No date filter.** `media download` has only `--limit` and `--types`. There is no `--since` / `--until` / `--today`, so "today only" is impossible without guessing.
2. **Results carry no metadata.** `saved` returns only `{path,type}` with names `media_1.jpg` … `media_8.jpg`. No message id, no timestamp, no sender, no original filename, no caption. The agent cannot map a file to a message or a date.
3. **Only the loaded viewport is read.** `messages read 404364294 --limit 50` returned 8 messages (2 photos). `media download --limit 50` then saved 8 photos, so the two commands disagree on what counts as media. The chat is virtualised; the command never scrolls up to load older history, so `--limit 50` silently returns fewer items. It should scroll until the limit or the date boundary is reached, and say when it stopped early.
4. **Duplicates.** `media_1.jpg` and `media_2.jpg` are byte-identical (109694 bytes). Likely the same bubble matched twice (thumbnail + full, or album). Dedupe by message id.
5. **Timestamps are not parsed.** `messages read` returns `"time":"5.8K\n\nOct 29, 20:07\n"` (the view counter is mixed into the time) and `"time":"\n14:12"` for today's messages (no date at all). Return an ISO timestamp (`date` from the bubble's `data-timestamp` or the date separator), plus `messageId`.
6. **Saved Messages is not addressable by name.** `dialogs list --limit 10` returned `{"dialogs":[]}` although the account has dialogs (same as defect 1 in `TASK-telegram-live-fixes.md`, still reproducible in v0.20.2). Saved Messages worked only by passing the own account id (`404364294`, from `telegram status`) as CHAT. Accept `me` / `saved` as an alias for the own account id.
7. **Existing files are overwritten silently** when the target dir already has `media_N.jpg`. Re-running a download over a previous batch would replace files with different content. Use a stable name (`<peerId>_<messageId>.<ext>`) and skip files that already exist.

8. **Albums (grouped media) are collapsed into one item.** Reported by the owner: the latest Saved Messages entry is one message with several photos attached (an album). `messages read` returns a single `media: "photo"` item for it, and `media download` saves only the first photo of the group. In Telegram Web K an album is one `.bubble.is-album` containing several `.album-item` children (each with its own `data-mid`), so a per-`.bubble` scan sees one photo. Probably also the cause of defect 4 (the same item picked up twice). Expand every album into its items: one entry per `.album-item` with its own message id, and a shared `groupId` / `albumSize` field.

9. **Video download fails.** `socmedia telegram media download 404364294 --limit 10 --types video --dir ./out` on a chat holding a 0:13 forwarded video returned `{"attempted":2,"saved":[],"skipped":[{"type":"video","reason":"Invalid or unsupported media format"},{"type":"video","reason":"Invalid or unsupported media format"}]}` — nothing saved. Two items were attempted for one video (see defects 4 and 8). Suspected cause, not verified: Telegram Web K serves video as range/stream requests through its service worker, so the `src` the extension reads is not a complete file, and the format check rejects it. Check what the `<video>` `src` is (blob / `stream/...` URL) and either fetch it with `Range` requests until the full size is known, or open the media viewer and use its download action. Photos work, so the bug is video-specific.

## What to build

- `--since <date|datetime>` and `--until <date|datetime>`, plus `--today`. Local timezone, same as other date inputs in the CLI (Europe/Kyiv is used for TikTok scheduling).
- Scroll the message list up until `--limit` media items are collected or the date boundary is passed. Report `{scrolledToTop, stoppedBy: "limit"|"date"|"start"}`.
- Return per item: `{path, type, messageId, date, caption, sizeBytes, sha256}`.
- Expand albums: `messages read` returns one item per photo/video of an album (`groupId`, `albumSize`, `albumIndex`); `media download` saves all of them. Acceptance: an album of N photos yields N files.
- Dedupe by message id; if two items have the same sha256 keep one and list the other under `skipped` with reason `duplicate`.
- Name files `<peerId>_<messageId>.<ext>`; skip existing files with reason `exists`.
- `CHAT` accepts `me` / `saved`.
- Fix `messages read`: separate `views` from `time`, add `messageId` and ISO `date`.
- Make `--types video` work: a 0:13 video from a forwarded post must save as a playable `.mp4`; if it cannot be fetched, return a specific reason instead of `Invalid or unsupported media format`.
- Update `COMMANDS.md`, `skills/socmedia-cli-usage/SKILL.md`, and add tests next to the existing telegram ones.

## Acceptance

- `socmedia telegram media download me --today --types photo --dir ./out --json` saves exactly today's photos, once each, with message ids and ISO dates in the output, and nothing from earlier days.
- Running it twice does not rewrite files and reports them as `exists`.
- With 60 photos in the chat and `--limit 50`, it returns 50 (scrolls), not the 8 in the viewport.
- Read-only: no `--confirm` needed, no message is sent, nothing in the composer is touched.

## Out of scope

Sending, pinning, channel creation, other platforms.
