import type { Command } from "./types";
import type { CommandMeta } from "../output";
import { printError } from "../output";
import { readConfig, writeConfig, effectivePort } from "../lib/config";

// Help data (feeds --help, --help --json, skill parity and COMMANDS.md tests).
export const meta: CommandMeta = {
  name: "config",
  usage: "socmedia config <get|set|unset> port [value] [options]",
  summary: "Configure the service",
  commands: [
    { name: "get port", summary: "Show the effective port and configuration source" },
    { name: "set port <value>", summary: "Save a port from 1 to 65535" },
    { name: "unset port", summary: "Remove the saved port" },
  ],
  options: [
    { flag: "--json", description: "Print the result as JSON" },
    { flag: "--text", description: "Print the result as plain text" },
    { flag: "--help", description: "Show this help message" },
  ],
};

// argv is the full process argv (same shape as Bun.argv: [exe, script, command, ...]).
async function run(argv: string[]): Promise<void> {
  try {
    const action = argv[3];
    if (argv[4] !== "port" || !["get", "set", "unset"].includes(action ?? "")) throw new Error("Use config get|set|unset port");
    const rest = argv.slice(action === "set" ? 6 : 5);
    if (rest.some((option) => option !== "--json")) throw new Error("Unknown config option");
    if (action === "set") {
      const value = argv[5];
      if (!value || !/^[1-9]\d*$/.test(value) || Number(value) > 65535) throw new Error("Port must be an integer from 1 to 65535");
      writeConfig({ ...readConfig(), port: Number(value) });
    } else if (action === "unset") {
      const config = readConfig(); delete config.port; writeConfig(config);
    }
    console.log(JSON.stringify({ ...effectivePort(), ...(action !== "get" && { note: "Changes apply after the service restarts" }) }));
  } catch (error) { printError(error); }
}

const command: Command = { ...meta, run };
export default command;
