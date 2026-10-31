import { existsSync, readFileSync, statSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";

export type DoctorCheck = {
  check: string;
  ok: boolean;
  message: string;
  fix: string | null;
  code?: string;
};

export type DoctorContext = {
  stateDir: string;
  extensionPath: string;
  extensionVersion: string;
  status: () => Promise<{
    running: boolean;
    pid?: number;
    version?: string;
    extension?: unknown;
    port: number;
    pinnedId: string;
    portInUse?: boolean;
    code?: string;
  }>;
  isPortInUse: (port: number) => Promise<boolean>;
};

export async function runDoctor(ctx: DoctorContext): Promise<{ ok: boolean; checks: DoctorCheck[] }> {
  const checks: DoctorCheck[] = [];

  // 1. Chrome presence
  const chromePaths = [
    "/Applications/Google Chrome.app",
    "/Applications/Chromium.app",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
  ];
  if (process.env.LOCALAPPDATA) {
    chromePaths.push(join(process.env.LOCALAPPDATA, "Google/Chrome/Application/chrome.exe"));
  }
  const chromeFound = chromePaths.some((p) => existsSync(p));
  checks.push({
    check: "chrome",
    ok: chromeFound,
    message: chromeFound ? "Google Chrome detected" : "Google Chrome not found in standard paths",
    fix: chromeFound ? null : "Install Google Chrome",
  });

  // 2. Bun runtime
  const bunOk = typeof Bun !== "undefined" && typeof Bun.version === "string";
  checks.push({
    check: "bun",
    ok: bunOk,
    message: bunOk ? `Bun v${Bun.version}` : "Bun runtime missing",
    fix: bunOk ? null : "Install Bun (https://bun.sh)",
  });

  // 3. State directory
  let stateDirOk = false;
  let stateDirMsg = "";
  try {
    if (!existsSync(ctx.stateDir)) {
      mkdirSync(ctx.stateDir, { recursive: true, mode: 0o700 });
    }
    const st = statSync(ctx.stateDir);
    const mode = st.mode & 0o777;
    if (process.platform === "win32" || mode === 0o700) {
      stateDirOk = true;
      stateDirMsg = `${ctx.stateDir} (0700)`;
    } else {
      stateDirOk = false;
      stateDirMsg = `${ctx.stateDir} mode is 0${mode.toString(8)}, expected 0700`;
    }
  } catch (err: any) {
    stateDirOk = false;
    stateDirMsg = `Cannot access ${ctx.stateDir}: ${err?.message || err}`;
  }
  checks.push({
    check: "stateDir",
    ok: stateDirOk,
    message: stateDirMsg,
    fix: stateDirOk ? null : `mkdir -p "${ctx.stateDir}" && chmod 700 "${ctx.stateDir}"`,
  });

  // 4. Database integrity
  let dbOk = false;
  let dbMsg = "";
  const dbFile = join(ctx.stateDir, "state.sqlite");
  try {
    mkdirSync(ctx.stateDir, { recursive: true, mode: 0o700 });
    const db = new Database(dbFile);
    const checkRow = db.query("PRAGMA quick_check").get() as Record<string, unknown> | null;
    const res = checkRow ? Object.values(checkRow)[0] : null;
    db.close();
    if (res === "ok") {
      dbOk = true;
      dbMsg = "SQLite database integrity verified";
    } else {
      dbOk = false;
      dbMsg = `SQLite integrity check: ${res}`;
    }
  } catch (err: any) {
    dbOk = false;
    dbMsg = `SQLite error: ${err?.message || err}`;
  }
  checks.push({
    check: "database",
    ok: dbOk,
    message: dbMsg,
    fix: dbOk ? null : `Repair or remove corrupted database at ${dbFile}`,
  });

  // 5. Port & Service
  const s = await ctx.status();
  const port = s.port;
  if (s.running) {
    checks.push({
      check: "port",
      ok: true,
      message: `Port ${port} active (socmedia service daemon)`,
      fix: null,
    });
  } else {
    const portBusy = await ctx.isPortInUse(port);
    checks.push({
      check: "port",
      ok: !portBusy,
      ...(portBusy ? { code: "PORT_IN_USE" } : {}),
      message: portBusy ? `Port ${port} in use by another process (PORT_IN_USE)` : `Port ${port} available`,
      fix: portBusy ? `Stop process using port ${port} or run socmedia config set port <port>` : null,
    });
  }

  checks.push({
    check: "service",
    ok: s.running,
    message: s.running ? `Daemon running (PID ${s.pid}, v${s.version})` : "Daemon is stopped",
    fix: s.running ? null : "Run socmedia service start",
  });

  // 6. Extension installation & version
  let extOk = false;
  let extMsg = "";
  const extManifest = join(ctx.extensionPath, "manifest.json");
  if (existsSync(extManifest)) {
    try {
      const manifest = JSON.parse(readFileSync(extManifest, "utf8"));
      if (manifest.version === ctx.extensionVersion) {
        extOk = true;
        extMsg = `Installed at ${ctx.extensionPath} (v${manifest.version})`;
      } else {
        extOk = false;
        extMsg = `Version mismatch: installed v${manifest.version}, CLI v${ctx.extensionVersion}`;
      }
    } catch (err: any) {
      extOk = false;
      extMsg = `Invalid manifest: ${err?.message || err}`;
    }
  } else {
    extOk = false;
    extMsg = `Extension not installed at ${ctx.extensionPath}`;
  }
  checks.push({
    check: "extension",
    ok: extOk,
    message: extMsg,
    fix: extOk ? null : "Run socmedia extension install",
  });

  if (s.running) {
    const ext = s.extension as { connected?: boolean; version?: string } | undefined;
    const connected = ext?.connected === true;
    checks.push({
      check: "extensionConnected",
      ok: connected,
      message: connected ? `Connected (v${ext?.version})` : "Extension not connected",
      fix: connected ? null : "Open Chrome, ensure extension is loaded at chrome://extensions, and reconnect",
    });
  }

  const allOk = checks.every((c) => c.ok);
  return { ok: allOk, checks };
}
