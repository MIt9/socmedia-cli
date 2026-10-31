import type { Command } from "./types";
import type { CommandMeta } from "../output";
import { printError } from "../output";
import { runPageJob } from "../lib/client";
import { postUrl } from "../lib/validate";

// Help data (feeds --help, --help --json, skill parity and COMMANDS.md tests).
export const meta: CommandMeta = {
  name: "post",
  usage: "socmedia post <get|comments> <url> [options]",
  summary: "Inspect a social post",
  commands: [
    { name: "get <url>", summary: "Read a post from Instagram or Facebook" },
    { name: "comments <url>", summary: "Read Instagram or Facebook post comments" },
  ],
  options: [
    { flag: "--download", description: "With get, download media files to ~/socmedia-data" },
    { flag: "--slides", description: "Alias for --download" },
    { flag: "--limit N", description: "With comments, maximum comments from 1 to 500 (default: 20)" },
    { flag: "--json", description: "Print the result as JSON" },
    { flag: "--text", description: "Print the result as plain text" },
    { flag: "--help", description: "Show this help message" },
  ],
};

// argv is the full process argv (same shape as Bun.argv: [exe, script, command, ...]).
async function run(argv: string[]): Promise<void> {
  if (argv[3] === "get") {
    try {
      const url = postUrl(argv[4]);
      const args: { url: string; download?: boolean } = { url };
      for (let i = 5; i < argv.length; i++) {
        const option = argv[i];
        if (option === "--json") continue;
        if (option === "--download" || option === "--slides") args.download = true;
        else throw new Error(`Unknown post option: ${option}`);
      }
      console.log(JSON.stringify(await runPageJob("getPost", args)));
    } catch (error) { printError(error); }
  } else if (argv[3] === "comments") {
    try {
      const url = postUrl(argv[4]);
      const args: { url: string; limit?: number } = { url };
      for (let i = 5; i < argv.length; i++) {
        const option = argv[i];
        if (option === "--json") continue;
        if (option !== "--limit") throw new Error(`Unknown post option: ${option}`);
        const value = argv[++i];
        if (!value || !/^[1-9]\d*$/.test(value) || Number(value) > 500) throw new Error("--limit must be an integer from 1 to 500");
        args.limit = Number(value);
      }
      console.log(JSON.stringify(await runPageJob("getComments", args)));
    } catch (error) { printError(error); }
  }
}

const command: Command = { ...meta, run };
export default command;
