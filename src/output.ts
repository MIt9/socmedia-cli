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

  process.exitCode = 1;
  if (fmt === "json") {
    console.error(JSON.stringify({ error: message, hint, ...(code ? { code } : {}) }));
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

export const COMMAND_REGISTRY: CommandMeta[] = [
  {
    name: "service",
    usage: "socmedia service <start|status|stop|resume> [options]",
    summary: "Start or inspect the local service",
    commands: [
      { name: "start", summary: "Start the local service or return the running service" },
      { name: "status", summary: "Show service, halted state and extension connection status" },
      { name: "stop", summary: "Stop the local service; succeed if already stopped" },
      { name: "resume", summary: "Resume the queue after manually resolving a login or security challenge" },
    ],
    options: [
      { flag: "--json", description: "Print the result as JSON" },
      { flag: "--text", description: "Print the result as plain text" },
      { flag: "--help", description: "Show this help message" },
    ],
  },
  {
    name: "queue",
    usage: "socmedia queue <list|get|cancel|enqueue> [options]",
    summary: "Inspect or manage the service queue",
    commands: [
      { name: "list", summary: "List saved queue jobs" },
      { name: "get <id>", summary: "Show a job by its positive numeric ID" },
      { name: "cancel <id>", summary: "Cancel a queued job by ID" },
      { name: "enqueue <action>", summary: "Queue an action; readPage, snapshot and Instagram/Facebook getProfile execute" },
    ],
    options: [
      { flag: "--args JSON", description: "Action arguments as a JSON object (default: {})" },
      { flag: "--not-before TIME", description: "Earliest run time as an ISO date" },
      { flag: "--key KEY", description: "Reuse the same job; changed action, args or time causes a key conflict" },
      { flag: "--json", description: "Print the result as JSON" },
      { flag: "--text", description: "Print the result as plain text" },
      { flag: "--help", description: "Show this help message" },
    ],
  },
  {
    name: "tabs",
    usage: "socmedia tabs <list|use|clear> [options]",
    summary: "Inspect extension work tabs",
    commands: [
      { name: "list", summary: "List Socmedia CLI group tabs and the selected tab" },
      { name: "use <tabId>", summary: "Select an open Instagram, Facebook or YouTube tab by its numeric ID" },
      { name: "clear", summary: "Clear the selected tab and return to the Socmedia CLI group" },
    ],
    options: [
      { flag: "--json", description: "Print the result as JSON" },
      { flag: "--text", description: "Print the result as plain text" },
      { flag: "--help", description: "Show this help message" },
    ],
  },
  {
    name: "profile",
    usage: "socmedia profile <get|posts|download> <url> [options]",
    summary: "Read a social profile",
    commands: [
      { name: "get <url>", summary: "Read an Instagram or Facebook profile/page via its HTTPS URL" },
      { name: "posts <url>", summary: "List posts from an Instagram or Facebook profile/page" },
      { name: "download <url>", summary: "Collect profile, screenshot, posts and media into ~/socmedia-data" },
    ],
    options: [
      { flag: "--limit N", description: "With posts or download, maximum posts from 1 to 100 (default: 12)" },
      { flag: "--details", description: "With download, fetch details of each post (default: true)" },
      { flag: "--no-details", description: "Skip post detail fetch" },
      { flag: "--max-media N", description: "With download, maximum media files from 0 to 300 (default: 50)" },
      { flag: "--dir PATH", description: "With download, custom destination inside home" },
      { flag: "--background", description: "With download, run in background via service queue" },
      { flag: "--json", description: "Print the result as JSON" },
      { flag: "--text", description: "Print the result as plain text" },
      { flag: "--help", description: "Show this help message" },
    ],
  },
  {
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
  },
  {
    name: "post",
    usage: "socmedia post <get|comments> <url> [options]",
    summary: "Inspect a social post",
    commands: [
      { name: "get <url>", summary: "Read a post from Instagram or Facebook" },
      { name: "comments <url>", summary: "Read Instagram or Facebook post comments" },
    ],
    options: [
      { flag: "--download", description: "With get, download media files to ~/socmedia-data" },
      { flag: "--slides", description: "Alias for --download" },
      { flag: "--limit N", description: "With comments, maximum comments from 1 to 500 (default: 20)" },
      { flag: "--json", description: "Print the result as JSON" },
      { flag: "--text", description: "Print the result as plain text" },
      { flag: "--help", description: "Show this help message" },
    ],
  },
  {
    name: "page",
    usage: "socmedia page <read|snapshot> [options]",
    summary: "Inspect the work page",
    commands: [
      { name: "read", summary: "Queue and return visible page text and URL" },
      { name: "snapshot", summary: "Queue and return visible interactive elements" },
    ],
    options: [
      { flag: "--max-lines N", description: "With read, limit output to 1-1000 lines (default: 200)" },
      { flag: "--json", description: "Print the result as JSON" },
      { flag: "--text", description: "Print the result as plain text" },
      { flag: "--help", description: "Show this help message" },
    ],
  },
  {
    name: "screenshot",
    usage: "socmedia screenshot [options]",
    summary: "Take a screenshot of the work page",
    options: [
      { flag: "--url URL", description: "Navigate to URL first" },
      { flag: "--selector SEL", description: "CSS selector to crop" },
      { flag: "--target TARGET", description: "viewport, post, or profile (default: viewport)" },
      { flag: "--path PATH", description: "Output file destination inside home" },
      { flag: "--json", description: "Print the result as JSON" },
      { flag: "--text", description: "Print the result as plain text" },
      { flag: "--help", description: "Show this help message" },
    ],
  },
  {
    name: "search",
    usage: "socmedia search <platform> <query> [options]",
    summary: "Search on Instagram or Facebook",
    options: [
      { flag: "--type TYPE", description: "users, hashtag, pages, places (default: users)" },
      { flag: "--limit N", description: "Maximum results from 1 to 50 (default: 20)" },
      { flag: "--json", description: "Print the result as JSON" },
      { flag: "--text", description: "Print the result as plain text" },
      { flag: "--help", description: "Show this help message" },
    ],
  },
  {
    name: "config",
    usage: "socmedia config <get|set|unset> port [value] [options]",
    summary: "Configure the service",
    commands: [
      { name: "get port", summary: "Show the effective port and configuration source" },
      { name: "set port <value>", summary: "Save a port from 1 to 65535" },
      { name: "unset port", summary: "Remove the saved port" },
    ],
    options: [
      { flag: "--json", description: "Print the result as JSON" },
      { flag: "--text", description: "Print the result as plain text" },
      { flag: "--help", description: "Show this help message" },
    ],
  },
  {
    name: "extension",
    usage: "socmedia extension <install|path|pair> [options]",
    summary: "Pair the Chrome extension",
    commands: [
      { name: "install", summary: "Copy the extension to its stable state directory and show Chrome setup steps" },
      { name: "path", summary: "Show the stable extension directory" },
      { name: "pair", summary: "Generate a pairing secret for the Chrome extension" },
    ],
    options: [
      { flag: "--open", description: "With install, open chrome://extensions in Google Chrome" },
      { flag: "--id ID", description: "With pair, set the Chrome extension ID" },
      { flag: "--json", description: "Print the result as JSON; pairing output contains a sensitive secret" },
      { flag: "--text", description: "Print the result as plain text" },
      { flag: "--help", description: "Show this help message" },
    ],
  },
  {
    name: "inbox",
    usage: "socmedia inbox <list|read> [options]",
    summary: "List and read inbox threads",
    commands: [
      { name: "list <platform>", summary: "List conversation threads from Instagram or Facebook" },
      { name: "read", summary: "Read messages from a thread by URL or recipient profile" },
    ],
    options: [
      { flag: "--url URL", description: "Thread URL on Instagram or Facebook" },
      { flag: "--to PROFILE", description: "Recipient profile URL to open thread" },
      { flag: "--limit N", description: "Maximum threads or messages to fetch (default: 20 for list, 30 for read)" },
      { flag: "--json", description: "Print the result as JSON" },
      { flag: "--text", description: "Print the result as plain text" },
      { flag: "--help", description: "Show this help message" },
    ],
  },
  {
    name: "message",
    usage: "socmedia message send --to URL --text TEXT [--confirm] [options]",
    summary: "Send direct messages",
    commands: [
      { name: "send", summary: "Send a direct message via Instagram or Facebook" },
    ],
    options: [
      { flag: "--to URL", description: "Recipient profile or direct thread URL" },
      { flag: "--text TEXT", description: "Message content (max 1000 characters)" },
      { flag: "--confirm", description: "Confirm send; without this flag, returns a dry-run preview" },
      { flag: "--json", description: "Print the result as JSON" },
      { flag: "--text", description: "Print the result as plain text" },
      { flag: "--help", description: "Show this help message" },
    ],
  },
  {
    name: "youtube",
    usage: "socmedia youtube <channel|studio status|upload|video update> [options]",
    summary: "Manage YouTube Studio and channels",
    commands: [
      { name: "channel", summary: "Inspect the configured YouTube channel allowlist" },
      { name: "studio status", summary: "Read YouTube Studio tab state and verify against allowlist" },
      { name: "upload FILE", summary: "Upload video to YouTube Studio (draft private video)" },
      { name: "video update ID", summary: "Update video metadata (title, description, privacy)" },
    ],
    options: [
      { flag: "--channel KEY", description: "Channel key from youtube.json allowlist" },
      { flag: "--open", description: "With studio status, navigate to Studio URL" },
      { flag: "--title TEXT", description: "Video title" },
      { flag: "--description TXT", description: "Video description" },
      { flag: "--privacy PRIV", description: "Video privacy: private, unlisted, public" },
      { flag: "--confirm", description: "Confirm write action; without this flag, returns preview" },
      { flag: "--json", description: "Print the result as JSON" },
      { flag: "--text", description: "Print the result as plain text" },
      { flag: "--help", description: "Show this help message" },
    ],
  },
  {
    name: "browser",
    usage: "socmedia browser <click|scroll> [options]",
    summary: "Interact with page via click or scroll",
    commands: [
      { name: "click", summary: "Click an interactive element by index, selector or text" },
      { name: "scroll", summary: "Scroll page or container down" },
    ],
    options: [
      { flag: "--index N", description: "Element index from snapshot" },
      { flag: "--selector SEL", description: "CSS selector to target" },
      { flag: "--text TEXT", description: "Visible text of element to click" },
      { flag: "--times N", description: "Number of times to scroll (1-20, default: 3)" },
      { flag: "--json", description: "Print the result as JSON" },
      { flag: "--text", description: "Print the result as plain text" },
      { flag: "--help", description: "Show this help message" },
    ],
  },
  {
    name: "doctor",
    usage: "socmedia doctor [options]",
    summary: "Check system health, permissions, services, and extension status",
    options: [
      { flag: "--json", description: "Print the result as JSON" },
      { flag: "--text", description: "Print the result as plain text" },
      { flag: "--help", description: "Show this help message" },
    ],
  },
  {
    name: "update",
    usage: "socmedia update [--check] [options]",
    summary: "Check for or install socmedia CLI updates",
    options: [
      { flag: "--check", description: "Check for updates without downloading or installing" },
      { flag: "--json", description: "Print the result as JSON" },
      { flag: "--text", description: "Print the result as plain text" },
      { flag: "--help", description: "Show this help message" },
    ],
  },
];

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

export function formatRootHelp(): string {
  const lines: string[] = [];
  lines.push("Usage: socmedia [options]\n");
  lines.push("Commands:");
  for (const cmd of COMMAND_REGISTRY) {
    lines.push(`  ${cmd.name.padEnd(12)} ${cmd.summary}`);
  }
  lines.push("\nOptions:");
  lines.push("  --version    Show the CLI version");
  lines.push("  --help       Show this help message");
  lines.push("  --json       Print the result as JSON");
  lines.push("  --text       Print the result as plain text");
  return lines.join("\n");
}
