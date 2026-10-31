import type { Command } from "./types";
import type { CommandMeta } from "../output";
import { join } from "node:path";
import { printOutput, printError } from "../output";
import { runUpdate } from "../lib/client";

// Help data (feeds --help, --help --json, skill parity and COMMANDS.md tests).
export const meta: CommandMeta = {
  name: "update",
  usage: "socmedia update [--check] [options]",
  summary: "Check for or install socmedia CLI updates",
  options: [
    { flag: "--check", description: "Check for updates without downloading or installing" },
    { flag: "--json", description: "Print the result as JSON" },
    { flag: "--text", description: "Print the result as plain text" },
    { flag: "--help", description: "Show this help message" },
  ],
};

// argv is the full process argv (same shape as Bun.argv: [exe, script, command, ...]).
async function run(argv: string[]): Promise<void> {
  try {
    const checkOnly = argv.includes("--check");
    const res = await runUpdate(checkOnly);
    printOutput(res, () => {
      const r = res as { current: string; latest?: string | null; hint?: string; message?: string };
      const lines = [
        `Current version: ${r.current}`,
        `Latest version:  ${r.latest || "unknown"}`,
        `Status:          ${r.hint || r.message || ""}`,
      ];
      return lines.join("\n");
    });
  } catch (error) { printError(error); }
}

const command: Command = { ...meta, run };
export default command;
