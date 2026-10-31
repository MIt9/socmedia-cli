import type { CommandMeta } from "../output";
import { formatCommandHelp } from "../output";
import type { Command } from "./types";
import service from "./service";
import queue from "./queue";
import tabs from "./tabs";
import profile from "./profile";
import contacts from "./contacts";
import post from "./post";
import page from "./page";
import screenshot from "./screenshot";
import search from "./search";
import config from "./config";
import extension from "./extension";
import inbox from "./inbox";
import message from "./message";
import youtube from "./youtube";
import browser from "./browser";
import doctor from "./doctor";
import update from "./update";

// THE dispatch table. Order = order in `socmedia --help`. To add a command: new module + one line here.
export const COMMANDS: Command[] = [service, queue, tabs, profile, contacts, post, page, screenshot, search, config, extension, inbox, message, youtube, browser, doctor, update];

// Help data only (no runners): what --help, --help --json, and the parity tests read.
export const COMMAND_REGISTRY: CommandMeta[] = COMMANDS.map(({ run: _run, ...meta }) => meta);

export function formatRootHelp(): string {
  const lines: string[] = [];
  lines.push("Usage: socmedia [options]\n");
  lines.push("Commands:");
  for (const cmd of COMMAND_REGISTRY) {
    lines.push(`  ${cmd.name.padEnd(12)} ${cmd.summary}`);
  }
  lines.push("\nOptions:");
  lines.push("  --version    Show the CLI version");
  lines.push("  --help       Show this help message");
  lines.push("  --json       Print the result as JSON");
  lines.push("  --text       Print the result as plain text");
  return lines.join("\n");
}

export function printHelp(argv: string[]): void {
  const json = argv.includes("--json");
  const cmdName = argv.slice(2).find((arg) => !arg.startsWith("-"));
  const found = cmdName ? COMMAND_REGISTRY.find((c) => c.name === cmdName) : undefined;
  if (json) {
    if (cmdName) console.log(JSON.stringify(found ?? { error: `Unknown command: ${cmdName}` }));
    else console.log(JSON.stringify(COMMAND_REGISTRY));
  } else {
    console.log(found ? formatCommandHelp(found) : formatRootHelp());
  }
}

export async function dispatch(argv: string[]): Promise<void> {
  const command = COMMANDS.find((c) => c.name === argv[2]);
  if (command) await command.run(argv); // unknown command: silent no-op, as before the refactor
}
