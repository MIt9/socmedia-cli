import type { Command } from "./types";
import type { CommandMeta } from "../output";
import { existsSync, lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { printError } from "../output";
import { stateDir, extensionPath, pairingPath } from "../lib/state";
import { installExtension } from "../lib/extension";

// Help data (feeds --help, --help --json, skill parity and COMMANDS.md tests).
export const meta: CommandMeta = {
  name: "extension",
  usage: "socmedia extension <install|path|pair> [options]",
  summary: "Pair the Chrome extension",
  commands: [
    { name: "install", summary: "Copy the extension to its stable state directory and show Chrome setup steps" },
    { name: "path", summary: "Show the stable extension directory" },
    { name: "pair", summary: "Generate a pairing secret for the Chrome extension" },
  ],
  options: [
    { flag: "--open", description: "With install, open chrome://extensions in Google Chrome" },
    { flag: "--id ID", description: "With pair, set the Chrome extension ID" },
    { flag: "--json", description: "Print the result as JSON; pairing output contains a sensitive secret" },
    { flag: "--text", description: "Print the result as plain text" },
    { flag: "--help", description: "Show this help message" },
  ],
};

// argv is the full process argv (same shape as Bun.argv: [exe, script, command, ...]).
async function run(argv: string[]): Promise<void> {
  if ((argv[3] === "install" || argv[3] === "path")) {
    try {
      const options = argv.slice(4);
      const install = argv[3] === "install";
      if (options.some((option) => option !== "--json" && option !== "--text" && !(install && option === "--open"))) throw new Error("Unknown extension option");
      const result = install ? installExtension() : { path: extensionPath };
      if (install && options.includes("--open")) {
        if (process.platform !== "darwin") throw new Error("--open is currently supported on macOS only");
        const opened = spawnSync("open", ["-a", "Google Chrome", "chrome://extensions"]);
        if (opened.error || opened.status !== 0) throw new Error("Extension copied, but Chrome could not be opened; open chrome://extensions manually");
      }
      if (options.includes("--json")) {
        console.log(JSON.stringify(result));
      } else if (install) {
        const res = result as { path: string; id: string; steps: string[] };
        console.log(`Extension unpacked to: ${res.path}`);
        console.log(`Extension ID:         ${res.id}\n`);
        console.log("Steps to load in Chrome:");
        res.steps.forEach((step, idx) => console.log(`  ${idx + 1}. ${step}`));
      } else {
        console.log(result.path);
      }
    } catch (error) { printError(error); }
  } else if (argv[3] === "pair") {
    try {
      if (argv[4] !== "--id" || !/^[a-p]{32}$/.test(argv[5] ?? "") || argv.slice(6).some((arg) => arg !== "--json" && arg !== "--text")) throw new Error("Provide --id followed by the 32-character Chrome extension ID");
      const pairing = { id: argv[5]!, token: randomBytes(32).toString("hex") };
      mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      const temporary = join(stateDir, `.pairing-${randomBytes(8).toString("hex")}`);
      try {
        writeFileSync(temporary, JSON.stringify(pairing), { mode: 0o600, flag: "wx" });
        renameSync(temporary, pairingPath);
      } finally { rmSync(temporary, { force: true }); }
      if (existsSync(extensionPath) && lstatSync(extensionPath).isDirectory()) {
        try { writeFileSync(join(extensionPath, "pair.json"), JSON.stringify(pairing), "utf8"); } catch {}
      }
      if (argv.includes("--json")) console.log(JSON.stringify(pairing));
      else console.log(`Extension paired: ${pairing.id}`);
    } catch (error) { printError(error); }
  }
}

const command: Command = { ...meta, run };
export default command;
