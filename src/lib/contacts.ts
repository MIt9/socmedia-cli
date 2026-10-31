import { closeSync, constants, lstatSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomBytes } from "node:crypto";
import type { Database } from "bun:sqlite";
import { csvCell } from "../output";
import { profileUrl } from "../media";
import { stateDir } from "./state";
import { contactColumns } from "./validate";

export function exportContactFile(path: unknown, format: string, contacts: Record<string, unknown>[]) {
  if (path !== undefined && (typeof path !== "string" || !path)) throw new Error("Export path must be a nonempty string");
  const home = resolve(homedir());
  const input = path === undefined ? join("socmedia-data", `contacts-${new Date().toISOString().slice(0, 10)}.${format}`) : (path as string).replace(/^~(?=\/|$)/, home);
  const file = resolve(home, input);
  const rel = relative(home, file);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("Export path must be inside home");
  let current = home;
  const parents = dirname(rel).split(sep).filter((part) => part && part !== ".");
  for (const part of parents) {
    current = join(current, part);
    try {
      const entry = lstatSync(current);
      if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error("Export directories must not be symbolic links");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      mkdirSync(current, { mode: 0o700 });
    }
  }
  try {
    const entry = lstatSync(file);
    if (entry.isSymbolicLink() || !entry.isFile()) throw new Error("Export destination must be a regular file, not a symbolic link");
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const serviceFiles = ["state.sqlite", "state.sqlite-wal", "state.sqlite-shm", "extension-pairing.json", "config.json", "service.lock", "service.sock"];
  if (serviceFiles.some((name) => file === resolve(stateDir, name))) throw new Error("Export destination conflicts with service state");
  const output = format === "json" ? JSON.stringify(contacts, null, 2)
    : format === "jsonl" ? contacts.map((contact) => JSON.stringify(contact) + "\n").join("")
      : [contactColumns, ...contacts.map((contact) => contactColumns.map((column) => contact[column]))].map((row) => row.map(csvCell).join(",")).join("\n") + "\n";
  const temporary = join(dirname(file), `.contacts-export-${randomBytes(12).toString("hex")}`);
  let fd: number | undefined;
  try {
    fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    writeFileSync(fd, output); closeSync(fd); fd = undefined;
    renameSync(temporary, file);
  } finally { if (fd !== undefined) closeSync(fd); rmSync(temporary, { force: true }); }
  return { path: file, count: contacts.length };
}

export function upsertProfileContact(db: Database, value: unknown, requestedUrl: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid social profile result");
  const profile = value as Record<string, any>;
  const canonical = profileUrl(requestedUrl);
  const parsed = new URL(canonical);
  const platform = parsed.hostname === "www.instagram.com" ? "ig" : "fb";
  if (profile.platform !== platform || typeof profile.url !== "string" || profileUrl(profile.url).toLowerCase() !== canonical.toLowerCase()) throw new Error("Social profile result does not match requested profile");
  const path = parsed.pathname.replace(/^\/+|\/+$/g, "");
  const rel = platform === "fb" && path.toLowerCase() === "profile.php" ? `${path}?id=${parsed.searchParams.get("id")}` : path;
  const id = `${platform}:${rel.toLowerCase()}`;
  const row = db.query("SELECT data FROM contacts WHERE id = ?").get(id) as { data: string } | null;
  const existing = row ? JSON.parse(row.data) : null;
  const fields = {
    id, platform, url: `${parsed.origin}/${rel}`, username: profile.username,
    name: profile.name, bio: profile.bio, website: profile.website, category: profile.category,
    followers: profile.followers, following: profile.following, postsCount: profile.postsCount,
    verified: profile.verified, private: profile.private, isBusiness: profile.isBusiness,
    email: profile.contact?.email, phone: profile.contact?.phone,
  };
  const present = Object.fromEntries(Object.entries(fields).filter(([, value]) => value != null && value !== ""));
  const now = new Date().toISOString();
  const contact = existing ? { ...existing, ...present, id, firstSeen: existing.firstSeen, status: existing.status, lastSeen: now } : { status: "new", firstSeen: now, ...present, id, lastSeen: now };
  db.query("INSERT INTO contacts (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data=excluded.data").run(id, JSON.stringify(contact));
}
