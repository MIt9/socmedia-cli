import type { CommandMeta } from "../output";

// One top-level command = its help data (CommandMeta) + a runner.
// `argv` is the full process argv, same shape as Bun.argv: [exe, script, command, sub, ...].
export type Command = CommandMeta & { run(argv: string[]): Promise<void> | void };
