export const EXIT_PORT_IN_USE = 8; // documented exit code for PORT_IN_USE (all other errors exit 1)

export function getOutputFormat(): "json" | "text" {
  if (Bun.argv.includes("--json")) return "json";
  if (Bun.argv.includes("--text")) return "text";
  const env = process.env.SOCMEDIA_CLI_FORMAT?.toLowerCase();
  if (env === "json" || env === "text") return env;
  return process.stdout.isTTY ? "text" : "json";
}

export function printOutput(data: unknown, textFormatter?: () => string) {
  const fmt = getOutputFormat();
  if (fmt === "json") {
    console.log(JSON.stringify(data));
  } else if (textFormatter) {
    console.log(textFormatter());
  } else if (typeof data === "string") {
    console.log(data);
  } else {
    console.log(JSON.stringify(data, null, 2));
  }
}

export function printError(error: unknown, defaultCode?: string) {
  const fmt = getOutputFormat();
  let message = "Unknown error";
  let code = defaultCode;
  let hint: string | null = null;

  if (error instanceof Error) {
    message = error.message;
    code = (error as any).code || defaultCode;
  } else if (typeof error === "string") {
    message = error;
  } else if (typeof error === "object" && error !== null) {
    const errObj = error as Record<string, unknown>;
    message = String(errObj.message || errObj.reason || errObj.error || "Unknown error");
    code = (errObj.code as string) || defaultCode;
  }

  if (message.startsWith("HALT:")) {
    code = "HALT";
    hint = "Open Chrome, complete the challenge or login, then run: socmedia service resume";
  } else if (message.includes("PORT_IN_USE") || code === "PORT_IN_USE") {
    code = "PORT_IN_USE";
    hint = "Stop the process occupying the port or run: socmedia config set port <new-port>";
  } else if (message.includes("Extension version incompatible")) {
    hint = "Reload the unpacked extension at chrome://extensions or re-run: socmedia extension install";
  } else if (message.includes("Extension not connected")) {
    hint = "Ensure Chrome is open and extension is loaded; check status via: socmedia doctor";
  } else if (message.includes("Daily message cap reached")) {
    code = "RATE_LIMIT";
    hint = "Limit resets daily; adjust SOCMEDIA_MAX_MESSAGES_PER_DAY if higher volume is needed";
  }

  const extra = (error as { extra?: Record<string, unknown> } | null)?.extra;
  process.exitCode = code === "PORT_IN_USE" ? EXIT_PORT_IN_USE : 1;
  if (fmt === "json") {
    console.error(JSON.stringify({ error: message, hint, ...(code ? { code } : {}), ...extra }));
  } else {
    console.error(`Error: ${message}`);
    if (hint) console.error(`Hint: ${hint}`);
  }
}

export function csvCell(value: unknown) {
  let text = value == null ? "" : String(value);
  if (/^[=@\t\r]/.test(text) || (/^[+-]/.test(text) && !/^[+-]?[\d\s().-]+$/.test(text))) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export type CommandMeta = {
  name: string;
  usage: string;
  summary: string;
  commands?: { name: string; summary: string }[];
  options?: { flag: string; description: string }[];
};

export function formatCommandHelp(meta: CommandMeta): string {
  const lines: string[] = [];
  lines.push(`Usage: ${meta.usage}\n`);
  if (meta.commands && meta.commands.length > 0) {
    lines.push("Commands:");
    for (const cmd of meta.commands) {
      lines.push(`  ${cmd.name.padEnd(18)} ${cmd.summary}`);
    }
    lines.push("");
  }
  if (meta.options && meta.options.length > 0) {
    lines.push("Options:");
    for (const opt of meta.options) {
      lines.push(`  ${opt.flag.padEnd(18)} ${opt.description}`);
    }
  }
  return lines.join("\n");
}
