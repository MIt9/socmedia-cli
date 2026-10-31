import type { Command } from "./types";
import type { CommandMeta } from "../output";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { printError } from "../output";
import { resolveHomePath } from "../media";
import { status, queueRequest } from "../lib/client";
import { stateDir } from "../lib/state";
import { contactStatuses } from "../lib/validate";

// Help data (feeds --help, --help --json, skill parity and COMMANDS.md tests).
export const meta: CommandMeta = {
  name: "contacts",
  usage: "socmedia contacts <list|update|export|import> [options]",
  summary: "List local contacts",
  commands: [
    { name: "list", summary: "List locally stored contacts" },
    { name: "update <id>", summary: "Update a contact by its ID; provide --status and/or --note" },
    { name: "export", summary: "Export filtered contacts to a file inside home" },
    { name: "import", summary: "Import contacts and message history from legacy ~/.socmedia-mcp" },
  ],
  options: [
    { flag: "--status STATUS", description: "Filter list/export or set status: new, messaged, replied, won, rejected, skip" },
    { flag: "--platform NAME", description: "Filter list/export by ig or fb" },
    { flag: "--note TEXT", description: "Set note on update (maximum 2000 characters; empty clears it)" },
    { flag: "--format FORMAT", description: "Export as csv, json or jsonl (default: csv)" },
    { flag: "--path PATH", description: "Export destination inside home" },
    { flag: "--from DIR", description: "With import, source directory containing contacts.jsonl / messages.jsonl" },
    { flag: "--json", description: "Print the command result as JSON" },
    { flag: "--text", description: "Print the result as plain text" },
    { flag: "--help", description: "Show this help message" },
  ],
};

// argv is the full process argv (same shape as Bun.argv: [exe, script, command, ...]).
async function run(argv: string[]): Promise<void> {
  if (argv[3] === "export") {
    try {
      const args: { status?: string; platform?: string; format?: string; path?: string } = {};
      for (let i = 4; i < argv.length; i++) {
        const option = argv[i];
        if (option === "--json") continue;
        if (!["--status", "--platform", "--format", "--path"].includes(option ?? "")) throw new Error(`Unknown contacts option: ${option}`);
        const value = argv[++i];
        if (value === undefined || value === "" || value.startsWith("--")) throw new Error(`${option} requires a value`);
        if (option === "--status") { if (!contactStatuses.includes(value)) throw new Error("Invalid contact status"); args.status = value; }
        else if (option === "--platform") { if (!["ig", "fb"].includes(value)) throw new Error("--platform must be ig or fb"); args.platform = value; }
        else if (option === "--format") { if (!["csv", "json", "jsonl"].includes(value)) throw new Error("--format must be csv, json or jsonl"); args.format = value; }
        else args.path = value;
      }
      console.log(JSON.stringify(await queueRequest(`contacts export ${JSON.stringify(args)}`)));
    } catch (error) { printError(error); }
  } else if (argv[3] === "update") {
    try {
      const id = argv[4];
      if (!id || id.startsWith("--") || !id.trim()) throw new Error("Contact ID is required");
      const update: { id: string; status?: string; note?: string } = { id };
      for (let i = 5; i < argv.length; i++) {
        const option = argv[i];
        if (option === "--json") continue;
        if (option !== "--status" && option !== "--note") throw new Error(`Unknown contacts option: ${option}`);
        const value = argv[++i];
        if (value === undefined || ["--json", "--status", "--note"].includes(value)) throw new Error(`${option} requires a value`);
        if (option === "--status") {
          if (!contactStatuses.includes(value)) throw new Error("--status must be new, messaged, replied, won, rejected or skip");
          update.status = value;
        } else {
          if (value.length > 2000) throw new Error("--note must be at most 2000 characters");
          update.note = value;
        }
      }
      if (update.status === undefined && update.note === undefined) throw new Error("Provide --status or --note");
      console.log(JSON.stringify(await queueRequest(`contacts update ${JSON.stringify(update)}`)));
    } catch (error) { printError(error); }
  } else if (argv[3] === "list") {
    try {
      const filters: { status?: string; platform?: string } = {};
      for (let i = 4; i < argv.length; i++) {
        const option = argv[i];
        if (option === "--json") continue;
        if (option !== "--status" && option !== "--platform") throw new Error(`Unknown contacts option: ${option}`);
        const value = argv[++i];
        if (option === "--status") {
          if (!value || !contactStatuses.includes(value)) throw new Error("--status must be new, messaged, replied, won, rejected or skip");
          filters.status = value;
        } else {
          if (!value || !["ig", "fb"].includes(value)) throw new Error("--platform must be ig or fb");
          filters.platform = value;
        }
      }
      const current = await status();
      if (current.running) {
        console.log(JSON.stringify(await queueRequest(`contacts list ${JSON.stringify(filters)}`)));
      } else {
        mkdirSync(stateDir, { recursive: true, mode: 0o700 });
        const db = new Database(join(stateDir, "state.sqlite"));
        db.run("CREATE TABLE IF NOT EXISTS contacts (id TEXT PRIMARY KEY, data TEXT NOT NULL)");
        const rows = db.query("SELECT data FROM contacts ORDER BY rowid").all() as { data: string }[];
        const contacts = rows.map((row) => JSON.parse(row.data)).filter((contact) => (!filters.status || contact.status === filters.status) && (!filters.platform || contact.platform === filters.platform));
        db.close();
        console.log(JSON.stringify({ count: contacts.length, file: join(stateDir, "state.sqlite"), contacts }));
      }
    } catch (error) { printError(error); }
  } else if (argv[3] === "import") {
    try {
      let from: string | undefined;
      for (let i = 4; i < argv.length; i++) {
        const option = argv[i];
        if (option === "--json") continue;
        if (option === "--from") {
          from = argv[++i];
          if (!from) throw new Error("Missing value for --from");
        } else throw new Error(`Unknown contacts import option: ${option}`);
      }
      const current = await status();
      if (current.running) {
        console.log(JSON.stringify(await queueRequest(`contacts import ${JSON.stringify({ from })}`)));
      } else {
        // Direct SQLite import if service is not running
        mkdirSync(stateDir, { recursive: true, mode: 0o700 });
        const db = new Database(join(stateDir, "state.sqlite"));
        db.run("CREATE TABLE IF NOT EXISTS contacts (id TEXT PRIMARY KEY, data TEXT NOT NULL)");
        db.run("CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY, at TEXT NOT NULL, platform TEXT NOT NULL, toUrl TEXT NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL, error TEXT, jobId INTEGER)");
        const sourceDir = from ? resolveHomePath(from) : join(homedir(), ".socmedia-mcp");
        let contactsImported = 0;
        let messagesImported = 0;
        const contactsFile = join(sourceDir, "contacts.jsonl");
        if (existsSync(contactsFile)) {
          const lines = readFileSync(contactsFile, "utf8").split("\n").filter((l) => l.trim());
          db.transaction(() => {
            for (const line of lines) {
              try {
                const c = JSON.parse(line);
                if (c && typeof c.id === "string") {
                  const existing = db.query("SELECT data FROM contacts WHERE id = ?").get(c.id);
                  if (!existing) {
                    db.query("INSERT INTO contacts (id, data) VALUES (?, ?)").run(c.id, JSON.stringify(c));
                    contactsImported++;
                  }
                }
              } catch {}
            }
          })();
        }
        const messagesFile = join(sourceDir, "messages.jsonl");
        if (existsSync(messagesFile)) {
          const lines = readFileSync(messagesFile, "utf8").split("\n").filter((l) => l.trim());
          db.transaction(() => {
            for (const line of lines) {
              try {
                const m = JSON.parse(line);
                if (m && m.at && m.to && m.text) {
                  const existing = db.query("SELECT id FROM messages WHERE at = ? AND toUrl = ? AND text = ?").get(m.at, m.to, m.text);
                  if (!existing) {
                    db.query("INSERT INTO messages (at, platform, toUrl, text, status, error, jobId) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
                      m.at, m.platform || "ig", m.to, m.text, m.status || "sent", m.error || null, m.jobId || null
                    );
                    messagesImported++;
                  }
                }
              } catch {}
            }
          })();
        }
        db.close();
        console.log(JSON.stringify({ contactsImported, messagesImported, source: sourceDir }));
      }
    } catch (error) { printError(error); }
  }
}

const command: Command = { ...meta, run };
export default command;
