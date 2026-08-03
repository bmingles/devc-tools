// A type-to-filter, multi-select folder picker. Same shape as the rest of the TUI: a pure
// state machine (`reduce` + `render`, no IO) wrapped by a thin loop that owns the terminal, so
// the whole interaction is scriptable headlessly (see `tests/folder_picker_test.ts`).
//
// Mental model (one axis per input, so the legend is a reminder, not a manual):
//   ↑/↓  move within the current folder      space  tick / untick (selection persists)
//   →    open the focused folder             ⏎      done — return everything ticked
//   ←    go up a level                        esc    cancel
//   type to filter the current folder;  backspace deletes filter, then walks up when empty.

import { dirname, join, resolve } from "jsr:@std/path@^1";
import { type Key, KeyDecoder } from "./keys.ts";
import { type Size, Terminal } from "./term.ts";

// ── State ────────────────────────────────────────────────────────────────────

export interface PickerState {
  /** Heading shown at the top of the picker — describes what is being picked. */
  title: string;
  /**
   * Bounded mode: absolute boundary directories you may not navigate above, shown as the
   * top-level list. `null` = free mode (roam the whole filesystem, select any directory).
   */
  roots: string[] | null;
  /** Bounded mode only: true while showing the roots list (the synthetic top level). */
  atRoots: boolean;
  cwd: string; // absolute path of the folder being browsed (when not `atRoots`)
  entries: string[]; // subdirectory names in `cwd`, sorted (dirs only)
  filter: string; // type-to-filter text for the current view
  cursor: number; // index into the *filtered* list
  selected: string[]; // absolute paths ticked so far, in the order ticked
  color: boolean;
  done: boolean; // ⏎ — caller should read `selected`
  cancelled: boolean; // esc / ctrl-c
}

export type Effect =
  | { type: "none" }
  | { type: "readDir"; path: string }; // loop lists `path`, then calls `setListing`

export function initialState(
  cwd: string,
  color: boolean,
  preselected: string[] = [],
  roots: string[] | null = null,
  title = "Pick folders",
): PickerState {
  const normalizedRoots = roots === null ? null : roots.map((r) => resolve(r));
  return {
    title,
    roots: normalizedRoots,
    atRoots: normalizedRoots !== null, // bounded mode opens on the roots list
    cwd: resolve(cwd),
    entries: [],
    filter: "",
    cursor: 0,
    selected: [...preselected],
    color,
    done: false,
    cancelled: false,
  };
}

/** The current view's items (roots list when `atRoots`, else `cwd`'s subdirs), filtered. */
export function visible(state: PickerState): string[] {
  const items = state.atRoots ? (state.roots ?? []) : state.entries;
  const needle = state.filter.toLowerCase();
  if (needle === "") return items;
  return items.filter((n) => n.toLowerCase().includes(needle));
}

function clampCursor(cursor: number, len: number): number {
  if (len === 0) return 0;
  return Math.max(0, Math.min(cursor, len - 1));
}

/** After the loop reads a directory, install its listing and drop into the tree view. */
export function setListing(
  state: PickerState,
  path: string,
  names: string[],
): PickerState {
  return {
    ...state,
    atRoots: false,
    cwd: resolve(path),
    entries: names,
    filter: "",
    cursor: 0,
  };
}

// ── Reducer (pure) ─────────────────────────────────────────────────────────────

export interface Step {
  state: PickerState;
  effect: Effect;
}

const NONE: Effect = { type: "none" };

export function reduce(state: PickerState, key: Key): Step {
  const list = visible(state);
  const focused = list[state.cursor];

  switch (key.name) {
    case "up":
      return { state: { ...state, cursor: clampCursor(state.cursor - 1, list.length) }, effect: NONE };
    case "down":
      return { state: { ...state, cursor: clampCursor(state.cursor + 1, list.length) }, effect: NONE };

    case "right": {
      if (focused === undefined) return { state, effect: NONE };
      // In the roots view `focused` is already an absolute path; in the tree it is a subdir name.
      const path = state.atRoots ? focused : join(state.cwd, focused);
      return { state, effect: { type: "readDir", path } };
    }
    case "left":
      return goUp(state);

    case "backspace":
      if (state.filter !== "") {
        const filter = state.filter.slice(0, -1);
        return { state: { ...state, filter, cursor: 0 }, effect: NONE };
      }
      return goUp(state); // empty filter: backspace walks up, like a breadcrumb

    case "char": {
      if (key.char === " ") {
        // Roots are boundaries, not selections — space does nothing in the roots view.
        return state.atRoots ? { state, effect: NONE } : toggle(state, focused);
      }
      const filter = state.filter + (key.char ?? "");
      return { state: { ...state, filter, cursor: 0 }, effect: NONE };
    }

    case "enter":
      return { state: { ...state, done: true }, effect: NONE };
    case "escape":
    case "ctrl-c":
      return { state: { ...state, cancelled: true }, effect: NONE };

    default:
      return { state, effect: NONE };
  }
}

function goUp(state: PickerState): Step {
  if (state.roots !== null) {
    // Bounded: never navigate above a root. At a root, `←` returns to the roots list.
    if (state.atRoots) return { state, effect: NONE };
    if (state.roots.includes(state.cwd)) {
      return {
        state: { ...state, atRoots: true, filter: "", cursor: 0 },
        effect: NONE,
      };
    }
    return { state, effect: { type: "readDir", path: dirname(state.cwd) } };
  }
  // Free: walk up to the filesystem root.
  const parent = dirname(state.cwd);
  if (parent === state.cwd) return { state, effect: NONE };
  return { state, effect: { type: "readDir", path: parent } };
}

function toggle(state: PickerState, focused: string | undefined): Step {
  if (focused === undefined) return { state, effect: NONE };
  const path = join(state.cwd, focused);
  const selected = state.selected.includes(path)
    ? state.selected.filter((p) => p !== path)
    : [...state.selected, path];
  return { state: { ...state, selected }, effect: NONE };
}

// ── Render (pure) ──────────────────────────────────────────────────────────────

const DIM = (s: string, on: boolean) => (on ? `\x1b[2m${s}\x1b[0m` : s);
const BOLD = (s: string, on: boolean) => (on ? `\x1b[1m${s}\x1b[0m` : s);
const REV = (s: string, on: boolean) => (on ? `\x1b[7m${s}\x1b[0m` : s);

/** Fold `$HOME` back to `~` so long paths read at a glance. */
function foldHome(path: string): string {
  const home = Deno.env.get("HOME");
  if (home && (path === home || path.startsWith(home + "/"))) {
    return "~" + path.slice(home.length);
  }
  return path;
}

export function render(state: PickerState, size: Size): string[] {
  const { color, atRoots } = state;
  const list = visible(state);
  const out: string[] = [];

  out.push(" " + BOLD(state.title, color));
  out.push("");
  out.push(
    " " + (atRoots ? DIM("roots", color) : foldHome(state.cwd) + DIM("/", color)),
  );
  out.push(
    " " + DIM("filter: ", color) + (state.filter || DIM("(type to filter)", color)),
  );
  out.push("");

  if (list.length === 0) {
    const empty = atRoots
      ? "(no roots configured)"
      : state.entries.length === 0
      ? "(no subfolders)"
      : "(no matches)";
    out.push("   " + DIM(empty, color));
  }
  // A viewport so long folders don't overflow: keep the cursor in view.
  const room = Math.max(3, size.rows - 12);
  const start = Math.max(0, Math.min(state.cursor - Math.floor(room / 2), list.length - room));
  list.slice(start, start + room).forEach((name, i) => {
    const idx = start + i;
    const isCursor = idx === state.cursor;
    const gutter = isCursor ? ">" : " ";
    // Roots are navigable boundaries, not selections: no checkbox, show them folded.
    const row = atRoots
      ? ` ${gutter}   ${foldHome(name)}/`
      : ` ${gutter} ${
        state.selected.includes(join(state.cwd, name)) ? "◉" : "◯"
      } ${name}/`;
    out.push(isCursor ? REV(row, color) : row);
  });

  out.push("");
  out.push(" " + DIM(`selected (${state.selected.length}):`, color));
  if (state.selected.length === 0) {
    const hint = atRoots
      ? "open a root (→) to pick folders inside it"
      : "nothing yet — space to tick the highlighted folder";
    out.push("   " + DIM(hint, color));
  } else {
    for (const p of state.selected.slice(-4)) out.push("   " + foldHome(p));
    if (state.selected.length > 4) out.push("   " + DIM(`… and ${state.selected.length - 4} more`, color));
  }

  // Footer legend, pinned to the last row — tailored to the current view.
  while (out.length < size.rows - 1) out.push("");
  const legend = atRoots
    ? " ↑↓ move   → open   ⏎ done   esc cancel"
    : " ↑↓ move   → open   ← up   space pick   ⏎ done   esc cancel";
  out.push(DIM(legend, color));
  return out.slice(0, size.rows);
}

// ── Loop (the only IO) ──────────────────────────────────────────────────────────

/** List subdirectory names of `path`, sorted case-insensitively; `[]` on any error. */
export async function listDirs(path: string): Promise<string[]> {
  const names: string[] = [];
  try {
    for await (const entry of Deno.readDir(path)) {
      if (entry.isDirectory) names.push(entry.name);
    }
  } catch {
    return [];
  }
  return names.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}

export interface PickerOptions {
  /** Heading describing what is being picked (e.g. "Pick source folders"). */
  title: string;
  /** Directory the picker opens in (free mode only; ignored when `roots` is given). */
  start: string;
  /** Absolute paths to pre-tick (e.g. folders already configured). */
  preselected?: string[];
  /**
   * Bounded mode: absolute boundary directories shown as the top level; navigation can't go
   * above them and the roots themselves aren't selectable. Omit for free filesystem mode.
   */
  roots?: string[];
  color?: boolean;
}

/** Injected IO so the picker can run and be observed headlessly (mirrors `WizardDeps`). */
export interface PickerDeps {
  input: ReadableStream<Uint8Array>;
  output: WritableStream<Uint8Array>;
  size: () => Size;
  /** Enter raw mode + the alternate screen. Off in tests. */
  raw?: boolean;
  /** List subdirectory names of a path. Defaults to `listDirs` (real filesystem). */
  readDir?: (path: string) => Promise<string[]>;
  /** Overridable so tests can prove the non-TTY refusal without a TTY. */
  isTerminal?: () => boolean;
  err?: (msg: string) => void;
}

export const NOT_A_TERMINAL =
  "devc: the folder picker needs an interactive terminal";

/**
 * Run the picker to completion. Returns the ticked absolute paths on `⏎`, or `null` on `esc`
 * (or a non-TTY refusal). The terminal is always restored (`close()` in a `finally`).
 */
export async function pickFolders(
  opts: PickerOptions,
  deps: PickerDeps,
): Promise<string[] | null> {
  const raw = deps.raw ?? false;
  const readDir = deps.readDir ?? listDirs;
  if (raw) {
    const isTerminal = deps.isTerminal ??
      (() => Deno.stdin.isTerminal() && Deno.stdout.isTerminal());
    if (!isTerminal()) {
      deps.err?.(NOT_A_TERMINAL);
      return null;
    }
  }

  let state = initialState(
    opts.start,
    opts.color ?? true,
    opts.preselected,
    opts.roots ?? null,
    opts.title,
  );
  // Free mode opens inside a directory (list it now); bounded mode opens on the roots list.
  if (state.roots === null) {
    state = setListing(state, state.cwd, await readDir(state.cwd));
  }

  const term = await Terminal.open({ output: deps.output, raw, size: deps.size });
  const paint = async () => await term.paint(render(state, term.size()));

  // A manual reader (not `for await`) so releasing the lock leaves stdin open and re-lockable
  // for the next step in the flow — `for await` would cancel the shared stream.
  const reader = deps.input.getReader();
  try {
    term.onResize(() => void paint());
    await paint();

    const decoder = new KeyDecoder();
    while (true) {
      const { value, done } = await reader.read();
      if (done) return null;
      for (const k of decoder.push(value)) {
        const step = reduce(state, k);
        state = step.state;
        if (step.effect.type === "readDir") {
          state = setListing(state, step.effect.path, await readDir(step.effect.path));
        }
        if (state.done) return state.selected;
        if (state.cancelled) return null;
        await paint();
      }
    }
  } finally {
    reader.releaseLock();
    await term.close();
  }
}
