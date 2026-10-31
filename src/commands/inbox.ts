import type { Command } from "./types";
import type { CommandMeta } from "../output";
import { printError } from "../output";
import { runPageJob } from "../lib/client";

// Help data (feeds --help, --help --json, skill parity and COMMANDS.md tests).
export const meta: CommandMeta = {
  name: "inbox",
  usage: "socmedia inbox <list|read> [options]",
  summary: "List and read inbox threads",
  commands: [
    { name: "list <platform>", summary: "List conversation threads from Instagram or Facebook" },
    { name: "read", summary: "Read messages from a thread by URL or recipient profile" },
  ],
  options: [
    { flag: "--url URL", description: "Thread URL on Instagram or Facebook" },
    { flag: "--to PROFILE", description: "Recipient profile URL to open thread" },
    { flag: "--limit N", description: "Maximum threads or messages to fetch (default: 20 for list, 30 for read)" },
    { flag: "--json", description: "Print the result as JSON" },
    { flag: "--text", description: "Print the result as plain text" },
    { flag: "--help", description: "Show this help message" },
  ],
};

// argv is the full process argv (same shape as Bun.argv: [exe, script, command, ...]).
async function run(argv: string[]): Promise<void> {
  if (argv[3] === "list") {
    try {
      const platform = argv[4];
      if (!platform || platform.startsWith("--")) throw new Error("Usage: socmedia inbox list <platform> [--limit N] [--json]");
      const norm = { ig: "ig", instagram: "ig", fb: "fb", facebook: "fb" }[platform.toLowerCase()];
      if (!norm) throw new Error("Platform must be ig or fb");
      const args: { platform: string; limit?: number } = { platform: norm, limit: 20 };
      for (let i = 5; i < argv.length; i++) {
        const option = argv[i];
        if (option === "--json") continue;
        if (option === "--limit") {
          const val = argv[++i];
          if (!val || !/^[1-9]\d*$/.test(val) || Number(val) > 100) throw new Error("--limit must be an integer from 1 to 100");
          args.limit = Number(val);
        } else throw new Error(`Unknown inbox option: ${option}`);
      }
      console.log(JSON.stringify(await runPageJob("readInbox", args)));
    } catch (error) { printError(error); }
  } else if (argv[3] === "read") {
    try {
      const args: { url?: string; to?: string; limit?: number } = { limit: 30 };
      for (let i = 4; i < argv.length; i++) {
        const option = argv[i];
        if (option === "--json") continue;
        if (option === "--url") {
          const val = argv[++i];
          if (!val) throw new Error("Missing value for --url");
          args.url = val;
        } else if (option === "--to") {
          const val = argv[++i];
          if (!val) throw new Error("Missing value for --to");
          args.to = val;
        } else if (option === "--limit") {
          const val = argv[++i];
          if (!val || !/^[1-9]\d*$/.test(val) || Number(val) > 100) throw new Error("--limit must be an integer from 1 to 100");
          args.limit = Number(val);
        } else throw new Error(`Unknown inbox read option: ${option}`);
      }
      if (!args.url && !args.to) throw new Error("Provide --url or --to");
      console.log(JSON.stringify(await runPageJob("readThread", args)));
    } catch (error) { printError(error); }
  }
}

const command: Command = { ...meta, run };
export default command;
