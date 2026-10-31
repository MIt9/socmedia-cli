import type { Command } from "./types";
import type { CommandMeta } from "../output";
import { printError } from "../output";
import { queueRequest } from "../lib/client";
import { validateJob } from "../lib/validate";

// Help data (feeds --help, --help --json, skill parity and COMMANDS.md tests).
export const meta: CommandMeta = {
  name: "queue",
  usage: "socmedia queue <list|get|cancel|enqueue> [options]",
  summary: "Inspect or manage the service queue",
  commands: [
    { name: "list", summary: "List saved queue jobs" },
    { name: "get <id>", summary: "Show a job by its positive numeric ID" },
    { name: "cancel <id>", summary: "Cancel a queued job by ID" },
    { name: "enqueue <action>", summary: "Queue an action; readPage, snapshot and Instagram/Facebook getProfile execute" },
  ],
  options: [
    { flag: "--args JSON", description: "Action arguments as a JSON object (default: {})" },
    { flag: "--not-before TIME", description: "Earliest run time as an ISO date" },
    { flag: "--key KEY", description: "Reuse the same job; changed action, args or time causes a key conflict" },
    { flag: "--json", description: "Print the result as JSON" },
    { flag: "--text", description: "Print the result as plain text" },
    { flag: "--help", description: "Show this help message" },
  ],
};

// argv is the full process argv (same shape as Bun.argv: [exe, script, command, ...]).
async function run(argv: string[]): Promise<void> {
  if (argv[3] === "list") {
    try { console.log(JSON.stringify(await queueRequest("queue list"))); }
    catch (error) { printError(error); }
  } else if (argv[3] === "enqueue") {
    try {
      const action = argv[4];
      let args: unknown = {};
      let key: string | undefined;
      let notBefore: string | undefined;
      for (let i = 5; i < argv.length; i++) {
        const option = argv[i];
        if (option === "--json") continue;
        if (!["--args", "--key", "--not-before"].includes(option ?? "") || !argv[i + 1]) throw new Error(`Invalid option or missing value: ${option}`);
        const value = argv[++i]!;
        if (option === "--args") { try { args = JSON.parse(value); } catch { throw new Error("--args must be a JSON object"); } }
        else if (option === "--key") key = value;
        else notBefore = value;
      }
      const job = validateJob({ action, args, key, notBefore });
      console.log(JSON.stringify(await queueRequest(`queue enqueue ${JSON.stringify(job)}`)));
    } catch (error) { printError(error); }
  } else if ((argv[3] === "get" || argv[3] === "cancel")) {
    try {
      const id = argv[4];
      if (!id || !/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))) throw new Error("Job ID must be a positive integer");
      console.log(JSON.stringify(await queueRequest(`queue ${argv[3]} ${id}`)));
    }
    catch (error) { printError(error); }
  }
}

const command: Command = { ...meta, run };
export default command;
