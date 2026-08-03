// The shell around the pure core: load the same context the CLI loads, own the terminal,
// feed bytes to the decoder, hand keys to `reduce`, and perform the three effects it can ask
// for — `write`, `rescan`, `quit`.
//
// All IO is injected, so `tui_app_test.ts` can script a key sequence, collect the frames, and
// assert on the files written without a TTY anywhere in sight.

import { relative, resolve } from "jsr:@std/path@^1";
import {
  applySelection,
  type Io,
  loadContext,
  loadState,
  type Options,
  type State,
} from "../cli.ts";
import { displayPath, requireRoot, RuntimeError, UsageError } from "../config.ts";
import { readFileOrNull } from "../devcontainer.ts";
import { scanRoot } from "../scan.ts";
import { listSkills, type Skill } from "../skills.ts";
import { KeyDecoder } from "./keys.ts";
import { colorEnabled, render, type Size } from "./render.ts";
import {
  type Effect,
  initialState,
  markSaved,
  reduce,
  rescanned,
  setSize,
  type UiState,
  withMessage,
} from "./state.ts";
import { Terminal } from "./term.ts";

export const NOT_A_TERMINAL =
  'devc: not a terminal; use "devc list" / "devc select ..." instead';

export interface AppDeps {
  opts: Options;
  io: Io;
  input: ReadableStream<Uint8Array>;
  output: WritableStream<Uint8Array>;
  size: () => Size;
  /** Enter raw mode and the alternate screen. Off in tests. */
  raw?: boolean;
}

/**
 * Run the interactive tree to completion. Returns the process exit code; the terminal is
 * restored before anything is thrown onwards.
 */
export async function runApp(deps: AppDeps): Promise<number> {
  const ctx = await loadContext(deps.opts, deps.io);
  const cliState = await loadState(ctx);
  const skillsRoot = ctx.cfg.skillsRoot.trim() === "" ? "" : resolve(ctx.cfg.skillsRoot);
  let skills: Skill[] = skillsRoot === "" ? [] : await listSkills(skillsRoot);

  // The message line is one row: target files are named relative to the workspace dir so a
  // deep temp path or a long $HOME does not push the prompt off the end of it.
  const label = (path: string) => {
    const rel = relative(ctx.workspaceDir, path);
    return rel !== "" && !rel.startsWith("..") ? rel : displayPath(path);
  };

  let ui = initialState({
    cfg: ctx.cfg,
    tree: cliState.tree,
    skills,
    skillsRoot,
    selection: cliState.selection,
    skillSelection: cliState.skills,
    paths: { devcontainer: label(ctx.targets.devcontainer), workspaceFile: label(ctx.targets.workspaceFile) },
    needsCreate: cliState.devcontainerSrc === null,
    color: colorEnabled(deps.opts.noColor),
  });
  if (cliState.warnings.length > 0) ui = withMessage(ui, cliState.warnings[0]);

  const term = await Terminal.open({ output: deps.output, raw: deps.raw ?? false, size: deps.size });
  const paint = async () => {
    const size = term.size();
    ui = setSize(ui, size);
    await term.paint(render(ui, size));
  };

  try {
    term.onResize(() => void paint());
    await paint();

    const decoder = new KeyDecoder();
    loop: for await (const chunk of deps.input) {
      for (const k of decoder.push(chunk)) {
        const step = reduce(ui, k);
        ui = step.state;
        if (step.effect !== undefined) {
          const done = await perform(step.effect);
          if (done) break loop;
        }
        await paint();
      }
    }
  } finally {
    await term.close();
  }
  return 0;

  /** Perform one effect; returns true when the app should stop. */
  async function perform(effect: Effect): Promise<boolean> {
    switch (effect.type) {
      case "write":
        await write();
        return false;
      case "rescan":
        await rescan();
        return false;
      case "quit":
        if (effect.save) await write();
        return true;
    }
  }

  async function write(): Promise<void> {
    try {
      // `reduce` only emits `write` for a missing devcontainer after the user confirmed it.
      ctx.opts.create = true;
      const result = await applySelection(ctx, syncedState(cliState, ui));
      const message = result.changed.length === 0
        ? "no changes"
        : `wrote ${result.changed.map(label).join(", ")}`;
      cliState.devcontainerSrc = await readFileOrNull(ctx.targets.devcontainer);
      cliState.workspaceSrc = await readFileOrNull(ctx.targets.workspaceFile);
      ui = markSaved(ui, result.warnings.length > 0 ? `${message} (${result.warnings[0]})` : message);
    } catch (e) {
      ui = withMessage(ui, errorMessage(e));
    }
  }

  async function rescan(): Promise<void> {
    try {
      const root = requireRoot(ctx.cfg, ctx.loaded.path);
      const tree = await scanRoot(root, ctx.cfg.maxDepth, { workspaceDir: ctx.workspaceDir });
      skills = skillsRoot === "" ? [] : await listSkills(skillsRoot);
      cliState.tree = tree;
      ui = rescanned(ui, tree, skills, `rescanned ${displayPath(root)}`);
    } catch (e) {
      ui = withMessage(ui, errorMessage(e));
    }
  }
}

/** The CLI's `State`, carrying the UI's live selection. One shape, one write path. */
function syncedState(cliState: State, ui: UiState): State {
  return {
    tree: ui.tree,
    selection: new Set(ui.selection),
    skills: new Set(ui.skillSelection),
    devcontainerSrc: cliState.devcontainerSrc,
    workspaceSrc: cliState.workspaceSrc,
    warnings: [],
  };
}

function errorMessage(e: unknown): string {
  if (e instanceof UsageError || e instanceof RuntimeError) return e.message;
  if (e instanceof Error) return `devc: ${e.message}`;
  return `devc: ${String(e)}`;
}

export interface StartOptions {
  /** Overridable so tests can prove the non-TTY refusal without a TTY. */
  isTerminal?: () => boolean;
}

/** `devc` with no subcommand: the interactive tree, or a pointed refusal. */
export async function startTui(
  opts: Options,
  io: Io,
  start: StartOptions = {},
): Promise<number> {
  const isTerminal = start.isTerminal ?? (() => Deno.stdin.isTerminal() && Deno.stdout.isTerminal());
  if (!isTerminal()) {
    io.err(NOT_A_TERMINAL);
    return 2;
  }
  return await runApp({
    opts,
    io,
    input: Deno.stdin.readable,
    output: Deno.stdout.writable,
    size: () => Deno.consoleSize(),
    raw: true,
  });
}
