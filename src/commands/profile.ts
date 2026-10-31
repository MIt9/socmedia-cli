import type { Command } from "./types";
import type { CommandMeta } from "../output";
import { printError } from "../output";
import { resolveHomePath, downloadProfile, profileUrl } from "../media";
import { queueRequest, runPageJob } from "../lib/client";
import { validateJob } from "../lib/validate";

// Help data (feeds --help, --help --json, skill parity and COMMANDS.md tests).
export const meta: CommandMeta = {
  name: "profile",
  usage: "socmedia profile <get|posts|download> <url> [options]",
  summary: "Read a social profile",
  commands: [
    { name: "get <url>", summary: "Read an Instagram or Facebook profile/page via its HTTPS URL" },
    { name: "posts <url>", summary: "List posts from an Instagram or Facebook profile/page" },
    { name: "download <url>", summary: "Collect profile, screenshot, posts and media into ~/socmedia-data" },
  ],
  options: [
    { flag: "--limit N", description: "With posts or download, maximum posts from 1 to 100 (default: 12)" },
    { flag: "--details", description: "With download, fetch details of each post (default: true)" },
    { flag: "--no-details", description: "Skip post detail fetch" },
    { flag: "--max-media N", description: "With download, maximum media files from 0 to 300 (default: 50)" },
    { flag: "--dir PATH", description: "With download, custom destination inside home" },
    { flag: "--background", description: "With download, run in background via service queue" },
    { flag: "--json", description: "Print the result as JSON" },
    { flag: "--text", description: "Print the result as plain text" },
    { flag: "--help", description: "Show this help message" },
  ],
};

// argv is the full process argv (same shape as Bun.argv: [exe, script, command, ...]).
async function run(argv: string[]): Promise<void> {
  if (argv[3] === "get") {
    try {
      if (argv.slice(5).some((option) => option !== "--json")) throw new Error("Unknown profile option");
      const url = profileUrl(argv[4]);
      console.log(JSON.stringify(await runPageJob("getProfile", { url })));
    } catch (error) { printError(error); }
  } else if (argv[3] === "posts") {
    try {
      const url = profileUrl(argv[4]);
      const args: { url: string; limit?: number } = { url, limit: 12 };
      for (let i = 5; i < argv.length; i++) {
        const option = argv[i];
        if (option === "--json") continue;
        if (option !== "--limit") throw new Error(`Unknown profile option: ${option}`);
        const value = argv[++i];
        if (!value || !/^[1-9]\d*$/.test(value) || Number(value) > 100) throw new Error("--limit must be an integer from 1 to 100");
        args.limit = Number(value);
      }
      console.log(JSON.stringify(await runPageJob("getPosts", args)));
    } catch (error) { printError(error); }
  } else if (argv[3] === "download") {
    try {
      const url = profileUrl(argv[4]);
      const args: { url: string; limit?: number; details?: boolean; maxMedia?: number; dir?: string } = { url, limit: 12, details: true, maxMedia: 50 };
      let background = false;
      for (let i = 5; i < argv.length; i++) {
        const option = argv[i];
        if (option === "--json") continue;
        if (option === "--background") {
          background = true;
        } else if (option === "--details") {
          args.details = true;
        } else if (option === "--no-details") {
          args.details = false;
        } else if (option === "--limit") {
          const val = argv[++i];
          if (!val || !/^[1-9]\d*$/.test(val) || Number(val) > 100) throw new Error("--limit must be an integer from 1 to 100");
          args.limit = Number(val);
        } else if (option === "--max-media") {
          const val = argv[++i];
          if (!val || !/^(0|[1-9]\d*)$/.test(val) || Number(val) > 300) throw new Error("--max-media must be an integer from 0 to 300");
          args.maxMedia = Number(val);
        } else if (option === "--dir") {
          const val = argv[++i];
          if (!val) throw new Error("Missing value for --dir");
          resolveHomePath(val);
          args.dir = val;
        } else throw new Error(`Unknown profile option: ${option}`);
      }
      if (background) {
        const job = validateJob({ action: "downloadProfile", args });
        const queued = await queueRequest(`queue enqueue ${JSON.stringify(job)}`) as { id: number };
        console.log(JSON.stringify({ queued: true, id: queued.id }));
      } else {
        console.log(JSON.stringify(await downloadProfile(args, (act, a) => runPageJob(act, a))));
      }
    } catch (error) { printError(error); }
  }
}

const command: Command = { ...meta, run };
export default command;
