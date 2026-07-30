// Subcommand implementations: the headless half of devc-tui.
//
// Every command funnels through `loadContext` (config + target files) and, for anything that
// touches the selection, `loadState` (scan + read the selection back out of the files). Write
// commands share one apply path — `applyAll` — so the TUI in the next phase adds no new
// file-writing logic.
//
// Output discipline: results on stdout, warnings and errors on stderr, exit codes 0/1/2.
// `--json` swaps the text renderers for one JSON object per command.

import { resolve } from "jsr:@std/path@^1";
import {
  type Config,
  configPath,
  displayPath,
  initConfig,
  type LoadedConfig,
  loadConfig,
  requireRoot,
  requireSkillsRoot,
  resolveTargets,
  RuntimeError,
  type Targets,
  UsageError,
} from "./config.ts";
import { flatten, type Node, nodeIndex, scanRoot, type Tree } from "./scan.ts";
import {
  derive,
  type Derived,
  fenceEntries,
  folderLines,
  mountLines,
  readSelection,
  readSkills,
  skillMountLines,
} from "./model.ts";
import {
  applyDevcontainer,
  devcontainerTemplate,
  PROJECTS_FENCE,
  readFileOrNull,
  SKILLS_FENCE,
  wrapFenceError,
} from "./devcontainer.ts";
import { applyWorkspace, FOLDERS_FENCE, WORKSPACE_TEMPLATE } from "./workspace.ts";
import { enabledSkills, listSkills, type Skill } from "./skills.ts";
import { unifiedDiff } from "./diff.ts";

export interface Io {
  out(text: string): void;
  err(text: string): void;
}

export const consoleIo: Io = {
  out: (t) => console.log(t),
  err: (t) => console.error(t),
};

export interface Options {
  workspaceDir?: string;
  root?: string;
  config?: string;
  dryRun: boolean;
  json: boolean;
  noColor: boolean;
  create: boolean;
}

export const DEFAULT_OPTIONS: Options = {
  dryRun: false,
  json: false,
  noColor: false,
  create: false,
};

export interface Ctx {
  opts: Options;
  io: Io;
  loaded: LoadedConfig;
  cfg: Config;
  workspaceDir: string;
  targets: Targets;
}

export interface State {
  tree: Tree;
  /** Explicit selection recovered from the files. */
  selection: Set<string>;
  /** Skill names recovered from the devcontainer file. */
  skills: Set<string>;
  devcontainerSrc: string | null;
  workspaceSrc: string | null;
  warnings: string[];
}

export async function loadContext(opts: Options, io: Io): Promise<Ctx> {
  const loaded = await loadConfig(opts.config);
  const cfg: Config = { ...loaded.cfg };
  if (opts.root !== undefined && opts.root !== "") cfg.root = opts.root;
  const workspaceDir = resolve(opts.workspaceDir ?? Deno.cwd());
  const targets = await resolveTargets(cfg, workspaceDir, loaded.path);
  return { opts, io, loaded, cfg, workspaceDir, targets };
}

export async function loadState(ctx: Ctx): Promise<State> {
  const root = requireRoot(ctx.cfg, ctx.loaded.path);
  const tree = await scanRoot(root, ctx.cfg.maxDepth, { workspaceDir: ctx.workspaceDir });
  const devcontainerSrc = await readFileOrNull(ctx.targets.devcontainer);
  const workspaceSrc = await readFileOrNull(ctx.targets.workspaceFile);
  // Refuse a file with a half-written fence up front, so no command half-applies.
  checkFences(devcontainerSrc, "mounts", [PROJECTS_FENCE, SKILLS_FENCE], ctx.targets.devcontainer);
  checkFences(workspaceSrc, "folders", [FOLDERS_FENCE], ctx.targets.workspaceFile);
  const read = readSelection(devcontainerSrc, workspaceSrc, tree, ctx.cfg);
  return {
    tree,
    selection: read.selection,
    skills: read.skills,
    devcontainerSrc,
    workspaceSrc,
    warnings: read.warnings,
  };
}

/** Fail fast, naming the file, when a fence is open but never closed. */
function checkFences(src: string | null, key: string, ids: string[], path: string): void {
  if (src === null) return;
  for (const id of ids) {
    try {
      fenceEntries(src, key, id);
    } catch (e) {
      throw wrapFenceError(e, path);
    }
  }
}

function warn(io: Io, warnings: string[]): void {
  for (const w of warnings) io.err(`devc-tui: warning: ${w}`);
}

// --- list ------------------------------------------------------------------------

export async function cmdList(opts: Options, io: Io): Promise<number> {
  const ctx = await loadContext(opts, io);
  const state = await loadState(ctx);
  const derived = derive(state.tree, state.selection, ctx.cfg);
  warn(io, [...state.warnings, ...derived.warnings]);

  const nodes = flatten(state.tree.nodes);
  if (opts.json) {
    io.out(JSON.stringify({
      root: state.tree.root,
      workspaceDir: state.tree.workspaceDir,
      nodes: nodes.map((n) => ({
        id: n.id,
        kind: n.kind,
        name: n.name,
        path: n.path,
        depth: n.depth,
        selectable: n.selectable,
        isWorkspace: n.isWorkspace,
        selected: state.selection.has(n.id),
        auto: derived.auto.has(n.id),
        ...(n.kind === "worktree" ? { relativeGitdir: n.relativeGitdir === true } : {}),
        warnings: n.warnings,
      })),
    }, null, 2));
    return 0;
  }

  io.out(`root: ${state.tree.root}`);
  if (nodes.length === 0) io.out("(no projects found)");
  for (const n of nodes) {
    const marker = markerFor(n, state.selection, derived);
    const notes = [...n.warnings];
    if (n.isWorkspace) notes.push("current workspace");
    if (derived.auto.has(n.id)) notes.push("auto: required by a selected worktree");
    const suffix = notes.length > 0 ? `  ! ${notes.join("; ")}` : "";
    io.out(`${marker} ${"  ".repeat(n.depth)}${n.name}${suffix}`);
  }
  return 0;
}

function markerFor(n: Node, selection: Set<string>, derived: Derived): string {
  if (selection.has(n.id)) return "[x]";
  if (derived.auto.has(n.id)) return "[~]";
  return n.selectable ? "[ ]" : "   ";
}

// --- status ----------------------------------------------------------------------

export async function cmdStatus(opts: Options, io: Io): Promise<number> {
  const ctx = await loadContext(opts, io);
  const devSrc = await readFileOrNull(ctx.targets.devcontainer);
  const wsSrc = await readFileOrNull(ctx.targets.workspaceFile);
  const counts = {
    [`devc-tui:${PROJECTS_FENCE}`]: countEntries(devSrc, "mounts", PROJECTS_FENCE),
    [`devc-tui:${SKILLS_FENCE}`]: countEntries(devSrc, "mounts", SKILLS_FENCE),
    [`devc-tui:${FOLDERS_FENCE}`]: countEntries(wsSrc, "folders", FOLDERS_FENCE),
  };

  if (opts.json) {
    io.out(JSON.stringify({
      config: ctx.loaded.path,
      resolved: ctx.cfg,
      workspaceDir: ctx.workspaceDir,
      devcontainer: { path: ctx.targets.devcontainer, exists: devSrc !== null },
      workspaceFile: { path: ctx.targets.workspaceFile, exists: wsSrc !== null },
      fences: {
        projects: counts[`devc-tui:${PROJECTS_FENCE}`],
        skills: counts[`devc-tui:${SKILLS_FENCE}`],
        folders: counts[`devc-tui:${FOLDERS_FENCE}`],
      },
    }, null, 2));
    return 0;
  }

  const rows: Array<[string, string]> = [
    ["config", ctx.loaded.path],
    ["root", ctx.cfg.root === "" ? "(not set)" : resolve(ctx.cfg.root)],
    ["containerRoot", ctx.cfg.containerRoot],
    ["maxDepth", String(ctx.cfg.maxDepth)],
    ["skillsRoot", ctx.cfg.skillsRoot === "" ? "(not set)" : resolve(ctx.cfg.skillsRoot)],
    ["skillsContainerRoot", ctx.cfg.skillsContainerRoot],
    ["workspaceDir", ctx.workspaceDir],
    ["devcontainer", `${ctx.targets.devcontainer} ${devSrc === null ? "(missing)" : "(exists)"}`],
    ["workspaceFile", `${ctx.targets.workspaceFile} ${wsSrc === null ? "(missing)" : "(exists)"}`],
  ];
  const width = Math.max(...rows.map(([k]) => k.length));
  for (const [k, v] of rows) io.out(`${k.padEnd(width)}  ${v}`);
  for (const [fence, n] of Object.entries(counts)) {
    const what = n === null ? "(file missing)" : n < 0 ? "(unterminated fence)" : `${n} entries`;
    io.out(`${fence.padEnd(width)}  ${what}`);
  }
  return 0;
}

/** Entry count, `null` when the file is absent, `-1` when the fence is unterminated. */
function countEntries(src: string | null, key: string, fence: string): number | null {
  if (src === null) return null;
  try {
    return fenceEntries(src, key, fence).length;
  } catch {
    return -1;
  }
}

// --- select / deselect / apply ---------------------------------------------------

export async function cmdSelect(
  opts: Options,
  io: Io,
  ids: string[],
  add: boolean,
): Promise<number> {
  if (ids.length === 0) {
    throw new UsageError(`devc-tui: ${add ? "select" : "deselect"} needs at least one project id`);
  }
  const ctx = await loadContext(opts, io);
  const state = await loadState(ctx);
  const index = nodeIndex(state.tree);
  for (const id of ids) {
    const node = index.get(id);
    if (node === undefined) throw new UsageError(`devc-tui: unknown project id ${JSON.stringify(id)}`);
    if (add && !node.selectable) {
      const why = node.isWorkspace
        ? "it is the current workspace"
        : node.warnings.join("; ") || "not selectable";
      throw new UsageError(`devc-tui: project ${JSON.stringify(id)} is not selectable (${why})`);
    }
  }
  for (const id of ids) {
    if (add) state.selection.add(id);
    else state.selection.delete(id);
  }
  return await applyAll(ctx, state);
}

export async function cmdApply(opts: Options, io: Io): Promise<number> {
  const ctx = await loadContext(opts, io);
  const state = await loadState(ctx);
  return await applyAll(ctx, state);
}

export interface Change {
  path: string;
  before: string;
  after: string;
}

export interface Planned {
  changes: Change[];
  warnings: string[];
}

/**
 * Derive both files from `state` and diff them against what is on disk. This is the single
 * place a devc-tui fence is ever computed — `apply`, `select`, `skills enable` and the TUI's
 * `w` all come through here, so they cannot drift apart.
 *
 * Files whose content is unchanged are left out entirely, which is what makes a repeated
 * `apply` byte-identical.
 */
export async function planChanges(ctx: Ctx, state: State): Promise<Planned> {
  const derived = derive(state.tree, state.selection, ctx.cfg);
  const skills = await skillFenceLines(ctx, state);
  const warnings = [...state.warnings, ...derived.warnings, ...skills.warnings];

  if (state.devcontainerSrc === null && !ctx.opts.create) {
    throw new RuntimeError(
      `devc-tui: ${ctx.targets.devcontainer} does not exist (pass --create to create it)`,
    );
  }
  const devBase = state.devcontainerSrc ?? devcontainerTemplate(ctx.workspaceDir);
  const wsBase = state.workspaceSrc ?? WORKSPACE_TEMPLATE;

  const devNext = applyDevcontainer(
    devBase,
    mountLines(derived.mounts),
    skills.lines,
    ctx.targets.devcontainer,
  );
  const wsNext = applyWorkspace(
    wsBase,
    folderLines(derived.folders),
    ctx.targets.workspaceFile,
  );

  const changes: Change[] = [];
  if (devNext !== state.devcontainerSrc) {
    changes.push({ path: ctx.targets.devcontainer, before: state.devcontainerSrc ?? "", after: devNext });
  }
  if (wsNext !== state.workspaceSrc) {
    changes.push({ path: ctx.targets.workspaceFile, before: state.workspaceSrc ?? "", after: wsNext });
  }
  return { changes, warnings };
}

/** Write planned changes, creating parent dirs. Returns the paths written, in order. */
export async function writeChanges(changes: Change[]): Promise<string[]> {
  for (const c of changes) {
    await Deno.mkdir(dirOf(c.path), { recursive: true }).catch((e) => {
      if (!(e instanceof Deno.errors.AlreadyExists)) throw e;
    });
    await Deno.writeTextFile(c.path, c.after);
  }
  return changes.map((c) => c.path);
}

/**
 * Plan and write in one call — the entry point the interactive UI uses for `w`, so the UI
 * introduces no file-writing logic of its own.
 */
export async function applySelection(
  ctx: Ctx,
  state: State,
): Promise<{ changed: string[]; warnings: string[] }> {
  const planned = await planChanges(ctx, state);
  return { changed: await writeChanges(planned.changes), warnings: planned.warnings };
}

/** `select` / `deselect` / `apply` / `skills`: plan, then diff or write, then report. */
async function applyAll(ctx: Ctx, state: State): Promise<number> {
  const { changes, warnings } = await planChanges(ctx, state);
  warn(ctx.io, warnings);

  if (ctx.opts.dryRun) {
    for (const c of changes) ctx.io.out(unifiedDiff(c.before, c.after, c.path).trimEnd());
    if (ctx.opts.json) ctx.io.out(JSON.stringify({ changed: changes.map((c) => c.path) }));
    else if (changes.length === 0) ctx.io.out("no changes");
    return 0;
  }

  const written = await writeChanges(changes);
  if (ctx.opts.json) ctx.io.out(JSON.stringify({ changed: written }));
  else if (written.length === 0) ctx.io.out("no changes");
  else for (const path of written) ctx.io.out(`wrote ${path}`);
  return 0;
}

function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i <= 0 ? "." : path.slice(0, i);
}

/**
 * Lines for the skills fence. With `skillsRoot` unset there is nothing to derive from, so
 * whatever the fence already holds is preserved verbatim rather than silently wiped.
 */
async function skillFenceLines(
  ctx: Ctx,
  state: State,
): Promise<{ lines: string[]; warnings: string[] }> {
  if (ctx.cfg.skillsRoot.trim() === "") {
    const existing = state.devcontainerSrc === null
      ? []
      : fenceEntries(state.devcontainerSrc, "mounts", SKILLS_FENCE);
    return { lines: existing, warnings: [] };
  }
  const skills = await listSkills(resolve(ctx.cfg.skillsRoot));
  const known = new Set(skills.map((s) => s.name));
  const warnings = [...state.skills]
    .filter((n) => !known.has(n))
    .map((n) => `dropping skill ${JSON.stringify(n)} (no such directory under skillsRoot)`);
  const enabled = enabledSkills(skills, state.skills);
  return { lines: skillMountLines(ctx.cfg, enabled), warnings };
}

// --- skills ----------------------------------------------------------------------

export async function cmdSkillsList(opts: Options, io: Io): Promise<number> {
  const ctx = await loadContext(opts, io);
  const skillsRoot = requireSkillsRoot(ctx.cfg, ctx.loaded.path);
  const skills = await listSkills(skillsRoot);
  const devSrc = await readFileOrNull(ctx.targets.devcontainer);
  const enabled = readSkills(devSrc);

  if (opts.json) {
    io.out(JSON.stringify({
      skillsRoot,
      skillsContainerRoot: ctx.cfg.skillsContainerRoot,
      skills: skills.map((s) => ({
        name: s.name,
        path: s.path,
        enabled: enabled.has(s.name),
        warnings: s.warnings,
      })),
    }, null, 2));
    return 0;
  }
  io.out(`skillsRoot: ${skillsRoot}`);
  if (skills.length === 0) io.out("(no skills found)");
  for (const s of skills) {
    const suffix = s.warnings.length > 0 ? `  ! ${s.warnings.join("; ")}` : "";
    io.out(`${enabled.has(s.name) ? "[x]" : "[ ]"} ${s.name}${suffix}`);
  }
  return 0;
}

export async function cmdSkills(
  opts: Options,
  io: Io,
  names: string[],
  enable: boolean,
): Promise<number> {
  if (names.length === 0) {
    throw new UsageError(
      `devc-tui: skills ${enable ? "enable" : "disable"} needs at least one skill name`,
    );
  }
  const ctx = await loadContext(opts, io);
  const skillsRoot = requireSkillsRoot(ctx.cfg, ctx.loaded.path);
  const available: Skill[] = await listSkills(skillsRoot);
  const known = new Set(available.map((s) => s.name));
  for (const n of names) {
    if (enable && !known.has(n)) throw new UsageError(`devc-tui: unknown skill ${JSON.stringify(n)}`);
  }
  const state = await loadState(ctx);
  for (const n of names) {
    if (enable) state.skills.add(n);
    else state.skills.delete(n);
  }
  return await applyAll(ctx, state);
}

// --- config ----------------------------------------------------------------------

export async function cmdConfigShow(opts: Options, io: Io): Promise<number> {
  const loaded = await loadConfig(opts.config);
  const cfg = { ...loaded.cfg, ...loaded.extra };
  if (opts.root !== undefined && opts.root !== "") cfg.root = opts.root;
  io.out(JSON.stringify(cfg, null, 2));
  return 0;
}

export function cmdConfigPath(opts: Options, io: Io): number {
  io.out(configPath(opts.config));
  return 0;
}

export async function cmdConfigInit(opts: Options, io: Io): Promise<number> {
  const { path, created } = await initConfig(opts.config);
  io.out(created ? `created ${displayPath(path)}` : `${displayPath(path)} already exists`);
  return 0;
}
