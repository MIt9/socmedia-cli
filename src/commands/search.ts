import type { Command } from "./types";
import type { CommandMeta } from "../output";
import { printError } from "../output";
import { runPageJob } from "../lib/client";

// Help data (feeds --help, --help --json, skill parity and COMMANDS.md tests).
export const meta: CommandMeta = {
  name: "search",
  usage: "socmedia search <platform> <query> [options]",
  summary: "Search on Instagram or Facebook",
  options: [
    { flag: "--type TYPE", description: "users, hashtag, pages, places (default: users)" },
    { flag: "--limit N", description: "Maximum results from 1 to 50 (default: 20)" },
    { flag: "--json", description: "Print the result as JSON" },
    { flag: "--text", description: "Print the result as plain text" },
    { flag: "--help", description: "Show this help message" },
  ],
};

// argv is the full process argv (same shape as Bun.argv: [exe, script, command, ...]).
async function run(argv: string[]): Promise<void> {
  try {
    const platform = argv[3];
    const query = argv[4];
    if (!platform || !query || platform.startsWith("--") || query.startsWith("--")) throw new Error("Usage: socmedia search <platform> <query> [options]");
    const norm = { ig: "ig", instagram: "ig", fb: "fb", facebook: "fb" }[platform.toLowerCase()];
    if (!norm) throw new Error("Search platform must be ig or fb");
    const args: { platform: string; query: string; type?: string; limit?: number } = { platform: norm, query, type: "users", limit: 20 };
    for (let i = 5; i < argv.length; i++) {
      const option = argv[i];
      if (option === "--json") continue;
      if (option === "--type") {
        const val = argv[++i];
        if (!val || !["users", "hashtag", "pages", "places"].includes(val)) throw new Error("Search type must be users, hashtag, pages or places");
        args.type = val;
      } else if (option === "--limit") {
        const val = argv[++i];
        if (!val || !/^[1-9]\d*$/.test(val) || Number(val) > 50) throw new Error("--limit must be an integer from 1 to 50");
        args.limit = Number(val);
      } else throw new Error(`Unknown search option: ${option}`);
    }
    console.log(JSON.stringify(await runPageJob("search", args)));
  } catch (error) { printError(error); }
}

const command: Command = { ...meta, run };
export default command;
