// The `devc config` orchestrator: a thin imperative shell (like `main.ts`) that wires the
// folder picker + confirm prompt to the pure seed/apply logic. It replaces the old full-screen
// step wizard. All IO is injected via `FlowDeps` so the whole flow is scriptable headlessly
// (see `tests/config_flow_test.ts`); the real entry points build deps over the actual TTY.
//
// Two flows live here:
//   • project  — pick source folders, pick skills folders, review, apply to `.devcontainer/`.
//   • global   — first-run: pick code roots then skills roots, stored folded to `~/…`.
// Both are fully picker-driven: you *select* folders, never type paths.

import { resolve } from "jsr:@std/path@^1";
import {
  displayPath,
  expandPath,
  globalConfigExists,
  type GlobalConfig,
  loadGlobalConfig,
  makeGlobalConfig,
  saveGlobalConfig,
} from "../config.ts";
import { loadBundledDevcontainerJson } from "../default_config.ts";
import {
  assertNoDuplicateTarget,
  defaultReadonly,
  defaultTarget,
  DuplicateTargetError,
  foldHome,
  type MountKind,
  type MountRow,
  parseEntries,
  rowForHostPath,
  serializeMount,
} from "../mounts.ts";
import { applySelection, type ApplyResult, type WizardSelection } from "../wizard_apply.ts";
import {
  type ContainerStatus,
  getContainerStatus,
  rebuildContainer,
} from "../container.ts";
import { findArraySpan, findFence, parseFenceEntries } from "../jsonc_edit.ts";
import {
  type FsProbe,
  longestRootAncestor,
  realFsProbe,
  resolveWorktree,
} from "../worktree.ts";
import {
  type EntryFlag,
  pickFolders,
  type PickerDeps,
} from "./folder_picker.ts";
import { runConfirm } from "./prompts.ts";
import type { Size } from "./term.ts";

export interface WizardIo {
  err: (msg: string) => void;
}

/** Injected IO for the whole flow. Real runs fill these from the TTY; tests script them. */
export interface FlowDeps {
  input: ReadableStream<Uint8Array>;
  output: WritableStream<Uint8Array>;
  size: () => Size;
  /** Enter raw mode + alternate screen for the pickers. Off in tests. */
  raw?: boolean;
  /** List subdirectory names of a path. Defaults to the picker's real-filesystem lister. */
  readDir?: (path: string) => Promise<string[]>;
  isTerminal?: () => boolean;
  err?: (msg: string) => void;
  /** Apply the selection. Defaults to `applySelection` (real writes). */
  apply?: (dir: string, sel: WizardSelection) => Promise<ApplyResult>;
  /** Filesystem probe for worktree resolution. Defaults to `realFsProbe`. */
  fsProbe?: FsProbe;
  /**
   * Look up the project's container status, to word the post-apply rebuild prompt. Omitted
   * (tests, no-Docker contexts) ⇒ the flow reports that a rebuild is needed but does not offer
   * to run one.
   */
  containerStatus?: (dir: string) => Promise<ContainerStatus>;
  /**
   * Recreate the container, resolving to a one-line summary for the flow to print. Throws on
   * failure. Omitted ⇒ no rebuild is offered (see `containerStatus`).
   */
  rebuild?: (dir: string) => Promise<string>;
}

function pickerDeps(deps: FlowDeps): PickerDeps {
  return {
    input: deps.input,
    output: deps.output,
    size: deps.size,
    raw: deps.raw,
    readDir: deps.readDir,
    isTerminal: deps.isTerminal,
    err: deps.err,
  };
}

async function writeLines(
  output: WritableStream<Uint8Array>,
  lines: string[],
): Promise<void> {
  const w = output.getWriter();
  try {
    await w.write(new TextEncoder().encode(lines.join("\n") + "\n"));
  } finally {
    w.releaseLock();
  }
}

const HOME = () => Deno.env.get("HOME") ?? Deno.cwd();

/**
 * Expand a stored mount `source` to an absolute path for pre-ticking in the picker. Handles the
 * devcontainer `${localEnv:HOME}` form as well as shell `~`/`$VAR`. Returns null when it cannot
 * be resolved (an unset variable), so that row is simply not pre-ticked.
 */
function expandToAbsolute(source: string): string | null {
  let s = source;
  if (s.includes("${localEnv:HOME}")) {
    const home = Deno.env.get("HOME");
    if (!home) return null;
    s = s.replaceAll("${localEnv:HOME}", home);
  }
  try {
    return resolve(expandPath(s));
  } catch {
    return null;
  }
}

/** Build rows for `kind` from picked absolute paths, skipping any duplicate target. */
function buildRows(
  kind: MountKind,
  paths: string[],
  warn: (msg: string) => void,
): MountRow[] {
  const rows: MountRow[] = [];
  for (const p of paths) {
    const row = rowForHostPath(kind, p);
    try {
      assertNoDuplicateTarget(rows, row);
      rows.push(row);
    } catch (e) {
      if (e instanceof DuplicateTargetError) {
        warn(`  skipped ${p} — target ${row.target} already in use`);
      } else {
        throw e;
      }
    }
  }
  return rows;
}

/**
 * Build source rows from picked absolute paths. Each folder's container target keeps its
 * sub-path under the configured code root it falls under (so `~/code/a/b` → `/workspaces/a/b`).
 * A picked git worktree additionally contributes a mount of its primary repo's `.git` at the
 * mirror location, but only when that is safe (relative paths + primary under the same root);
 * unsafe worktrees are already flagged in the picker and just skip the primary mount. The
 * primary `.git` mount is skipped when its target is already present (worktrees sharing one
 * primary) or when the primary working tree is itself a picked source (already mounted).
 */
async function buildSourceRows(
  paths: string[],
  codeRoots: string[],
  warn: (msg: string) => void,
  fs: FsProbe,
): Promise<MountRow[]> {
  const rows: MountRow[] = [];
  const picked = new Set(paths);
  const add = (row: MountRow, onDup: () => void): void => {
    try {
      assertNoDuplicateTarget(rows, row);
      rows.push(row);
    } catch (e) {
      if (e instanceof DuplicateTargetError) onDup();
      else throw e;
    }
  };

  for (const p of paths) {
    const root = longestRootAncestor(p, codeRoots) ?? undefined;
    add(
      rowForHostPath("source", p, root),
      () => warn(`  skipped ${p} — target already in use`),
    );

    const wt = await resolveWorktree(p, root ?? null, fs);
    if (wt.isWorktree && wt.valid && !picked.has(wt.primaryRoot!)) {
      add(
        {
          source: foldHome(wt.primaryGitDir!),
          target: wt.primaryGitTarget!,
          readonly: false,
        },
        () => {}, // shared primary → mount it once, silently
      );
    }
  }
  return rows;
}

function reviewLines(sel: WizardSelection): string[] {
  const lines: string[] = ["", "Review:"];
  const block = (title: string, rows: MountRow[]) => {
    lines.push(`  ${title}`);
    if (rows.length === 0) lines.push("    (none)");
    for (const r of rows) lines.push(`    ${serializeMount(r)}`);
  };
  block("devc:source", sel.source);
  block("devc:skills", sel.skills);
  return lines;
}

export interface ProjectFlowOptions {
  projectDir: string;
  configPath: string;
  creating: boolean;
  sourceRows: MountRow[];
  skillsRows: MountRow[];
  /** Expanded (absolute) code roots — where the source picker opens. */
  codeRoots: string[];
  /** Expanded (absolute) skills roots — where the skills picker opens. */
  skillsRoots: string[];
  color: boolean;
}

/** Outcome of a flow run. */
export interface FlowResult {
  applied: boolean;
  /** Whether the apply actually altered the config on disk (see `ApplyResult.changed`). */
  changed: boolean;
  /** Whether a container rebuild was run as part of this flow. */
  rebuilt: boolean;
}

/** The testable project-config flow core. */
export async function runProjectFlow(
  opts: ProjectFlowOptions,
  deps: FlowDeps,
): Promise<FlowResult> {
  const apply = deps.apply ?? applySelection;
  const warn = deps.err ?? ((m: string) => console.error(m));
  const fs = deps.fsProbe ?? realFsProbe;

  await writeLines(deps.output, [
    `Configuring devcontainer at ${opts.configPath}`,
    `  (${opts.creating ? "creating a new config" : "updating the existing config"})`,
  ]);

  // Flag each browsed subfolder that is a git worktree whose primary repo can't be mounted.
  const annotateSource = async (
    dir: string,
    names: string[],
  ): Promise<Map<string, EntryFlag>> => {
    const flags = new Map<string, EntryFlag>();
    await Promise.all(names.map(async (name) => {
      const abs = resolve(dir, name);
      const wt = await resolveWorktree(
        abs,
        longestRootAncestor(abs, opts.codeRoots),
        fs,
      );
      if (wt.isWorktree) {
        flags.set(name, {
          worktree: true,
          valid: wt.valid,
          reason: wt.reason,
        });
      }
    }));
    return flags;
  };

  const sourcePicked = await pickFolders({
    title: "Pick source folders to mount",
    start: opts.codeRoots[0] ?? HOME(),
    roots: opts.codeRoots.length ? opts.codeRoots : undefined,
    preselected: opts.sourceRows.map((r) => expandToAbsolute(r.source)).filter(
      (p): p is string => p !== null,
    ),
    annotate: annotateSource,
    color: opts.color,
  }, pickerDeps(deps));
  if (sourcePicked === null) {
    await writeLines(deps.output, ["Cancelled."]);
    return { applied: false, changed: false, rebuilt: false };
  }

  const skillsPicked = await pickFolders({
    title: "Pick skills folders to mount",
    start: opts.skillsRoots[0] ?? HOME(),
    roots: opts.skillsRoots.length ? opts.skillsRoots : undefined,
    preselected: opts.skillsRows.map((r) => expandToAbsolute(r.source)).filter(
      (p): p is string => p !== null,
    ),
    color: opts.color,
  }, pickerDeps(deps));
  if (skillsPicked === null) {
    await writeLines(deps.output, ["Cancelled."]);
    return { applied: false, changed: false, rebuilt: false };
  }

  const selection: WizardSelection = {
    source: await buildSourceRows(sourcePicked, opts.codeRoots, warn, fs),
    skills: buildRows("skills", skillsPicked, warn),
  };

  await writeLines(deps.output, reviewLines(selection));
  const ok = await runConfirm("Apply?", true, {
    input: deps.input,
    output: deps.output,
    raw: deps.raw,
  });
  if (!ok) {
    await writeLines(deps.output, ["Cancelled — nothing written."]);
    return { applied: false, changed: false, rebuilt: false };
  }

  const result = await apply(opts.projectDir, selection);
  const msg = [
    result.changed
      ? `${result.created ? "Created" : "Updated"} ${result.configPath}`
      : `Unchanged ${result.configPath}`,
  ];
  if (result.created) {
    // List the bundled assets written alongside the config (skip the config itself).
    for (const path of result.written) {
      if (path !== result.configPath) msg.push(`  + ${path}`);
    }
  }
  await writeLines(deps.output, msg);

  const rebuilt = await maybeRebuild(opts.projectDir, result.changed, deps);
  return { applied: true, changed: result.changed, rebuilt };
}

/**
 * Post-apply rebuild step. Mounts are bound when the container is *created*, so a changed
 * config only takes effect after a recreate — but a selection that round-tripped to identical
 * bytes needs nothing, and saying otherwise would train the user to ignore the prompt. So the
 * notice and the offer appear only when `changed`.
 */
async function maybeRebuild(
  projectDir: string,
  changed: boolean,
  deps: FlowDeps,
): Promise<boolean> {
  if (!changed) {
    await writeLines(deps.output, ["No config changes — no rebuild needed."]);
    return false;
  }

  // No status lookup / rebuild action (tests), or the lookup itself failed (no docker on
  // PATH, daemon down) ⇒ say what is needed and let the user run it, rather than offering a
  // build that cannot work.
  const status = deps.containerStatus;
  const rebuild = deps.rebuild;
  const state = status === undefined
    ? null
    : await status(projectDir).catch(() => null);
  if (state === null || rebuild === undefined) {
    await writeLines(deps.output, [
      "Config changed — run `devc build` to rebuild the dev container.",
    ]);
    return false;
  }

  const existing = state !== "missing";
  await writeLines(deps.output, [
    "",
    existing
      ? "Config changed — the dev container must be rebuilt for the new mounts to take effect."
      : "No dev container exists for this project yet.",
  ]);
  const go = await runConfirm(existing ? "Rebuild now?" : "Build it now?", true, {
    input: deps.input,
    output: deps.output,
    raw: deps.raw,
  });
  if (!go) {
    await writeLines(deps.output, [
      "Skipped — run `devc build` when you're ready.",
    ]);
    return false;
  }

  // The config is already written, so a failed build is not a failed `devc config`: report it
  // and return normally rather than throwing out of the flow.
  try {
    const summary = await rebuild(projectDir);
    await writeLines(deps.output, [summary]);
    return true;
  } catch (e) {
    (deps.err ?? ((m: string) => console.error(m)))(
      `devc: ${e instanceof Error ? e.message : e}`,
    );
    return false;
  }
}

/** The testable global-roots flow core: pick code roots, then skills roots (stored `~/…`). */
export async function runGlobalFlow(
  cfg: GlobalConfig,
  deps: FlowDeps,
  color: boolean,
): Promise<{ codeRoots: string[]; skillsRoots: string[] } | null> {
  const expandedOrEmpty = (raw: string[]): string[] => {
    try {
      return raw.map(expandPath).map((p) => resolve(p));
    } catch {
      return [];
    }
  };
  await writeLines(deps.output, [
    "Configure roots — pick your code folder root(s), then your skills root(s).",
    "These scope where the project pickers can select from.",
  ]);

  const codePre = expandedOrEmpty(cfg.codeRoots);
  const codeAbs = await pickFolders({
    title: "Pick your code folder root(s)",
    start: codePre[0] ?? HOME(),
    preselected: codePre,
    color,
  }, pickerDeps(deps));
  if (codeAbs === null) return null;

  const skillsPre = expandedOrEmpty(cfg.skillsRoots);
  const skillsAbs = await pickFolders({
    title: "Pick your skills root(s)",
    start: skillsPre[0] ?? HOME(),
    preselected: skillsPre,
    color,
  }, pickerDeps(deps));
  if (skillsAbs === null) return null;

  return {
    codeRoots: codeAbs.map(displayPath),
    skillsRoots: skillsAbs.map(displayPath),
  };
}

// ── seeding (relocated from the old wizard.ts) ──────────────────────────────────

async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Seed the source/skills rows from the base config text's fences. If the base has no fences,
 * source starts empty and skills is pre-seeded from `recentSkillsRaw` (filtered to host paths
 * that still exist; raw stored values are expanded for the check).
 */
export async function seedRows(
  baseText: string,
  recentSkillsRaw: string[],
): Promise<{ sourceRows: MountRow[]; skillsRows: MountRow[] }> {
  const span = findArraySpan(baseText, "mounts");
  const hasFence = (id: string) =>
    span !== null && findFence(baseText, span, id) !== null;
  const hadFences = hasFence("source") || hasFence("skills");

  const sourceRows = span === null
    ? []
    : parseEntries(parseFenceEntries(baseText, span, "source"));
  let skillsRows = span === null
    ? []
    : parseEntries(parseFenceEntries(baseText, span, "skills"));

  if (!hadFences) {
    skillsRows = [];
    for (const raw of recentSkillsRaw) {
      let expanded: string;
      try {
        expanded = expandPath(raw);
      } catch {
        continue;
      }
      if (!(await pathExists(expanded))) continue;
      const folded = foldHome(raw);
      skillsRows.push({
        source: folded,
        target: defaultTarget("skills", folded),
        readonly: defaultReadonly("skills"),
      });
    }
  }
  return { sourceRows, skillsRows };
}

// ── real-IO entry points (called by main.ts) ────────────────────────────────────

function realDeps(): FlowDeps {
  return {
    input: Deno.stdin.readable,
    output: Deno.stdout.writable,
    size: () => {
      try {
        return Deno.consoleSize();
      } catch {
        return { columns: 80, rows: 24 };
      }
    },
    raw: true,
  };
}

const colorEnabled = (): boolean => {
  const f = Deno.env.get("NO_COLOR");
  return f === undefined || f === "";
};

/**
 * Open the full project flow for `devc config [PATH]`. Resolves the base per precedence
 * (existing `PATH/.devcontainer/devcontainer.json`, else the bundled default), seeds the
 * source/skills selections, and — when `includeGlobalStep` — runs the global-roots step first.
 */
export async function runProjectConfigWizard(
  projectDir: string,
  io: WizardIo,
  includeGlobalStep: boolean,
): Promise<void> {
  const deps: FlowDeps = {
    ...realDeps(),
    err: io.err,
    containerStatus: getContainerStatus,
    rebuild: async (dir) => {
      console.log(`Rebuilding dev container for ${dir}...`);
      const info = await rebuildContainer(dir);
      return `${info.containerId} running — workspace ${info.remoteWorkspaceFolder}`;
    },
  };

  // Bounded pickers need roots as their top level, so ensure roots exist first: on an explicit
  // first run, or whenever either root list is empty/unresolvable.
  let cfg = await loadGlobalConfig();
  const rootsMissing = safeExpanded(() => cfg.codeRootsExpanded()).length === 0 ||
    safeExpanded(() => cfg.skillsRootsExpanded()).length === 0;
  if (includeGlobalStep || rootsMissing) {
    await runGlobalConfigWizard(io);
    cfg = await loadGlobalConfig();
  }

  const configPath = `${projectDir}/.devcontainer/devcontainer.json`;

  let baseText: string;
  let creating: boolean;
  try {
    baseText = await Deno.readTextFile(configPath);
    creating = false;
  } catch {
    baseText = await loadBundledDevcontainerJson();
    creating = true;
  }

  const { sourceRows, skillsRows } = await seedRows(baseText, cfg.recentSkills);

  await runProjectFlow({
    projectDir,
    configPath,
    creating,
    sourceRows,
    skillsRows,
    codeRoots: safeExpanded(() => cfg.codeRootsExpanded()),
    skillsRoots: safeExpanded(() => cfg.skillsRootsExpanded()),
    color: colorEnabled(),
  }, deps);
}

function safeExpanded(fn: () => string[]): string[] {
  try {
    return fn();
  } catch {
    return [];
  }
}

/**
 * Run the first-run global-roots step, seeded from the current on-disk config, and save the
 * result (preserving `recentSkills` and any unknown keys). No-op save when cancelled.
 */
export async function runGlobalConfigWizard(io: WizardIo): Promise<void> {
  const deps = { ...realDeps(), err: io.err };
  const cfg = await loadGlobalConfig();
  const picked = await runGlobalFlow(cfg, deps, colorEnabled());
  if (picked === null) return;
  await saveGlobalConfig(
    makeGlobalConfig(
      picked.codeRoots,
      picked.skillsRoots,
      cfg.path,
      cfg.extra,
      cfg.recentSkills,
    ),
  );
}

/** Re-export so `main.ts` need not reach past this module to the config layer. */
export { globalConfigExists };
