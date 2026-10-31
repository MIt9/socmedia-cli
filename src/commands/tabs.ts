import type { Command } from "./types";
import type { CommandMeta } from "../output";
import { printError } from "../output";
import { queueRequest } from "../lib/client";

// Help data (feeds --help, --help --json, skill parity and COMMANDS.md tests).
export const meta: CommandMeta = {
  name: "tabs",
  usage: "socmedia tabs <list|use|clear> [options]",
  summary: "Inspect extension work tabs",
  commands: [
    { name: "list", summary: "List Socmedia CLI group tabs and the selected tab" },
    { name: "use <tabId>", summary: "Select an open Instagram, Facebook or YouTube tab by its numeric ID" },
    { name: "clear", summary: "Clear the selected tab and return to the Socmedia CLI group" },
  ],
  options: [
    { flag: "--json", description: "Print the result as JSON" },
    { flag: "--text", description: "Print the result as plain text" },
    { flag: "--help", description: "Show this help message" },
  ],
};

// argv is the full process argv (same shape as Bun.argv: [exe, script, command, ...]).
async function run(argv: string[]): Promise<void> {
  if (argv[3] === "list") {
    try { console.log(JSON.stringify(await queueRequest("tabs list"))); }
    catch (error) { printError(error); }
  } else if ((argv[3] === "use" || argv[3] === "clear")) {
    try {
      const rawId = argv[4];
      if (argv[3] === "use" && (!rawId || !/^(0|[1-9]\d*)$/.test(rawId) || !Number.isSafeInteger(Number(rawId)))) throw new Error("Tab ID must be a non-negative integer");
      const rest = argv.slice(argv[3] === "use" ? 5 : 4);
      if (rest.some((arg) => arg !== "--json")) throw new Error("Unknown tabs option");
      console.log(JSON.stringify(await queueRequest(argv[3] === "use" ? `tabs use ${rawId}` : "tabs clear")));
    } catch (error) { printError(error); }
  }
}

const command: Command = { ...meta, run };
export default command;
