import type { Command } from "./types";
import type { CommandMeta } from "../output";
import { printError } from "../output";
import { runPageJob } from "../lib/client";
import { parseMessageTarget, checkMessageText, previewUnlessConfirmed } from "../lib/validate";

// Help data (feeds --help, --help --json, skill parity and COMMANDS.md tests).
export const meta: CommandMeta = {
  name: "message",
  usage: "socmedia message send --to URL --text TEXT [--confirm] [options]",
  summary: "Send direct messages",
  commands: [
    { name: "send", summary: "Send a direct message via Instagram or Facebook" },
  ],
  options: [
    { flag: "--to URL", description: "Recipient profile or direct thread URL" },
    { flag: "--text TEXT", description: "Message content (max 1000 characters)" },
    { flag: "--confirm", description: "Confirm send; without this flag, returns a dry-run preview" },
    { flag: "--json", description: "Print the result as JSON" },
    { flag: "--text", description: "Print the result as plain text" },
    { flag: "--help", description: "Show this help message" },
  ],
};

// argv is the full process argv (same shape as Bun.argv: [exe, script, command, ...]).
async function run(argv: string[]): Promise<void> {
  if (argv[3] === "send") {
    try {
      let to: string | undefined;
      let text: string | undefined;
      let confirm = false;
      for (let i = 4; i < argv.length; i++) {
        const option = argv[i];
        if (option === "--json") continue;
        if (option === "--to") {
          to = argv[++i];
          if (!to) throw new Error("Missing value for --to");
        } else if (option === "--text") {
          text = argv[++i];
          if (text === undefined) throw new Error("Missing value for --text");
        } else if (option === "--confirm") {
          confirm = true;
        } else throw new Error(`Unknown message option: ${option}`);
      }
      if (!to) throw new Error("Missing recipient (--to URL)");
      if (text === undefined) throw new Error("Missing message text (--text TEXT)");
      const preview = previewUnlessConfirmed({ to, text, confirm });
      if (preview) {
        console.log(JSON.stringify(preview));
      } else {
        const parsed = parseMessageTarget(to);
        const cleanText = checkMessageText(text);
        console.log(JSON.stringify(await runPageJob("sendMessage", { to: parsed.url, text: cleanText })));
      }
    } catch (error) { printError(error); }
  }
}

const command: Command = { ...meta, run };
export default command;
