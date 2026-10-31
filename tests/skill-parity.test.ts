import { test, expect } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { COMMAND_REGISTRY } from "../src/cli";

test("SKILL.md covers all commands in COMMAND_REGISTRY and documents safety rules", () => {
  const skillPath = join(import.meta.dir, "../skills/socmedia-cli/SKILL.md");
  expect(existsSync(skillPath)).toBe(true);

  const content = readFileSync(skillPath, "utf8");

  // Every command group in COMMAND_REGISTRY must be mentioned in SKILL.md
  for (const cmd of COMMAND_REGISTRY) {
    expect(content).toContain(`socmedia ${cmd.name}`);
  }

  // Safety rules must be explicitly documented
  expect(content).toContain("NEVER autonomously add `--confirm`");
  expect(content).toContain("HALT");
  expect(content).toContain("socmedia service resume");
  expect(content).toContain("socmedia doctor");
  expect(content).toContain("socmedia update");
  expect(content).toContain("SOCMEDIA_CLI_FORMAT");

  // Parity check for socmedia-cli-usage as well
  const altSkillPath = join(import.meta.dir, "../skills/socmedia-cli-usage/SKILL.md");
  expect(existsSync(altSkillPath)).toBe(true);
  const altContent = readFileSync(altSkillPath, "utf8");
  for (const cmd of COMMAND_REGISTRY) {
    expect(altContent).toContain(`socmedia ${cmd.name}`);
  }
});
