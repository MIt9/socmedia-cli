import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stateDir, extensionPath, extensionVersion, PINNED_EXTENSION_ID } from "./state";

declare const EXT_BUNDLE_JSON: string | undefined;

export function bundledExtension() {
  let manifest: any;
  let sourceFiles: Record<string, Buffer> | null = null;
  if (typeof EXT_BUNDLE_JSON !== "undefined") {
    sourceFiles = Object.fromEntries(
      Object.entries(JSON.parse(EXT_BUNDLE_JSON) as Record<string, string>).map(([k, v]) => [k, Buffer.from(v, "base64")])
    );
    manifest = JSON.parse(sourceFiles["manifest.json"]!.toString("utf8"));
  } else {
    const source = fileURLToPath(new URL("../../extension/", import.meta.url));
    manifest = JSON.parse(readFileSync(join(source, "manifest.json"), "utf8"));
  }
  const id = typeof manifest.key === "string" && manifest.key
    ? [...createHash("sha256").update(Buffer.from(manifest.key, "base64")).digest("hex").slice(0, 32)].map((nibble) => String.fromCharCode(97 + parseInt(nibble, 16))).join("")
    : null;
  return { manifest, sourceFiles, id };
}
// Extension identity shown by status: the ID Chrome derives from the manifest key, and whether it is the pinned one.
export const extensionIdentity = () => { const { id } = bundledExtension(); return { extensionId: id, extensionPinned: id === PINNED_EXTENSION_ID }; };

export function installExtension() {
  const { manifest, sourceFiles, id } = bundledExtension();
  if (manifest.version !== extensionVersion || !id) throw new Error("Extension manifest version or public key is invalid");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  if (existsSync(extensionPath) && !lstatSync(extensionPath).isDirectory()) throw new Error("Extension path exists and is not a directory");
  const staged = mkdtempSync(join(stateDir, ".extension-install-"));
  const backup = `${staged}-previous`;
  let movedPrevious = false;
  try {
    if (sourceFiles) {
      for (const [rel, buf] of Object.entries(sourceFiles)) {
        const dest = join(staged, rel);
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, buf);
      }
    } else {
      const source = fileURLToPath(new URL("../../extension/", import.meta.url));
      for (const file of ["manifest.json", "background.js", "yt-judge.js", "popup.html", "popup.js", "README.md"]) cpSync(join(source, file), join(staged, file));
      cpSync(join(source, "icons"), join(staged, "icons"), { recursive: true });
    }
    if (existsSync(extensionPath)) { renameSync(extensionPath, backup); movedPrevious = true; }
    try { renameSync(staged, extensionPath); }
    catch (error) { if (movedPrevious) renameSync(backup, extensionPath); throw error; }
    if (movedPrevious) rmSync(backup, { recursive: true, force: true });
  } finally { rmSync(staged, { recursive: true, force: true }); }
  return { path: extensionPath, id, steps: ["Open chrome://extensions and enable Developer mode", "Choose Load unpacked", `Select ${extensionPath}`] };
}
export const compatibleVersion = (version: string) => {
  const requested = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  const current = /^(\d+)\.(\d+)\.(\d+)$/.exec(extensionVersion);
  return !!requested && !!current && requested[1] === current[1] && requested[2] === current[2];
};
