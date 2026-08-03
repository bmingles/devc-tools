// Config file handling and target-file resolution.
//
// devc is a general-purpose tool: the "workspace dir" is whatever repo the user ran it
// in, and `root` is an unrelated host directory full of projects. Nothing here may assume
// the two are related — the workspace dir may sit inside `root`, outside it, or *be* it.

import { basename, dirname, isAbsolute, join, resolve } from "jsr:@std/path@^1";

/** A usage/config problem: the caller's fault, exit 2. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

/** A runtime problem: exit 1. */
export class RuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeError";
  }
}

/**
 * The keys holding **host** paths — `root`, `skillsRoot`, `devcontainerPath` and
 * `workspaceFile` — get `~` / `$VAR` expansion when the config is loaded.
 *
 * `containerRoot` and `skillsContainerRoot` deliberately do not: they are container-side, and
 * the container's `$HOME` is not the host's, so expanding them from this process's
 * environment would quietly produce the wrong mount target.
 */
export interface Config {
  /** Host dir scanned for projects. Empty ⇒ commands that need it fail. */
  root: string;
  /** Container-side parent for mounted projects. */
  containerRoot: string;
  /** How many levels below `root` to descend looking for projects. */
  maxDepth: number;
  /** Host dir whose immediate subdirectories are individually mountable skills. */
  skillsRoot: string;
  /** Container-side parent for mounted skills. */
  skillsContainerRoot: string;
  /** Devcontainer file, relative to the workspace dir. */
  devcontainerPath: string;
  /** Workspace file relative to the workspace dir; null ⇒ auto-detect. */
  workspaceFile: string | null;
}

export const DEFAULT_CONFIG: Config = {
  root: "",
  containerRoot: "/workspaces",
  maxDepth: 3,
  skillsRoot: "",
  skillsContainerRoot: "/home/vscode/.claude/skills",
  devcontainerPath: ".devcontainer/devcontainer.json",
  workspaceFile: null,
};

/** The devcontainer convention for where the workspace dir itself is mounted. */
export const WORKSPACE_MOUNT_ROOT = "/workspaces";

export interface LoadedConfig {
  cfg: Config;
  /** Absolute path of the config file (whether or not it existed). */
  path: string;
  /** Unknown keys, preserved so a rewrite never drops user data. */
  extra: Record<string, unknown>;
  /** True when this call created the file. */
  created: boolean;
}

/** A variable set to the empty string counts as unset, as `DEVC_TUI_CONFIG` already does. */
function envOrNull(name: string): string | null {
  const value = Deno.env.get(name);
  return value === undefined || value === "" ? null : value;
}

/**
 * Expand a host path from the config: a leading `~` or `~/`, and `$VAR` / `${VAR}` anywhere.
 * A `~` that is not the first character is a literal, exactly as in a shell.
 *
 * An unset variable throws rather than expanding to nothing: a typo that silently became
 * `/repos` would scan the wrong directory and report success.
 */
export function expandPath(value: string, key: string, cfgPath: string): string {
  const fail = (name: string): never => {
    throw new UsageError(
      `devc: config ${JSON.stringify(key)}: $${name} is not set (${displayPath(cfgPath)})`,
    );
  };

  let out = value;
  if (out === "~" || out.startsWith("~/")) {
    out = (envOrNull("HOME") ?? fail("HOME")) + out.slice(1);
  }
  return out.replace(/\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g, (_, a, b) => {
    const name = a ?? b;
    return envOrNull(name) ?? fail(name);
  });
}

/** Resolve the config file path: `--config` > `DEVC_TUI_CONFIG` > ~/.config/devc-tui. */
export function configPath(override?: string): string {
  if (override !== undefined && override !== "") return resolve(override);
  const env = Deno.env.get("DEVC_TUI_CONFIG");
  if (env !== undefined && env !== "") return resolve(env);
  const home = Deno.env.get("HOME") ?? ".";
  return join(home, ".config", "devc-tui", "config.json");
}

/**
 * Read the config, creating it with defaults when absent (that is the "first run" path —
 * every command does it, not just `config init`). Creation is best-effort: a read-only home
 * must not stop `config show` from working.
 */
export async function loadConfig(override?: string): Promise<LoadedConfig> {
  const path = configPath(override);
  let raw: Record<string, unknown> | null = null;
  let created = false;
  try {
    const text = await Deno.readTextFile(path);
    const parsed = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new UsageError(`devc: ${displayPath(path)} is not a JSON object`);
    }
    raw = parsed as Record<string, unknown>;
  } catch (e) {
    if (e instanceof UsageError) throw e;
    if (!(e instanceof Deno.errors.NotFound)) {
      if (e instanceof SyntaxError) {
        throw new UsageError(`devc: ${displayPath(path)} is not valid JSON: ${e.message}`);
      }
      throw e;
    }
    created = await writeDefaults(path).catch(() => false);
    raw = { ...DEFAULT_CONFIG } as unknown as Record<string, unknown>;
  }

  const cfg: Config = { ...DEFAULT_CONFIG };
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    switch (k) {
      case "root":
      case "containerRoot":
      case "skillsRoot":
      case "skillsContainerRoot":
      case "devcontainerPath":
        if (typeof v === "string") cfg[k] = v;
        break;
      case "maxDepth":
        if (typeof v === "number" && Number.isFinite(v)) cfg.maxDepth = Math.max(1, Math.trunc(v));
        break;
      case "workspaceFile":
        cfg.workspaceFile = typeof v === "string" && v !== "" ? v : null;
        break;
      default:
        extra[k] = v;
    }
  }

  // Host paths only — see HOST_PATH_KEYS. Expanded after the whole file is read, so the error
  // names the key the user actually wrote. Empty values expand to themselves.
  const expand = (value: string, key: string) => expandPath(value, key, path);
  cfg.root = expand(cfg.root, "root");
  cfg.skillsRoot = expand(cfg.skillsRoot, "skillsRoot");
  cfg.devcontainerPath = expand(cfg.devcontainerPath, "devcontainerPath");
  if (cfg.workspaceFile !== null) {
    cfg.workspaceFile = expand(cfg.workspaceFile, "workspaceFile");
  }
  return { cfg, path, extra, created };
}

/** Write the default config (creating parent dirs). Returns false if it already existed. */
export async function writeDefaults(path: string): Promise<boolean> {
  await Deno.mkdir(dirname(path), { recursive: true }).catch((e) => {
    if (!(e instanceof Deno.errors.AlreadyExists)) throw e;
  });
  try {
    await Deno.writeTextFile(path, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n", {
      createNew: true,
    });
    return true;
  } catch (e) {
    if (e instanceof Deno.errors.AlreadyExists) return false;
    throw e;
  }
}

/** `config init`: create the file with defaults if absent. */
export async function initConfig(override?: string): Promise<{ path: string; created: boolean }> {
  const path = configPath(override);
  return { path, created: await writeDefaults(path) };
}

/** Serialize a config back out, unknown keys included. */
export function serializeConfig(loaded: LoadedConfig): string {
  return JSON.stringify({ ...loaded.cfg, ...loaded.extra }, null, 2) + "\n";
}

/** Collapse $HOME to `~` so error messages match what the user typed in their shell. */
export function displayPath(path: string): string {
  const home = Deno.env.get("HOME");
  if (home !== undefined && home !== "" && path.startsWith(home + "/")) {
    return "~" + path.slice(home.length);
  }
  return path;
}

/** `root` is required by anything that scans. Fail with the exact remedy. */
export function requireRoot(cfg: Config, path: string): string {
  if (cfg.root.trim() === "") {
    throw new UsageError(`devc: config "root" is not set (edit ${displayPath(path)})`);
  }
  return resolve(cfg.root);
}

/** `skillsRoot` is required by the skills subcommands. */
export function requireSkillsRoot(cfg: Config, path: string): string {
  if (cfg.skillsRoot.trim() === "") {
    throw new UsageError(`devc: config "skillsRoot" is not set (edit ${displayPath(path)})`);
  }
  return resolve(cfg.skillsRoot);
}

/**
 * The directory the workspace file sits in — what the paths inside its `folders` array are
 * relative to. Pure: it mirrors `resolveTargets`' choice without touching the disk, which is
 * what lets `model.ts` write relative folder paths without being handed the resolved path.
 *
 * With `workspaceFile: null` the auto-detected file is always directly in the workspace dir,
 * so that is the answer; otherwise it is the configured path's parent.
 */
export function workspaceFileDir(cfg: Config, workspaceDir: string): string {
  const dir = resolve(workspaceDir);
  if (cfg.workspaceFile === null) return dir;
  return dirname(isAbsolute(cfg.workspaceFile) ? cfg.workspaceFile : join(dir, cfg.workspaceFile));
}

export interface Targets {
  /** Absolute path of the devcontainer file. */
  devcontainer: string;
  /** Absolute path of the workspace file (may not exist — it is auto-created). */
  workspaceFile: string;
}

/**
 * Resolve both target files inside `workspaceDir`:
 * - devcontainer: `<workspaceDir>/<devcontainerPath>`
 * - workspace file: `config.workspaceFile`, else the single `*.code-workspace` present,
 *   else `<basename(workspaceDir)>.code-workspace`. Two or more candidates with no config
 *   setting is ambiguous — exit 2 listing them.
 */
export async function resolveTargets(
  cfg: Config,
  workspaceDir: string,
  cfgPath: string = configPath(),
): Promise<Targets> {
  const dir = resolve(workspaceDir);
  const devcontainer = isAbsolute(cfg.devcontainerPath)
    ? cfg.devcontainerPath
    : join(dir, cfg.devcontainerPath);

  if (cfg.workspaceFile !== null) {
    const ws = isAbsolute(cfg.workspaceFile)
      ? cfg.workspaceFile
      : join(dir, cfg.workspaceFile);
    return { devcontainer, workspaceFile: ws };
  }

  const found: string[] = [];
  try {
    for await (const entry of Deno.readDir(dir)) {
      if (entry.isFile && entry.name.endsWith(".code-workspace")) found.push(entry.name);
    }
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
    throw new UsageError(`devc: workspace dir ${dir} does not exist`);
  }
  found.sort();
  if (found.length > 1) {
    throw new UsageError(
      `devc: ${dir} has ${found.length} *.code-workspace files ` +
        `(${found.join(", ")}); set "workspaceFile" in ${displayPath(cfgPath)}`,
    );
  }
  const name = found.length === 1 ? found[0] : `${basename(dir)}.code-workspace`;
  return { devcontainer, workspaceFile: join(dir, name) };
}
