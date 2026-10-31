import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { COMMANDS, COMMAND_REGISTRY } from "../src/commands";

const root = join(import.meta.dir, "..");
const commandsMd = readFileSync(join(root, "COMMANDS.md"), "utf8");
const skill = readFileSync(join(root, "skills/socmedia-cli-usage/SKILL.md"), "utf8");

test("every src/commands/<name>.ts module is registered in the dispatch table, and names are unique", () => {
  const files = readdirSync(join(root, "src/commands")).filter((f) => f.endsWith(".ts") && !["index.ts", "types.ts"].includes(f)).map((f) => f.slice(0, -3)).sort();
  expect(COMMANDS.map((c) => c.name).sort()).toEqual(files);
  expect(new Set(COMMANDS.map((c) => c.name)).size).toBe(COMMANDS.length);
});

test("every registered command has help data and a runner", () => {
  for (const c of COMMANDS) {
    expect(typeof c.run, `${c.name}: run`).toBe("function");
    expect(c.usage.startsWith(`socmedia ${c.name}`), `${c.name}: usage must start with "socmedia ${c.name}"`).toBe(true);
    expect(c.summary.trim().length, `${c.name}: summary`).toBeGreaterThan(0);
    const options = c.options ?? [];
    expect(options.length, `${c.name}: options`).toBeGreaterThan(0);
    for (const flag of ["--json", "--text", "--help"]) expect(options.some((o) => o.flag === flag), `${c.name}: ${flag}`).toBe(true);
    for (const o of options) expect(o.description.trim().length, `${c.name} ${o.flag}: description`).toBeGreaterThan(0);
    for (const s of c.commands ?? []) expect(s.summary.trim().length, `${c.name} ${s.name}: summary`).toBeGreaterThan(0);
  }
});

test("--help --json exposes help data only (no functions) for every command", () => {
  for (const c of COMMAND_REGISTRY) expect(Object.values(c).some((v) => typeof v === "function"), c.name).toBe(false);
  expect(JSON.parse(JSON.stringify(COMMAND_REGISTRY)).map((c: { name: string }) => c.name)).toEqual(COMMANDS.map((c) => c.name));
});

test("every registered command is documented in COMMANDS.md and in the usage skill", () => {
  for (const c of COMMANDS) {
    expect(commandsMd.includes(`socmedia ${c.name}`), `COMMANDS.md has no row mentioning "socmedia ${c.name}"`).toBe(true);
    expect(skill.includes(`socmedia ${c.name}`), `SKILL.md has no mention of "socmedia ${c.name}"`).toBe(true);
  }
});
