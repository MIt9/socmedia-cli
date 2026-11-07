import type { Command } from "./types";
import type { CommandMeta } from "../output";
import { printError, printOutput } from "../output";
import { runPageJob, status } from "../lib/client";
import { parseKyivSchedule, tiktokProfileUrl, tiktokVideoUrl, validateMediaFile } from "../lib/validate";

// Help data: feeds --help, --help --json, and the tests/command-table.test.ts completeness checks.
export const meta: CommandMeta = {
  name: "tiktok",
  usage: "socmedia tiktok <profile|posts|video|comments|search|inbox|upload|studio|privacy> [options]",
  summary: "Interact with TikTok profiles, videos, comments, and uploads",
  commands: [
    { name: "profile URL", summary: "Read TikTok user profile" },
    { name: "posts URL", summary: "List TikTok videos from a user profile" },
    { name: "video URL", summary: "Get video details and optionally download" },
    { name: "comments URL", summary: "Read comments on a TikTok video" },
    { name: "search QUERY", summary: "Search TikTok users or videos" },
    { name: "inbox list", summary: "List recent inbox messages (read-only)" },
    { name: "upload FILE", summary: "Upload video to TikTok Studio with caption and privacy" },
    { name: "studio list", summary: "List TikTok videos from Studio content management with privacy and review status" },
    { name: "privacy VIDEO --set PRIV", summary: "Change privacy of an existing TikTok video (public, friends, private)" },
  ],
  options: [
    { flag: "--limit NUM", description: "Limit results: posts 1-100 (default: 12), comments 1-500 (default: 20), search 1-50 (default: 20), inbox 1-100 (default: 20), studio 1-500 (default: 50)" },
    { flag: "--download", description: "Download video and save to ~/socmedia-data/tiktok/" },
    { flag: "--type TYPE", description: "Search type: users or videos (default: users)" },
    { flag: "--caption TEXT", description: "Caption for uploaded video (max 2200 characters)" },
    { flag: "--privacy PRIV", description: "Upload privacy: public, friends, or private (default: private; public when --schedule is used)" },
    { flag: "--schedule WHEN", description: 'Upload: publish later through TikTok Studio\'s own scheduler, "YYYY-MM-DD HH:MM" in Europe/Kyiv local time, 20 minutes to 10 days ahead; requires public privacy' },
    { flag: "--set PRIV", description: "Target privacy: public, friends, or private" },
    { flag: "--confirm", description: "Confirm write action; without this flag, returns preview" },
    { flag: "--json", description: "Print the result as JSON" },
    { flag: "--text", description: "Print the result as plain text" },
    { flag: "--help", description: "Show this help message" },
  ],
};

async function run(argv: string[]): Promise<void> {
  const sub = argv[3];
  try {
    if (sub === "profile") {
      const url = argv[4];
      if (!url || url.startsWith("--")) throw new Error("Usage: socmedia tiktok profile URL [options]");
      const res = await runPageJob("tiktokProfile", { url: tiktokProfileUrl(url) });
      printOutput(res);
    } else if (sub === "posts") {
      const url = argv[4];
      if (!url || url.startsWith("--")) throw new Error("Usage: socmedia tiktok posts URL [options]");
      let limit = 12;
      for (let i = 5; i < argv.length; i++) {
        if (argv[i] === "--json" || argv[i] === "--text") continue;
        if (argv[i] === "--limit") {
          limit = parseInt(argv[++i], 10);
        } else throw new Error(`Unknown tiktok posts option: ${argv[i]}`);
      }
      const res = await runPageJob("tiktokPosts", { url: tiktokProfileUrl(url), limit });
      printOutput(res);
    } else if (sub === "video") {
      const url = argv[4];
      if (!url || url.startsWith("--")) throw new Error("Usage: socmedia tiktok video URL [options]");
      let download = false;
      for (let i = 5; i < argv.length; i++) {
        if (argv[i] === "--json" || argv[i] === "--text") continue;
        if (argv[i] === "--download") download = true;
        else throw new Error(`Unknown tiktok video option: ${argv[i]}`);
      }
      const parsed = tiktokVideoUrl(url);
      const res = await runPageJob("tiktokVideo", { url: parsed.url, download });
      printOutput(res);
    } else if (sub === "comments") {
      const url = argv[4];
      if (!url || url.startsWith("--")) throw new Error("Usage: socmedia tiktok comments URL [options]");
      let limit = 20;
      for (let i = 5; i < argv.length; i++) {
        if (argv[i] === "--json" || argv[i] === "--text") continue;
        if (argv[i] === "--limit") {
          limit = parseInt(argv[++i], 10);
        } else throw new Error(`Unknown tiktok comments option: ${argv[i]}`);
      }
      const parsed = tiktokVideoUrl(url);
      const res = await runPageJob("tiktokComments", { url: parsed.url, limit });
      printOutput(res);
    } else if (sub === "search") {
      const query = argv[4];
      if (!query || query.startsWith("--")) throw new Error("Usage: socmedia tiktok search QUERY [options]");
      let type: "users" | "videos" = "users";
      let limit = 20;
      for (let i = 5; i < argv.length; i++) {
        if (argv[i] === "--json" || argv[i] === "--text") continue;
        if (argv[i] === "--type") {
          const t = argv[++i];
          if (t !== "users" && t !== "videos") throw new Error("Search type must be users or videos");
          type = t;
        } else if (argv[i] === "--limit") {
          limit = parseInt(argv[++i], 10);
        } else throw new Error(`Unknown tiktok search option: ${argv[i]}`);
      }
      const res = await runPageJob("tiktokSearch", { query, type, limit });
      printOutput(res);
    } else if (sub === "inbox") {
      if (argv[4] !== "list") throw new Error("Usage: socmedia tiktok inbox list [options]");
      let limit = 20;
      for (let i = 5; i < argv.length; i++) {
        if (argv[i] === "--json" || argv[i] === "--text") continue;
        if (argv[i] === "--limit") {
          limit = parseInt(argv[++i], 10);
        } else throw new Error(`Unknown tiktok inbox option: ${argv[i]}`);
      }
      const res = await runPageJob("tiktokInbox", { limit });
      printOutput(res);
    } else if (sub === "upload") {
      const file = argv[4];
      if (!file || file.startsWith("--")) throw new Error("Usage: socmedia tiktok upload FILE [options]");
      let caption = "";
      let privacy: "public" | "friends" | "private" | undefined;
      let schedule: string | undefined;
      let confirm = false;
      for (let i = 5; i < argv.length; i++) {
        if (argv[i] === "--json" || argv[i] === "--text") continue;
        if (argv[i] === "--schedule") {
          schedule = argv[++i] ?? "";
        } else if (argv[i] === "--caption") {
          caption = argv[++i] ?? "";
          if (caption.length > 2200) throw new Error("Caption must be at most 2200 characters");
        } else if (argv[i] === "--privacy") {
          const p = argv[++i];
          if (p !== "public" && p !== "friends" && p !== "private") {
            throw new Error("--privacy must be public, friends or private");
          }
          privacy = p;
        } else if (argv[i] === "--confirm") {
          confirm = true;
        } else throw new Error(`Unknown tiktok upload option: ${argv[i]}`);
      }

      if (schedule !== undefined) {
        parseKyivSchedule(schedule);
        if (privacy === undefined) privacy = "public";
        else if (privacy !== "public") throw new Error("A scheduled upload must be public: drop --privacy or use --privacy public");
      }
      privacy = privacy ?? "private";

      const media = validateMediaFile(file, ["mp4", "mov", "webm"]);
      if (!confirm) {
        printOutput({
          platform: "tt",
          uploaded: false,
          preview: {
            file: media.path,
            caption,
            privacy,
            size: media.size,
            ...(schedule ? { schedule, timezone: "Europe/Kyiv" } : {}),
          },
          note: "Nothing uploaded. Pass --confirm to execute upload.",
        });
      } else {
        const res = await runPageJob("tiktokUpload", {
          file: media.path,
          caption,
          privacy,
          sha256: media.sha256,
          ...(schedule ? { schedule } : {}),
        });
        printOutput(res);
      }
    } else if (sub === "studio") {
      if (argv[4] !== "list") throw new Error("Usage: socmedia tiktok studio list [options]");
      let limit = 50;
      for (let i = 5; i < argv.length; i++) {
        if (argv[i] === "--json" || argv[i] === "--text") continue;
        if (argv[i] === "--limit") {
          limit = parseInt(argv[++i], 10);
          if (isNaN(limit) || limit < 1 || limit > 500) throw new Error("Limit must be an integer from 1 to 500");
        } else throw new Error(`Unknown tiktok studio option: ${argv[i]}`);
      }
      const res = await runPageJob("tiktokStudioList", { limit });
      printOutput(res);
    } else if (sub === "privacy") {
      const videoId = argv[4];
      if (!videoId || videoId.startsWith("--") || !/^\d{10,30}$/.test(videoId)) {
        throw new Error("Usage: socmedia tiktok privacy VIDEO --set public|friends|private [--confirm] [options]");
      }
      let setPrivacy: "public" | "friends" | "private" | undefined;
      let confirm = false;
      for (let i = 5; i < argv.length; i++) {
        if (argv[i] === "--json" || argv[i] === "--text") continue;
        if (argv[i] === "--set") {
          const p = argv[++i];
          if (p !== "public" && p !== "friends" && p !== "private") {
            throw new Error("--set must be public, friends or private");
          }
          setPrivacy = p;
        } else if (argv[i] === "--confirm") {
          confirm = true;
        } else throw new Error(`Unknown tiktok privacy option: ${argv[i]}`);
      }
      if (!setPrivacy) throw new Error("--set is required (public, friends, or private)");
      if (!confirm) {
        printOutput({
          platform: "tt",
          changed: false,
          preview: {
            videoId,
            privacy: setPrivacy,
          },
          note: "Nothing changed. Pass --confirm to execute privacy update.",
        });
      } else {
        const res = await runPageJob("tiktokSetPrivacy", { videoId, privacy: setPrivacy });
        printOutput(res);
      }
    } else {
      throw new Error(`Unknown tiktok command: ${sub ?? ""}`);
    }
  } catch (error) {
    printError(error);
  }
}

const command: Command = { ...meta, run };
export default command;
