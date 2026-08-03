// The shell around the pure wizard core: own the terminal, feed bytes to the decoder, hand
// keys to `reduce`, and perform the effects (`save` / `quit` / `none`). All IO is injected,
// so `wizard_state_test.ts` scripts a key sequence and asserts effects with no TTY in sight,
// and this loop can drive a headless input stream in tests (`raw` off).

import {
  globalConfigExists,
  loadGlobalConfig,
  makeGlobalConfig,
  saveGlobalConfig,
} from "../config.ts";
import { KeyDecoder } from "./keys.ts";
import { type Size, Terminal } from "./term.ts";
import { colorEnabled, render } from "./wizard_render.ts";
import {
  initialGlobalState,
  initialProjectState,
  openPicker,
  openRootPicker,
  type ProjectWizardInit,
  reduce,
  setPickerListing,
  type WizardState,
} from "./wizard_state.ts";
import type { MountKind, MountRow } from "../mounts.ts";
import {
  defaultReadonly,
  defaultTarget,
  foldHome,
  parseEntries,
} from "../mounts.ts";
import { applySelection } from "../wizard_apply.ts";
import { findArraySpan, findFence, parseFenceEntries } from "../jsonc_edit.ts";
import { expandPath } from "../config.ts";
import { loadBundledDefault } from "../default_config.ts";

export const NOT_A_TERMINAL =
  "devc: not a terminal; the config wizard needs an interactive terminal";

/** Injected IO so the loop can run and be observed headlessly. */
export interface WizardIo {
  err: (msg: string) => void;
}

/** Injected runtime dependencies (all overridable for tests). */
export interface WizardDeps {
  input: ReadableStream<Uint8Array>;
  output: WritableStream<Uint8Array>;
  size: () => Size;
  /** Enter raw mode + the alternate screen. Off in tests. */
  raw?: boolean;
  /** Overridable so tests can prove the non-TTY refusal without a TTY. */
  isTerminal?: () => boolean;
  /** Persist the config on Apply. Defaults to `saveGlobalConfig` at the standard path. */
  save?: (codeRoots: string[], skillsRoots: string[]) => Promise<void>;
  /** Apply the project selection. Defaults to `applySelection` at `projectDir`. */
  apply?: (source: MountRow[], skills: MountRow[]) => Promise<void>;
  /** Resolve the configured host roots for a kind (source→codeRoots, skills→skillsRoots). */
  resolveRoots?: (kind: MountKind) => Promise<string[]>;
  /** List subdirectory names of `path` (directories only). Defaults to `Deno.readDir`. */
  readDir?: (path: string) => Promise<string[]>;
}

export interface WizardOptions {
  /** Initial code roots (raw). */
  codeRoots: string[];
  /** Initial skills roots (raw). */
  skillsRoots: string[];
  noColor?: boolean;
}

/** Outcome of a wizard run: whether the user applied (saved) or cancelled. */
export interface WizardResult {
  applied: boolean;
}

/** List the subdirectory names of `path` (directories only), sorted; `[]` on any error. */
async function defaultReadDir(path: string): Promise<string[]> {
  const names: string[] = [];
  try {
    for await (const entry of Deno.readDir(path)) {
      if (entry.isDirectory) names.push(entry.name);
    }
  } catch {
    return [];
  }
  names.sort();
  return ["..", ...names];
}

/**
 * The shared app loop: own the terminal, decode bytes into keys, feed `reduce`, and perform
 * the effects. The terminal is always restored (`term.close()` in a `finally`); no exit path
 * bypasses it. Returns whether the user applied/saved.
 */
async function runLoop(
  initial: WizardState,
  io: WizardIo,
  deps: WizardDeps,
  handlers: {
    save: (codeRoots: string[], skillsRoots: string[]) => Promise<void>;
    apply: (source: MountRow[], skills: MountRow[]) => Promise<void>;
    resolveRoots: (kind: MountKind) => Promise<string[]>;
    readDir: (path: string) => Promise<string[]>;
  },
): Promise<WizardResult> {
  const raw = deps.raw ?? false;
  if (raw) {
    const isTerminal = deps.isTerminal ??
      (() => Deno.stdin.isTerminal() && Deno.stdout.isTerminal());
    if (!isTerminal()) {
      io.err(NOT_A_TERMINAL);
      return { applied: false };
    }
  }

  let state = initial;
  const term = await Terminal.open({
    output: deps.output,
    raw,
    size: deps.size,
  });
  const paint = async () => {
    await term.paint(render(state, term.size()));
  };

  let applied = false;
  try {
    term.onResize(() => void paint());
    await paint();

    const decoder = new KeyDecoder();
    loop: for await (const chunk of deps.input) {
      for (const k of decoder.push(chunk)) {
        const step = reduce(state, k);
        state = step.state;
        switch (step.effect.type) {
          case "none":
            break;
          case "save":
            await handlers.save(step.effect.codeRoots, step.effect.skillsRoots);
            applied = true;
            break loop;
          case "apply":
            await handlers.apply(step.effect.source, step.effect.skills);
            applied = true;
            break loop;
          case "pickRoots": {
            const roots = await handlers.resolveRoots(step.effect.kind);
            if (roots.length === 0) {
              state = {
                ...state,
                message: "no roots configured for this step",
              };
            } else if (roots.length === 1) {
              state = openPicker(state, step.effect.kind, roots[0]);
              state = setPickerListing(state, await handlers.readDir(roots[0]));
            } else {
              state = openRootPicker(state, step.effect.kind, roots);
            }
            break;
          }
          case "readDir":
            state = setPickerListing(
              state,
              await handlers.readDir(step.effect.path),
            );
            break;
          case "quit":
            break loop;
        }
        await paint();
      }
    }
  } finally {
    await term.close();
  }
  return { applied };
}

/**
 * Run the global-config wizard to completion. Retained for the single-step global editor and
 * its tests. Only `save` / `quit` effects can arise from a global-only state.
 */
export async function startWizard(
  opts: WizardOptions,
  io: WizardIo,
  deps: WizardDeps,
): Promise<WizardResult> {
  const save = deps.save ??
    (async (codeRoots: string[], skillsRoots: string[]) => {
      await saveGlobalConfig(makeGlobalConfig(codeRoots, skillsRoots));
    });
  const initial = initialGlobalState(
    opts.codeRoots,
    opts.skillsRoots,
    colorEnabled(opts.noColor),
  );
  return await runLoop(initial, io, deps, {
    save,
    apply: () => Promise.resolve(),
    resolveRoots: deps.resolveRoots ?? (() => Promise.resolve([])),
    readDir: deps.readDir ?? defaultReadDir,
  });
}

/** Options for the full four-step project wizard. */
export interface ProjectWizardOptions extends ProjectWizardInit {
  /** Absolute project directory the config is written under. */
  projectDir: string;
  /** Expanded code roots for the source picker. */
  codeRoots: string[];
  /** Expanded skills roots for the skills picker. */
  skillsRoots: string[];
}

/** Run the full project wizard to completion, applying on Apply. */
export async function startProjectWizard(
  opts: ProjectWizardOptions,
  io: WizardIo,
  deps: WizardDeps,
): Promise<WizardResult> {
  const apply = deps.apply ??
    (async (source: MountRow[], skills: MountRow[]) => {
      const result = await applySelection(opts.projectDir, { source, skills });
      const label = result.created ? "Created" : "Updated";
      console.log(`${label} ${result.configPath}`);
      if (result.created) {
        console.log(`  + ${opts.projectDir}/.devcontainer/Dockerfile`);
        console.log(`  + ${opts.projectDir}/.devcontainer/features/`);
      }
    });
  const save = deps.save ??
    (async (codeRoots: string[], skillsRoots: string[]) => {
      await saveGlobalConfig(makeGlobalConfig(codeRoots, skillsRoots));
    });
  const resolveRoots = deps.resolveRoots ??
    ((kind: MountKind) =>
      Promise.resolve(kind === "source" ? opts.codeRoots : opts.skillsRoots));
  const readDir = deps.readDir ?? defaultReadDir;

  return await runLoop(initialProjectState(opts), io, deps, {
    save,
    apply,
    resolveRoots,
    readDir,
  });
}

/**
 * Open the global-config editor for `devc config` (and the first-run flow), seeded from the
 * current on-disk config. Enters raw mode against the real TTY.
 */
export async function runGlobalConfigWizard(
  io: WizardIo,
): Promise<WizardResult> {
  const cfg = await loadGlobalConfig();
  return await startWizard(
    { codeRoots: cfg.codeRoots, skillsRoots: cfg.skillsRoots },
    io,
    {
      input: Deno.stdin.readable,
      output: Deno.stdout.writable,
      size: () => Deno.consoleSize(),
      raw: true,
    },
  );
}

/**
 * Seed the source/skills rows for a project wizard from the base config text's fences. If the
 * base has no fences, source starts empty and skills is pre-seeded from `recentSkills`
 * (filtered to host paths that still exist — raw stored values are expanded for the check).
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

async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Open the full project wizard for `devc config [PATH]`. Resolves the base per precedence
 * (existing `PATH/.devcontainer/devcontainer.json`, else the bundled default), seeds the
 * source/skills steps, and (when `includeGlobalStep`) prepends the Global config step.
 */
export async function runProjectConfigWizard(
  projectDir: string,
  io: WizardIo,
  includeGlobalStep: boolean,
): Promise<WizardResult> {
  const cfg = await loadGlobalConfig();
  const configPath = `${projectDir}/.devcontainer/devcontainer.json`;

  let baseText: string;
  let creating: boolean;
  try {
    baseText = await Deno.readTextFile(configPath);
    creating = false;
  } catch {
    baseText = (await loadBundledDefault()).devcontainerJson;
    creating = true;
  }

  const { sourceRows, skillsRows } = await seedRows(baseText, cfg.recentSkills);

  const opts: ProjectWizardOptions = {
    projectDir,
    basePath: configPath,
    creating,
    sourceRows,
    skillsRows,
    color: colorEnabled(),
    codeRoots: cfg.codeRootsExpanded(),
    skillsRoots: cfg.skillsRootsExpanded(),
    globalStep: includeGlobalStep
      ? { codeRoots: cfg.codeRoots, skillsRoots: cfg.skillsRoots }
      : undefined,
  };

  return await startProjectWizard(opts, io, {
    input: Deno.stdin.readable,
    output: Deno.stdout.writable,
    size: () => Deno.consoleSize(),
    raw: true,
  });
}

/** Re-export so callers do not reach past this module to the config layer. */
export { globalConfigExists };
