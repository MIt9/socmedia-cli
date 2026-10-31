import type { Command } from "./types";
import type { CommandMeta } from "../output";
import { join } from "node:path";
import { printOutput, printError } from "../output";
import { runDoctor } from "../lib/client";

// Help data (feeds --help, --help --json, skill parity and COMMANDS.md tests).
export const meta: CommandMeta = {
  name: "doctor",
  usage: "socmedia doctor [options]",
  summary: "Check system health, permissions, services, and extension status",
  options: [
    { flag: "--json", description: "Print the result as JSON" },
    { flag: "--text", description: "Print the result as plain text" },
    { flag: "--help", description: "Show this help message" },
  ],
};

// argv is the full process argv (same shape as Bun.argv: [exe, script, command, ...]).
async function run(argv: string[]): Promise<void> {
  try {
    const res = await runDoctor();
    printOutput(res, () => {
      const lines = ["socmedia doctor:"];
      for (const c of res.checks) {
        const mark = c.ok ? "[✓]" : "[✗]";
        lines.push(`  ${mark} ${c.check}: ${c.message}${c.fix ? ` (fix: ${c.fix})` : ""}`);
      }
      lines.push(res.ok ? "\nResult: all checks passed" : `\nResult: ${res.checks.filter((c) => !c.ok).length} check(s) failed`);
      return lines.join("\n");
    });
    if (!res.ok) process.exitCode = 1;
  } catch (error) { printError(error); }
}

const command: Command = { ...meta, run };
export default command;
