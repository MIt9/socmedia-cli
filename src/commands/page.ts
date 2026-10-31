import type { Command } from "./types";
import type { CommandMeta } from "../output";
import { printError } from "../output";
import { runPageJob } from "../lib/client";

// Help data (feeds --help, --help --json, skill parity and COMMANDS.md tests).
export const meta: CommandMeta = {
  name: "page",
  usage: "socmedia page <read|snapshot> [options]",
  summary: "Inspect the work page",
  commands: [
    { name: "read", summary: "Queue and return visible page text and URL" },
    { name: "snapshot", summary: "Queue and return visible interactive elements" },
  ],
  options: [
    { flag: "--max-lines N", description: "With read, limit output to 1-1000 lines (default: 200)" },
    { flag: "--json", description: "Print the result as JSON" },
    { flag: "--text", description: "Print the result as plain text" },
    { flag: "--help", description: "Show this help message" },
  ],
};

// argv is the full process argv (same shape as Bun.argv: [exe, script, command, ...]).
async function run(argv: string[]): Promise<void> {
  if ((argv[3] === "snapshot" || argv[3] === "read")) {
    try {
      const args: Record<string, number> = {};
      for (let i = 4; i < argv.length; i++) {
        const option = argv[i];
        if (option === "--json") continue;
        if (option === "--max-lines" && argv[3] === "read") {
          const value = argv[++i];
          if (!value || !/^[1-9]\d*$/.test(value) || Number(value) > 1000) throw new Error("--max-lines must be an integer from 1 to 1000");
          args.maxLines = Number(value);
        } else throw new Error(`Unknown page option: ${option}`);
      }
      console.log(JSON.stringify(await runPageJob(argv[3] === "read" ? "readPage" : "snapshot", args)));
    } catch (error) { printError(error); }
  }
}

const command: Command = { ...meta, run };
export default command;
