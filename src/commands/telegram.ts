import type { Command } from "./types";
import type { CommandMeta } from "../output";
import { printError, printOutput } from "../output";
import { runPageJob } from "../lib/client";
import { telegramChat, validateMediaFile } from "../lib/validate";
import { resolveHomePath } from "../media";

// Help data: feeds --help, --help --json, and the tests/command-table.test.ts completeness checks.
export const meta: CommandMeta = {
  name: "telegram",
  usage: "socmedia telegram <status|dialogs|messages|message|media|channel> [options]",
  summary: "Interact with Telegram Web K dialogs, messages, media, and channels",
  commands: [
    { name: "status", summary: "Show Telegram login state and account name" },
    { name: "dialogs list", summary: "List dialogs from Telegram Web K" },
    { name: "messages read CHAT", summary: "Read messages from a chat" },
    { name: "message send CHAT", summary: "Send text message to a chat" },
    { name: "media download CHAT", summary: "Download photos and videos from a chat" },
    { name: "media send CHAT FILE", summary: "Send photo or video to a chat" },
    { name: "channel create", summary: "Create a new private channel" },
  ],
  options: [
    { flag: "--limit NUM", description: "Limit results: dialogs 1-100 (default: 20), messages 1-100 (default: 30), media download 1-50 (default: 10)" },
    { flag: "--types TYPES", description: "Comma-separated media types to download: photo,video (default: photo,video)" },
    { flag: "--dir DIR", description: "Directory to save downloaded media" },
    { flag: "--text TEXT", description: "Message text (max 4096 characters)" },
    { flag: "--caption TEXT", description: "Caption for media sent to chat (max 4096 characters)" },
    { flag: "--title TEXT", description: "Channel title (1-128 characters)" },
    { flag: "--description DESC", description: "Channel description (max 255 characters)" },
    { flag: "--confirm", description: "Confirm write action; without this flag, returns preview" },
    { flag: "--json", description: "Print the result as JSON" },
    { flag: "--text", description: "Print the result as plain text" },
    { flag: "--help", description: "Show this help message" },
  ],
};

async function run(argv: string[]): Promise<void> {
  const sub = argv[3];
  try {
    if (sub === "status") {
      const res = await runPageJob("tgStatus", {});
      printOutput(res);
    } else if (sub === "dialogs") {
      if (argv[4] !== "list") throw new Error("Usage: socmedia telegram dialogs list [options]");
      let limit = 20;
      for (let i = 5; i < argv.length; i++) {
        if (argv[i] === "--json" || argv[i] === "--text") continue;
        if (argv[i] === "--limit") limit = parseInt(argv[++i], 10);
        else throw new Error(`Unknown telegram dialogs option: ${argv[i]}`);
      }
      const res = await runPageJob("tgDialogsList", { limit });
      printOutput(res);
    } else if (sub === "messages") {
      if (argv[4] !== "read") throw new Error("Usage: socmedia telegram messages read CHAT [options]");
      const chatRaw = argv[5];
      if (!chatRaw || chatRaw.startsWith("--")) throw new Error("Usage: socmedia telegram messages read CHAT [options]");
      const chat = telegramChat(chatRaw);
      let limit = 30;
      for (let i = 6; i < argv.length; i++) {
        if (argv[i] === "--json" || argv[i] === "--text") continue;
        if (argv[i] === "--limit") limit = parseInt(argv[++i], 10);
        else throw new Error(`Unknown telegram messages option: ${argv[i]}`);
      }
      const res = await runPageJob("tgMessagesRead", { chat, limit });
      printOutput(res);
    } else if (sub === "message") {
      if (argv[4] !== "send") throw new Error("Usage: socmedia telegram message send CHAT --text TEXT [options]");
      const chatRaw = argv[5];
      if (!chatRaw || chatRaw.startsWith("--")) throw new Error("Usage: socmedia telegram message send CHAT --text TEXT [options]");
      const chat = telegramChat(chatRaw);
      let text = "";
      let confirm = false;
      for (let i = 6; i < argv.length; i++) {
        if (argv[i] === "--json") continue;
        if (argv[i] === "--text") {
          text = argv[++i] ?? "";
        } else if (argv[i] === "--confirm") {
          confirm = true;
        } else throw new Error(`Unknown telegram message send option: ${argv[i]}`);
      }
      if (!text.trim()) throw new Error("Message text is empty");
      if (text.length > 4096) throw new Error(`Message is too long (${text.length} > 4096 characters)`);

      if (!confirm) {
        printOutput({
          platform: "tg",
          sent: false,
          preview: { chat, text },
          note: "Nothing sent. Pass --confirm to send message.",
        });
      } else {
        const res = await runPageJob("tgSendMessage", { chat, text });
        printOutput(res);
      }
    } else if (sub === "media") {
      const action = argv[4];
      if (action === "download") {
        const chatRaw = argv[5];
        if (!chatRaw || chatRaw.startsWith("--")) throw new Error("Usage: socmedia telegram media download CHAT [options]");
        const chat = telegramChat(chatRaw);
        let limit = 10;
        let types: string[] = ["photo", "video"];
        let dir: string | undefined;
        for (let i = 6; i < argv.length; i++) {
          if (argv[i] === "--json" || argv[i] === "--text") continue;
          if (argv[i] === "--limit") {
            limit = parseInt(argv[++i], 10);
          } else if (argv[i] === "--types") {
            types = (argv[++i] ?? "").split(",").map((t) => t.trim()).filter(Boolean);
          } else if (argv[i] === "--dir") {
            dir = resolveHomePath(argv[++i]);
          } else throw new Error(`Unknown telegram media download option: ${argv[i]}`);
        }
        const res = await runPageJob("tgMediaDownload", { chat, limit, types, dir });
        printOutput(res);
      } else if (action === "send") {
        const chatRaw = argv[5];
        const fileRaw = argv[6];
        if (!chatRaw || chatRaw.startsWith("--") || !fileRaw || fileRaw.startsWith("--")) {
          throw new Error("Usage: socmedia telegram media send CHAT FILE [options]");
        }
        const chat = telegramChat(chatRaw);
        let caption = "";
        let confirm = false;
        for (let i = 7; i < argv.length; i++) {
          if (argv[i] === "--json" || argv[i] === "--text") continue;
          if (argv[i] === "--caption") {
            caption = argv[++i] ?? "";
            if (caption.length > 4096) throw new Error("Caption must be at most 4096 characters");
          } else if (argv[i] === "--confirm") {
            confirm = true;
          } else throw new Error(`Unknown telegram media send option: ${argv[i]}`);
        }
        const media = validateMediaFile(fileRaw, ["mp4", "mov", "webm", "jpg", "png", "webp"]);
        if (!confirm) {
          printOutput({
            platform: "tg",
            sent: false,
            preview: { chat, file: media.path, caption, size: media.size },
            note: "Nothing sent. Pass --confirm to send media.",
          });
        } else {
          const res = await runPageJob("tgSendMedia", { chat, file: media.path, caption });
          printOutput(res);
        }
      } else {
        throw new Error(`Unknown telegram media action: ${action ?? ""}`);
      }
    } else if (sub === "channel") {
      if (argv[4] !== "create") throw new Error("Usage: socmedia telegram channel create --title TEXT [options]");
      let title = "";
      let description = "";
      let confirm = false;
      for (let i = 5; i < argv.length; i++) {
        if (argv[i] === "--json" || argv[i] === "--text") continue;
        if (argv[i] === "--title") {
          title = argv[++i] ?? "";
        } else if (argv[i] === "--description") {
          description = argv[++i] ?? "";
        } else if (argv[i] === "--confirm") {
          confirm = true;
        } else throw new Error(`Unknown telegram channel create option: ${argv[i]}`);
      }
      if (!title.trim() || title.length > 128) throw new Error("Channel title must be between 1 and 128 characters");
      if (description.length > 255) throw new Error("Channel description must be at most 255 characters");

      if (!confirm) {
        printOutput({
          platform: "tg",
          created: false,
          preview: { title, description: description || null, privacy: "private" },
          note: "Nothing created. Pass --confirm to create channel.",
        });
      } else {
        const res = await runPageJob("tgCreateChannel", { title, description });
        printOutput(res);
      }
    } else {
      throw new Error(`Unknown telegram command: ${sub ?? ""}`);
    }
  } catch (error) {
    printError(error);
  }
}

const command: Command = { ...meta, run };
export default command;
