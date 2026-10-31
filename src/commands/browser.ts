import type { Command } from "./types";
import type { CommandMeta } from "../output";
import { printError } from "../output";
import { runPageJob } from "../lib/client";

// Help data (feeds --help, --help --json, skill parity and COMMANDS.md tests).
export const meta: CommandMeta = {
  name: "browser",
  usage: "socmedia browser <click|scroll> [options]",
  summary: "Interact with page via click or scroll",
  commands: [
    { name: "click", summary: "Click an interactive element by index, selector or text" },
    { name: "scroll", summary: "Scroll page or container down" },
  ],
  options: [
    { flag: "--index N", description: "Element index from snapshot" },
    { flag: "--selector SEL", description: "CSS selector to target" },
    { flag: "--text TEXT", description: "Visible text of element to click" },
    { flag: "--times N", description: "Number of times to scroll (1-20, default: 3)" },
    { flag: "--json", description: "Print the result as JSON" },
    { flag: "--text", description: "Print the result as plain text" },
    { flag: "--help", description: "Show this help message" },
  ],
};

// argv is the full process argv (same shape as Bun.argv: [exe, script, command, ...]).
async function run(argv: string[]): Promise<void> {
  if (argv[3] === "click") {
    try {
      const args: { index?: number; selector?: string; text?: string } = {};
      for (let i = 4; i < argv.length; i++) {
        const option = argv[i];
        if (option === "--json") continue;
        if (option === "--index") {
          const val = argv[++i];
          if (!val || !/^\d+$/.test(val)) throw new Error("--index must be a non-negative integer");
          args.index = Number(val);
        } else if (option === "--selector") {
          const val = argv[++i];
          if (!val) throw new Error("Missing value for --selector");
          args.selector = val;
        } else if (option === "--text") {
          const val = argv[++i];
          if (!val) throw new Error("Missing value for --text");
          args.text = val;
        } else throw new Error(`Unknown browser click option: ${option}`);
      }
      if (args.index === undefined && args.selector === undefined && args.text === undefined) throw new Error("Provide --index, --selector or --text");
      console.log(JSON.stringify(await runPageJob("click", args)));
    } catch (error) { printError(error); }
  } else if (argv[3] === "scroll") {
    try {
      const args: { selector?: string; times?: number } = {};
      for (let i = 4; i < argv.length; i++) {
        const option = argv[i];
        if (option === "--json") continue;
        if (option === "--selector") {
          const val = argv[++i];
          if (!val) throw new Error("Missing value for --selector");
          args.selector = val;
        } else if (option === "--times") {
          const val = argv[++i];
          if (!val || !/^[1-9]\d*$/.test(val) || Number(val) > 20) throw new Error("--times must be an integer from 1 to 20");
          args.times = Number(val);
        } else throw new Error(`Unknown browser scroll option: ${option}`);
      }
      console.log(JSON.stringify(await runPageJob("scroll", args)));
    } catch (error) { printError(error); }
  }
}

const command: Command = { ...meta, run };
export default command;
