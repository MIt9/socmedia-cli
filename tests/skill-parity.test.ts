import { test, expect } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { COMMAND_REGISTRY } from "../src/cli";

test("only socmedia-cli-usage skill exists and covers all commands and safety rules", () => {
  // Ensure duplicate skill is removed
  const deprecatedPath = join(import.meta.dir, "../skills/socmedia-cli");
  expect(existsSync(deprecatedPath)).toBe(false);

  const skillPath = join(import.meta.dir, "../skills/socmedia-cli-usage/SKILL.md");
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
  expect(content).toContain("PORT_IN_USE");
  expect(content).toContain("unverified");
});
