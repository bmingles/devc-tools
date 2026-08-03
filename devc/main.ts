// devc — selectively bind-mount sibling projects (and agent skill folders) into the
// current devcontainer, and mirror the selection into the VS Code workspace file.
//
// Run it from the host, in the repo you want to configure:
//
//   devc list                                   what's under the configured root
//   devc select projectb.worktrees/some-other    mount it + add it to the workspace
//   devc deselect projectb.worktrees/some-other  take it back out
//   devc status                                  where the files are, what's in the fences
//
// devc only ever rewrites its three comment-fenced blocks:
// `devc:projects` / `devc:skills` in the devcontainer's `mounts`, and
// `devc:folders` in the workspace file's `folders`. Everything else in those files —
// comments, formatting, keys it knows nothing about — is preserved byte-for-byte.
//
// This file owns argv only: the subcommands live in cli.ts and the interactive tree — what
// you get with no subcommand at all — lives in tui/.

import {
  cmdApply,
  cmdConfigInit,
  cmdConfigPath,
  cmdConfigShow,
  cmdList,
  cmdSelect,
  cmdSkills,
  cmdSkillsList,
  cmdStatus,
  consoleIo,
  DEFAULT_OPTIONS,
  type Io,
  type Options,
} from "./cli.ts";
import { RuntimeError, UsageError } from "./config.ts";
import { startTui } from "./tui/app.ts";

export const USAGE = `usage: devc [command] [options]

commands:
  (none)                      open the interactive project tree
  list                        show the projects under the configured root
  status                      show resolved config, target files, and fence entry counts
  select <id>...              add projects (or worktrees) to the selection, then apply
  deselect <id>...            remove projects from the selection, then apply
  apply                       rewrite all three fences from the current selection
  skills list                 show the skill dirs under the configured skillsRoot
  skills enable <name>...     mount skill dirs, then apply
  skills disable <name>...    unmount skill dirs, then apply
  config show|path|init       print the resolved config / its path / create it

options:
  --workspace-dir <path>      repo to configure (default: cwd)
  --root <path>               override the configured root
  --config <path>             override the config file path
  --create                    create the devcontainer file if it is missing
  --dry-run                   print a unified diff instead of writing
  --json                      machine-readable output
  --no-color                  never emit ANSI colour
  -h, --help                  this text`;

/** Global flags that take a value. */
const VALUE_FLAGS: Record<string, keyof Options> = {
  "--workspace-dir": "workspaceDir",
  "--root": "root",
  "--config": "config",
};

/** Global boolean flags. */
const BOOL_FLAGS: Record<string, keyof Options> = {
  "--dry-run": "dryRun",
  "--json": "json",
  "--no-color": "noColor",
  "--create": "create",
};

export interface ParsedArgs {
  opts: Options;
  args: string[];
  help: boolean;
}

/** Split argv into global flags (accepted anywhere) and positional arguments. */
export function parseArgs(argv: string[]): ParsedArgs {
  const opts: Options = { ...DEFAULT_OPTIONS };
  const args: string[] = [];
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      help = true;
      continue;
    }
    const valueKey = VALUE_FLAGS[arg];
    if (valueKey !== undefined) {
      const value = argv[++i];
      if (value === undefined) throw new UsageError(`devc: ${arg} needs a value`);
      (opts[valueKey] as string) = value;
      continue;
    }
    const eq = arg.indexOf("=");
    if (arg.startsWith("--") && eq !== -1 && VALUE_FLAGS[arg.slice(0, eq)] !== undefined) {
      (opts[VALUE_FLAGS[arg.slice(0, eq)]] as string) = arg.slice(eq + 1);
      continue;
    }
    const boolKey = BOOL_FLAGS[arg];
    if (boolKey !== undefined) {
      (opts[boolKey] as boolean) = true;
      continue;
    }
    if (arg.startsWith("-") && arg !== "-") {
      throw new UsageError(`devc: unknown option ${JSON.stringify(arg)}`);
    }
    args.push(arg);
  }
  return { opts, args, help };
}

export interface RunDeps {
  /**
   * Launches the interactive tree (no subcommand). Injectable so tests can drive the
   * non-TTY refusal deterministically, whatever stdin happens to be.
   */
  tui?: (opts: Options, io: Io) => Promise<number>;
}

/** Dispatch one invocation. Returns the process exit code; never throws for known errors. */
export async function run(
  argv: string[],
  io: Io = consoleIo,
  deps: RunDeps = {},
): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (e) {
    return fail(e, io);
  }
  const { opts, args, help } = parsed;
  if (help) {
    io.out(USAGE);
    return 0;
  }
  if (args.length === 0) {
    try {
      return await (deps.tui ?? startTui)(opts, io);
    } catch (e) {
      return fail(e, io);
    }
  }
  try {
    return await dispatch(args, opts, io);
  } catch (e) {
    return fail(e, io);
  }
}

async function dispatch(args: string[], opts: Options, io: Io): Promise<number> {
  const [sub, ...rest] = args;
  switch (sub) {
    case "list":
      return await cmdList(opts, io);
    case "status":
      return await cmdStatus(opts, io);
    case "select":
      return await cmdSelect(opts, io, rest, true);
    case "deselect":
      return await cmdSelect(opts, io, rest, false);
    case "apply":
      return await cmdApply(opts, io);
    case "skills":
      return await dispatchSkills(rest, opts, io);
    case "config":
      return await dispatchConfig(rest, opts, io);
    default:
      io.err(`devc: unknown command ${JSON.stringify(sub)}`);
      io.err(USAGE);
      return 2;
  }
}

async function dispatchSkills(args: string[], opts: Options, io: Io): Promise<number> {
  const [sub, ...rest] = args;
  switch (sub) {
    case undefined:
    case "list":
      return await cmdSkillsList(opts, io);
    case "enable":
      return await cmdSkills(opts, io, rest, true);
    case "disable":
      return await cmdSkills(opts, io, rest, false);
    default:
      io.err(`devc: unknown skills subcommand ${JSON.stringify(sub)}`);
      io.err(USAGE);
      return 2;
  }
}

async function dispatchConfig(args: string[], opts: Options, io: Io): Promise<number> {
  const [sub] = args;
  switch (sub) {
    case undefined:
    case "show":
      return await cmdConfigShow(opts, io);
    case "path":
      return cmdConfigPath(opts, io);
    case "init":
      return await cmdConfigInit(opts, io);
    default:
      io.err(`devc: unknown config subcommand ${JSON.stringify(sub)}`);
      io.err(USAGE);
      return 2;
  }
}

/** Usage/config problems exit 2; everything else exits 1 (with a stack if it's a bug). */
function fail(e: unknown, io: Io): number {
  if (e instanceof UsageError) {
    io.err(e.message);
    return 2;
  }
  if (e instanceof RuntimeError) {
    io.err(e.message);
    return 1;
  }
  if (e instanceof Error && e.message.startsWith("devc:")) {
    io.err(e.message);
    return 1;
  }
  io.err("devc: unexpected failure");
  io.err(String(e instanceof Error ? (e.stack ?? e.message) : e));
  return 1;
}

if (import.meta.main) {
  Deno.exit(await run(Deno.args));
}
