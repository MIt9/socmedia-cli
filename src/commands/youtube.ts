import type { Command } from "./types";
import type { CommandMeta } from "../output";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { printError } from "../output";
import { resolveHomePath } from "../media";
import { runPageJob } from "../lib/client";
import { readYoutubeConfig, resolveChannel, studioUrl } from "../lib/config";
import { CliError } from "../lib/state";

// Help data (feeds --help, --help --json, skill parity and COMMANDS.md tests).
export const meta: CommandMeta = {
  name: "youtube",
  usage: "socmedia youtube <channel|studio status|upload|video update> [options]",
  summary: "Manage YouTube Studio and channels",
  commands: [
    { name: "channel", summary: "Inspect the configured YouTube channel allowlist" },
    { name: "studio status", summary: "Read YouTube Studio tab state and verify against allowlist" },
    { name: "upload FILE", summary: "Upload video to YouTube Studio (draft private video)" },
    { name: "video update ID", summary: "Update video metadata (title, description, privacy)" },
  ],
  options: [
    { flag: "--channel KEY", description: "Channel key from youtube.json allowlist" },
    { flag: "--open", description: "With studio status, navigate to Studio URL" },
    { flag: "--title TEXT", description: "Video title" },
    { flag: "--description TXT", description: "Video description" },
    { flag: "--privacy PRIV", description: "Video privacy: private, unlisted, public" },
    { flag: "--confirm", description: "Confirm write action; without this flag, returns preview" },
    { flag: "--json", description: "Print the result as JSON" },
    { flag: "--text", description: "Print the result as plain text" },
    { flag: "--help", description: "Show this help message" },
  ],
};

// argv is the full process argv (same shape as Bun.argv: [exe, script, command, ...]).
async function run(argv: string[]): Promise<void> {
  if (argv[3] === "channel") {
    try {
      let channelKey: string | undefined;
      for (let i = 4; i < argv.length; i++) {
        const option = argv[i];
        if (option === "--json") continue;
        if (option === "--channel") {
          channelKey = argv[++i];
          if (!channelKey) throw new Error("Missing value for --channel");
        } else throw new Error(`Unknown youtube channel option: ${option}`);
      }
      const cfg = readYoutubeConfig();
      const ch = resolveChannel(cfg, channelKey);
      console.log(JSON.stringify({ channel: ch }));
    } catch (error) { printError(error); }
  } else if (argv[3] === "studio" && argv[4] === "status") {
    try {
      let channelKey: string | undefined;
      let open = false;
      for (let i = 5; i < argv.length; i++) {
        const option = argv[i];
        if (option === "--json") continue;
        if (option === "--channel") {
          channelKey = argv[++i];
          if (!channelKey) throw new Error("Missing value for --channel");
        } else if (option === "--open") {
          open = true;
        } else throw new Error(`Unknown youtube studio option: ${option}`);
      }
      const cfg = readYoutubeConfig();
      const ch = resolveChannel(cfg, channelKey);
      const expected = { id: ch.id, label: ch.label, handle: ch.handle };
      const sUrl = studioUrl(ch.id);
      const res = await runPageJob("ytStudioRead", { expected, studioUrl: sUrl, open }) as any;
      const probe = res?.probe || {};
      const matched = probe.studioChannelId === ch.id;
      console.log(JSON.stringify({
        channel: { ...ch, matched },
        tab: { url: res?.url ?? null, title: res?.title ?? null, section: res?.section ?? null },
        account: probe.account ?? null,
      }));
    } catch (error) { printError(error); }
  } else if (argv[3] === "upload") {
    try {
      const file = argv[4];
      if (!file || file.startsWith("--")) throw new Error("Usage: socmedia youtube upload FILE [options]");
      const absFile = resolveHomePath(file);
      if (!existsSync(absFile)) throw new Error(`File not found: ${absFile}`);
      let channelKey: string | undefined;
      let title: string | undefined;
      let description: string | undefined;
      let privacy: string | undefined;
      let confirm = false;
      for (let i = 5; i < argv.length; i++) {
        const option = argv[i];
        if (option === "--json") continue;
        if (option === "--channel") {
          channelKey = argv[++i];
          if (!channelKey) throw new Error("Missing value for --channel");
        } else if (option === "--title") {
          title = argv[++i];
          if (!title) throw new Error("Missing value for --title");
        } else if (option === "--description") {
          description = argv[++i];
        } else if (option === "--privacy") {
          privacy = argv[++i];
          if (!privacy || !["private", "unlisted", "public"].includes(privacy)) throw new Error("--privacy must be private, unlisted or public");
        } else if (option === "--confirm") {
          confirm = true;
        } else throw new Error(`Unknown youtube upload option: ${option}`);
      }
      const cfg = readYoutubeConfig();
      const ch = resolveChannel(cfg, channelKey);
      if (!ch.write) throw new Error(`Channel "${ch.key}" (${ch.id}) is read-only (write: false in youtube.json)`);
      if (!confirm) {
        console.log(JSON.stringify({
          channel: ch,
          uploaded: false,
          preview: {
            file: absFile,
            title: title || basename(absFile),
            description: description || null,
            privacy: privacy || "private",
            studioUrl: studioUrl(ch.id),
          },
          note: "Nothing uploaded. Pass --confirm to execute upload.",
        }));
      } else {
        throw new CliError("YouTube upload is not implemented", undefined, "NOT_IMPLEMENTED", { uploaded: false });
      }
    } catch (error) { printError(error); }
  }
}

const command: Command = { ...meta, run };
export default command;
