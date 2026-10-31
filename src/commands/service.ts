import type { Command } from "./types";
import type { CommandMeta } from "../output";
import { join } from "node:path";
import { printOutput, printError } from "../output";
import { status, start, stop, queueRequest } from "../lib/client";

// Help data (feeds --help, --help --json, skill parity and COMMANDS.md tests).
export const meta: CommandMeta = {
  name: "service",
  usage: "socmedia service <start|status|stop|resume> [options]",
  summary: "Start or inspect the local service",
  commands: [
    { name: "start", summary: "Start the local service or return the running service" },
    { name: "status", summary: "Show service, halted state and extension connection status" },
    { name: "stop", summary: "Stop the local service; succeed if already stopped" },
    { name: "resume", summary: "Resume the queue after manually resolving a login or security challenge" },
  ],
  options: [
    { flag: "--json", description: "Print the result as JSON" },
    { flag: "--text", description: "Print the result as plain text" },
    { flag: "--help", description: "Show this help message" },
  ],
};

// argv is the full process argv (same shape as Bun.argv: [exe, script, command, ...]).
async function run(argv: string[]): Promise<void> {
  if (argv[3] === "status") {
    const res = await status();
    printOutput(res, () => {
      if (!res.running) {
        const inUseMsg = res.portInUse ? ` (PORT_IN_USE on port ${res.port})` : "";
        return `Service: stopped${inUseMsg}\nPort: ${res.port} (source: ${res.portSource})\nPinned ID: ${res.pinnedId}`;
      }
      const ext = res.extension as { connected?: boolean; version?: string } | undefined;
      const lines = [
        `Service: running (PID ${res.pid}, v${res.version})`,
        `Extension: ${ext?.connected ? `connected (v${ext.version})` : "not connected"}`,
        `Port: ${res.port} (source: ${res.portSource})`,
        `Pinned ID: ${res.pinnedId}`,
      ];
      if (res.halted) lines.push(`Halted:    ${JSON.stringify(res.halted)}`);
      return lines.join("\n");
    });
  } else if (argv[3] === "start") {
    try {
      const res = await start();
      printOutput(res, () => `Service running (PID ${res.pid}, v${res.version})`);
    } catch (error) { printError(error); }
  } else if (argv[3] === "stop") {
    try {
      const res = await stop();
      printOutput(res, () => "Service stopped");
    } catch (error) { printError(error); }
  } else if (argv[3] === "resume") {
    try { console.log(JSON.stringify(await queueRequest("service resume"))); }
    catch (error) { printError(error); }
  }
}

const command: Command = { ...meta, run };
export default command;
