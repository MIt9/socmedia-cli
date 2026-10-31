import type { Command } from "./types";
import type { CommandMeta } from "../output";
import { printError } from "../output";
import { runPageJob } from "../lib/client";

// Help data (feeds --help, --help --json, skill parity and COMMANDS.md tests).
export const meta: CommandMeta = {
  name: "screenshot",
  usage: "socmedia screenshot [options]",
  summary: "Take a screenshot of the work page",
  options: [
    { flag: "--url URL", description: "Navigate to URL first" },
    { flag: "--selector SEL", description: "CSS selector to crop" },
    { flag: "--target TARGET", description: "viewport, post, or profile (default: viewport)" },
    { flag: "--path PATH", description: "Output file destination inside home" },
    { flag: "--json", description: "Print the result as JSON" },
    { flag: "--text", description: "Print the result as plain text" },
    { flag: "--help", description: "Show this help message" },
  ],
};

// argv is the full process argv (same shape as Bun.argv: [exe, script, command, ...]).
async function run(argv: string[]): Promise<void> {
  try {
    const args: { url?: string; selector?: string; target?: string; path?: string } = {};
    for (let i = 3; i < argv.length; i++) {
      const option = argv[i];
      if (option === "--json") continue;
      if (option === "--url") {
        const val = argv[++i];
        if (!val) throw new Error("Missing value for --url");
        args.url = val;
      } else if (option === "--selector") {
        const val = argv[++i];
        if (!val) throw new Error("Missing value for --selector");
        args.selector = val;
      } else if (option === "--target") {
        const val = argv[++i];
        if (!val || !["viewport", "post", "profile"].includes(val)) throw new Error("Screenshot target must be viewport, post or profile");
        args.target = val;
      } else if (option === "--path") {
        const val = argv[++i];
        if (!val) throw new Error("Missing value for --path");
        args.path = val;
      } else throw new Error(`Unknown screenshot option: ${option}`);
    }
    if (!args.target) args.target = "viewport";
    console.log(JSON.stringify(await runPageJob("screenshot", args)));
  } catch (error) { printError(error); }
}

const command: Command = { ...meta, run };
export default command;
