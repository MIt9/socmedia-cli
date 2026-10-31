# Contributing

Bun + TypeScript. `bun test` and `bun run typecheck` must both be clean before anything is handed over. Tests are offline and use throwaway state dirs and port 0 (never `~/.socmedia-cli`, never the running service).

## 1. How dispatch works (map)

### Before the refactor (git 9e8274f, v0.16.1) - for reference

`src/cli.ts` was one 1858-line top-level script:

| What | Where at 9e8274f |
|---|---|
| shared state (paths, `CliError`) | `src/cli.ts:43-65` |
| port/process helpers, YouTube + port config, extension install, validators (`validateJob`, `postUrl`, message checks), contact export/upsert | `src/cli.ts:67-381`, `383-517` |
| service client (`status`, `start`, `stop`, `queueRequest`, `runPageJob`) | `src/cli.ts:519-682` |
| service daemon (inline inside `if (argv[2] === "--service-daemon")`) | `src/cli.ts:710-1173` |
| `--version`, `--help [--json]` | `src/cli.ts:1174`, `1177-1196` |
| command dispatch: one `else if (Bun.argv[2] === "..." && Bun.argv[3] === "...")` per sub-command | `src/cli.ts:1197-1828` |
| help data (`COMMAND_REGISTRY`) | `src/output.ts:80-358` |

### Now

Flow: `src/cli.ts` -> `src/commands/index.ts` -> `src/commands/<name>.ts` -> `src/lib/*` -> (socket) -> `src/service.ts` -> (WebSocket) -> `extension/background.js`.

| Piece | File |
|---|---|
| Bootstrap only: `--service-daemon`, `--version`, `--help`, else dispatch; plus re-exports tests import | `src/cli.ts:26-35` |
| The dispatch table `COMMANDS` (order = order in `--help`), `COMMAND_REGISTRY` (help data without runners), `printHelp`, `dispatch` | `src/commands/index.ts:23` (`COMMANDS`), `:26` (`COMMAND_REGISTRY`), `:43` (`printHelp`), `:55` (`dispatch`) |
| Command type: help data (`CommandMeta`) + `run(argv)`. `argv` is the full process argv (`[exe, script, command, sub, ...]`, same as `Bun.argv`) | `src/commands/types.ts`, `src/output.ts:72` |
| One module per top-level command, default-exporting `{...meta, run}` | `src/commands/<name>.ts` (17 modules) |
| State dir, socket/lock paths, `CliError`, `PINNED_EXTENSION_ID` | `src/lib/state.ts` |
| Port/YouTube config read/write | `src/lib/config.ts` |
| Extension bundle, install, major.minor compatibility | `src/lib/extension.ts` (`compatibleVersion` at `:56`) |
| Validators: `actions` allow-list (`:3`), `postUrl` (`:47`), `validateJob` (`:97`), message checks | `src/lib/validate.ts` |
| Contact export/upsert | `src/lib/contacts.ts` |
| Service client: `status` (`:31`), `start` (`:83`), `stop` (`:104`), `queueRequest` (`:131`), `runPageJob` (`:162`) | `src/lib/client.ts` |
| Service daemon (UNIX socket commands e.g. `queue enqueue` at `:396`, `queue get` at `:388`; extension WebSocket; SQLite; HALT) | `src/service.ts` (single module on purpose) |
| Output format (`--json`/`--text`/TTY), `printError`, exit codes | `src/output.ts` |

Unknown top-level commands are a silent no-op (unchanged behaviour); each command module decides what an unknown sub-command does.

Help is the single source of truth: `meta` in each module feeds `socmedia <cmd> --help`, `--help --json`, and the tests in `tests/command-table.test.ts` (help data complete, every module registered, every command in `COMMANDS.md` and in the skill) and `tests/skill-parity.test.ts`. Flag ranges and defaults live in the flag description text (`"... from 1 to 100 (default: 12)"`).

## 2. Add a command (or a platform)

Scaffold first (offline, refuses to overwrite):

```sh
bun scripts/new-command.ts <name>      # lowercase letters/digits
```

Then, in order:

1. **Test first (TDD).** Replace the `test.todo` in `tests/<name>.test.ts` with failing tests (validation errors, preview without `--confirm`, happy path). Offline: temp `SOCMEDIA_STATE_DIR`, `SOCMEDIA_EXTENSION_PORT=0`.
2. **Module** `src/commands/<name>.ts`: implement `run(argv)`. Parse and validate arguments there; reusable validators/clients go to `src/lib/*.ts`. Errors: `printError(error)` (JSON in a pipe, `Error:`/`Hint:` in a terminal). Results: `printOutput` or `console.log(JSON.stringify(...))` like the neighbours.
3. **Register** it in `src/commands/index.ts` (import + one entry in `COMMANDS`). Forgetting this fails `tests/command-table.test.ts`.
4. **Help data** in the module's `meta`: `usage` starts with `socmedia <name>`, `summary`, `commands[]`, `options[]` (include `--json`, `--text`, `--help`; ranges/defaults in the description).
5. **COMMANDS.md**: a row containing `` `socmedia <name>` `` (what it returns, side effects, what was verified live).
6. **Skill**: a section in `skills/socmedia-cli-usage/SKILL.md` mentioning `socmedia <name>`. Examples show the preview form only, never `--confirm`.
7. **Outward actions** (post, message, upload...): preview by default, `--confirm` to execute, limits and pauses live in the service, an interrupted action is `unverified` and never retried.
8. **Version bump** (user-visible change): the same new version in `package.json` AND `extension/manifest.json`. `scripts/build.ts:38` refuses a build when major.minor differ.
9. `bun test && bun run typecheck`.
10. **Live check** with real Chrome (`socmedia doctor`, `service status` shows matching versions and `extensionId`, one real command). 
11. **Honest unverified list** in the hand-over: everything that did not run through a live Chrome / real platform goes into README "Що не перевірено наживо" and the report. Do not claim what is not in code or tests.

A new **platform** (e.g. a third site beside Instagram/Facebook) is the same checklist plus: URL validators in `src/lib/validate.ts` (reject non-HTTPS, credentials, odd ports), host allow-list in the extension `manifest.json` permissions, page logic in `extension/background.js`, and the platform name in the relevant `meta` option text.

Do not commit, tag, push or release as part of a change; that is a separate, explicit decision.

## 3. Add an extension action

The service sends `{type:"request", id, action, args}` over the authenticated WebSocket; `extension/background.js` runs it in the "Socmedia CLI" tab group and replies `{type:"result", id, result|error}`.

1. **Handler** in `extension/background.js`: a function taking `args`; for checkpoints/captcha throw an Error with `code = "HALT"` and `reason` (`extension/background.js:106-107`; relayed at `:1250`) so the service halts the queue.
2. **Wire it** in the request branch of the WebSocket `onmessage` in `extension/background.js` (the `message.action === ...` allow-list condition and the dispatch ternary right below it, around `:1246-1248`). Unlisted actions are ignored.
3. **Service side**: add the action to `actions` in `src/lib/validate.ts:3`, a branch in `validateJob` (`:97`, reject unknown keys, bound numbers), the union in `runPageJob` (`src/lib/client.ts:162`, plus its timeout), and, if the service restarts/requeues jobs by action, the lists in `src/service.ts` (`grep "IN ('readPage'"`). Actions with side effects must follow the existing `sendMessage` handling (`grep sendMessage src/service.ts`), not be silently retried.
4. **CLI**: a command (section 2) that calls `runPageJob("<action>", args)`.
5. **Protocol/version rule**: service and extension are compatible only when `major.minor` match (`compatibleVersion`, `src/lib/extension.ts:56`; the service answers `compatible` in its `hello`; `runPageJob` fails with "Extension version incompatible", `src/lib/client.ts:171`). An action an older extension does not know must therefore ship with a **minor** bump (old extensions are then reported incompatible instead of receiving an unknown action); a patch bump is only for changes both sides tolerate. Bump `package.json` and `extension/manifest.json` together.
6. **Tests**: follow the existing tests that load `extension/background.js` as text/mocks (`grep -n "background.js" tests/cli.test.ts`) and the fake-extension WebSocket tests; assert the handler is wired and the service rejects bad args.
7. **Live check**: reload the extension at `chrome://extensions` (or `socmedia update`, which asks the extension to reload), confirm `service status` shows matching versions, run the action on a real page. Anything not done live is listed as unverified.
