#!/usr/bin/env bun
// Scaffold a new top-level command: bun scripts/new-command.ts <name> [--root DIR]
// Creates src/commands/<name>.ts and tests/<name>.test.ts, refuses to overwrite, prints the remaining checklist.
// No network, no edits to existing files.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const args = process.argv.slice(2);
const rootIdx = args.indexOf("--root");
const root = resolve(rootIdx >= 0 ? args[rootIdx + 1] ?? "" : join(import.meta.dir, ".."));
const name = args.find((a, i) => !a.startsWith("--") && (rootIdx < 0 || i !== rootIdx + 1));
if (!name || !/^[a-z][a-z0-9]*$/.test(name) || (rootIdx >= 0 && !args[rootIdx + 1])) {
  console.error("Usage: bun scripts/new-command.ts <name> [--root DIR]   (name: lowercase letters/digits, starts with a letter)");
  process.exit(2);
}

const modulePath = join(root, "src/commands", `${name}.ts`);
const testPath = join(root, "tests", `${name}.test.ts`);
const existing = [modulePath, testPath].filter(existsSync);
if (existing.length) {
  console.error(`Refusing to overwrite: ${existing.join(", ")}`);
  process.exit(1);
}

const moduleSrc = `import type { Command } from "./types";
import type { CommandMeta } from "../output";
import { printError } from "../output";

// Help data: feeds --help, --help --json, and the tests/command-table.test.ts completeness checks.
export const meta: CommandMeta = {
  name: "${name}",
  usage: "socmedia ${name} <action> [options]",
  summary: "TODO one-line summary",
  commands: [
    { name: "<action>", summary: "TODO what it does" },
  ],
  options: [
    { flag: "--json", description: "Print the result as JSON" },
    { flag: "--text", description: "Print the result as plain text" },
    { flag: "--help", description: "Show this help message" },
  ],
};

// argv is the full process argv (same shape as Bun.argv: [exe, script, command, sub, ...]).
async function run(argv: string[]): Promise<void> {
  try {
    void argv;
    throw new Error("${name}: not implemented");
  } catch (error) { printError(error); }
}

const command: Command = { ...meta, run };
export default command;
`;

const testSrc = `import { expect, test } from "bun:test";

const run = async (...args: string[]) => {
  const cli = Bun.spawn(["bun", "run", "src/cli.ts", ...args], { cwd: import.meta.dir + "/..", env: { ...process.env, SOCMEDIA_EXTENSION_PORT: "0" }, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([new Response(cli.stdout).text(), new Response(cli.stderr).text(), cli.exited]);
  return { stdout, stderr, exit };
};

test("${name} is registered and documents itself in --help", async () => {
  const help = await run("${name}", "--help");
  expect(help.exit).toBe(0);
  expect(help.stdout).toContain("socmedia ${name}");
});

// TDD: write the failing behaviour tests first (use a throwaway SOCMEDIA_STATE_DIR and port 0; no network), then implement.
test.todo("${name}: validation errors, preview without --confirm, happy path");
`;

for (const [path, src] of [[modulePath, moduleSrc], [testPath, testSrc]] as const) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, src, { flag: "wx" });
}

console.log(`Created:\n  ${modulePath}\n  ${testPath}\n
Remaining checklist (see CONTRIBUTING.md):
  [ ] Register: in src/commands/index.ts add  import ${name} from "./${name}";  and put it into COMMANDS
  [ ] Help data: fill meta (usage, summary, commands, options with range/default/enum in the description)
  [ ] Tests first (TDD): replace the test.todo; keep tests offline (temp SOCMEDIA_STATE_DIR, port 0)
  [ ] Implement run(argv); validators/service client go to src/lib/*.ts, not into the command
  [ ] COMMANDS.md: add a row mentioning \`socmedia ${name}\`
  [ ] Skill: add a section to skills/socmedia-cli-usage/SKILL.md mentioning \`socmedia ${name}\` (examples preview-only, no --confirm)
  [ ] Version: bump package.json AND extension/manifest.json together (user-visible change)
  [ ] bun test && bun run typecheck
  [ ] Live check in real Chrome; list everything not verified live in the report`);
