import { join } from "node:path";
import { homedir } from "node:os";
import packageInfo from "../../package.json";

export const stateDir = process.env.SOCMEDIA_STATE_DIR ?? join(homedir(), ".socmedia-cli");
export const socketPath = join(stateDir, "service.sock");
export const lockPath = join(stateDir, "service.lock");
export const identity = "socmedia-service-v1";
export const pairingPath = join(stateDir, "extension-pairing.json");
export const configPath = join(stateDir, "config.json");
export const youtubeConfigPath = join(stateDir, "youtube.json");
export const extensionVersion = packageInfo.version;
export const extensionPath = join(stateDir, "extension");
export const PINNED_EXTENSION_ID = "ingpbbhdgldgomideaihffffiinjgifj";

export class CliError extends Error {
  hint?: string;
  code?: string;
  extra?: Record<string, unknown>;
  constructor(message: string, hint?: string, code?: string, extra?: Record<string, unknown>) {
    super(message);
    this.extra = extra;
    this.name = "CliError";
    this.hint = hint;
    this.code = code;
  }
}
