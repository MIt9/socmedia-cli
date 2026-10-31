import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { stateDir, configPath, youtubeConfigPath } from "./state";

export const CHANNEL_ID_RE = /^UC[\w-]{22}$/;
export function studioUrl(id: string): string {
  if (!CHANNEL_ID_RE.test(id)) throw new Error(`Bad channel id: ${id}`);
  return `https://studio.youtube.com/channel/${id}`;
}

export type YtChannelConfig = { key: string; id: string; label: string; handle: string | null; write: boolean };
export type YtConfig = { channels: Record<string, YtChannelConfig>; default: string | null; maxUploadsPerDay: number };

export function readYoutubeConfig(): YtConfig {
  try {
    const raw = JSON.parse(readFileSync(youtubeConfigPath, "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("youtube.json is not valid JSON");
    const channels: Record<string, YtChannelConfig> = {};
    for (const [key, v] of Object.entries(raw?.channels || {})) {
      const ch = v as Record<string, unknown>;
      if (!CHANNEL_ID_RE.test(String(ch?.id || ""))) throw new Error(`youtube.json: channel "${key}" has no valid channelId (UC + 22 characters)`);
      channels[key] = {
        key,
        id: String(ch.id),
        label: String(ch.label || key),
        handle: ch.handle ? String(ch.handle) : null,
        write: ch.write === true,
      };
    }
    return {
      channels,
      default: raw.default ? String(raw.default) : Object.keys(channels)[0] || null,
      maxUploadsPerDay: Number.isInteger(raw.maxUploadsPerDay) && raw.maxUploadsPerDay >= 0 ? raw.maxUploadsPerDay : 5,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { channels: {}, default: null, maxUploadsPerDay: 5 };
    }
    throw error;
  }
}

export function resolveChannel(cfg: YtConfig, keyOrId?: string): YtChannelConfig {
  if (Object.keys(cfg.channels).length === 0) throw new Error("NO_ALLOWLIST: No channels configured in youtube.json");
  if (!keyOrId) {
    const def = cfg.default && cfg.channels[cfg.default];
    if (def) return def;
    const first = Object.values(cfg.channels)[0];
    if (first) return first;
    throw new Error("NO_ALLOWLIST: No default channel configured");
  }
  const byKey = cfg.channels[keyOrId];
  if (byKey) return byKey;
  const byId = Object.values(cfg.channels).find((c) => c.id === keyOrId);
  if (byId) return byId;
  throw new Error(`NO_ALLOWLIST: Channel "${keyOrId}" is not in the allowlist`);
}

export function readConfig(): Record<string, unknown> {
  try {
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("Config must be an object");
    return config;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

export function effectivePort() {
  const config = readConfig();
  const env = process.env.SOCMEDIA_EXTENSION_PORT;
  if (env !== undefined) {
    if (!/^\d+$/.test(env) || Number(env) > 65535) throw new Error("SOCMEDIA_EXTENSION_PORT must be 0-65535");
    return { port: Number(env), source: "environment", configuredPort: config.port ?? null };
  }
  if (config.port !== undefined && (!Number.isInteger(config.port) || Number(config.port) < 1 || Number(config.port) > 65535)) throw new Error("Configured port must be an integer from 1 to 65535");
  return config.port === undefined ? { port: 47842, source: "default", configuredPort: null } : { port: Number(config.port), source: "config", configuredPort: config.port };
}

export function writeConfig(config: Record<string, unknown>) {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const temporary = join(stateDir, `.config-${randomBytes(8).toString("hex")}`);
  try { writeFileSync(temporary, JSON.stringify(config), { mode: 0o600, flag: "wx" }); renameSync(temporary, configPath); }
  finally { rmSync(temporary, { force: true }); }
}
