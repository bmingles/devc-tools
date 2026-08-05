// A type-to-filter, multi-select folder picker. Same shape as the rest of the TUI: a pure
// state machine (`reduce` + `render`, no IO) wrapped by a thin loop that owns the terminal, so
// the whole interaction is scriptable headlessly (see `tests/folder_picker_test.ts`).
//
// The frame follows the mockups in `.plans/design/wizard/`: a screen banner, then two labelled
// sections — what is picked so far, over the browser you add from — separated by whitespace
// rather than rules, and one full-width divider above the footer legend. Both sections are
// always styled the same; the live one is simply the one holding the `▸` cursor, so the picks
// never look like a read-only summary. ↑ off the top of the browser steps up into the picks; ↓
// off the bottom of the picks drops back down (tab toggles too). The picks section lets you
// remove a folder directly, without having to navigate back to it in the tree. A caller may also
// pin one folder (the project folder, which the container mounts on its own): it heads the picks
// with `◎` and is inert in the tree, so an empty picks list can't read as "nothing gets mounted".
//
// Mental model (one axis per input, so the legend is a reminder, not a manual):
//   browser  ↑/↓ move (↑ at top → picks) · → open · ← up · space tick/untick · ⏎ done · esc cancel
//   picks    ↑/↓ move (↓ at bottom → browser) · space/⌫ remove · tab/← back · ⏎ done · esc cancel
//   type to filter the current folder;  backspace deletes filter, then walks up when empty.

import { dirname, join, resolve } from 'jsr:@std/path@^1';
import { type Key, KeyDecoder } from './keys.ts';
import { type Size, Terminal } from './term.ts';

// ── State ────────────────────────────────────────────────────────────────────

/** A per-entry annotation shown in the tree view (currently: git-worktree status). */
export interface EntryFlag {
  /** The entry is a git worktree. */
  worktree: boolean;
  /** Its primary repo can be mounted alongside it (relative paths + primary under a root). */
  valid: boolean;
  /** Why it is invalid, shown next to the entry. */
  reason?: string;
}

/** Per-screen copy. Every string is shown verbatim; see `.plans/design/wizard/` for the set. */
export interface PickerLabels {
  /** Mode banner on the first line, e.g. `WORKSPACE CONFIG`. */
  screen: string;
  /** Heading over the picked list, e.g. `Source Folders`. */
  picks: string;
  /** Heading over the browser, e.g. `Add Source Folders`. */
  browse: string;
}

export const DEFAULT_LABELS: PickerLabels = {
  screen: 'CONFIG',
  picks: 'Selected',
  browse: 'Add Folders',
};

/**
 * A folder that is mounted whatever you pick — the project folder, which the dev container binds
 * on its own. Shown as a fixed row in the picks (and un-tickable in the tree) so an empty picks
 * list never reads as "nothing gets mounted".
 */
export interface PinnedEntry {
  /** Absolute host path that is mounted implicitly. */
  path: string;
  /** Short reason shown beside it, e.g. "this project (always mounted)". */
  note: string;
}

export interface PickerState {
  /** Banner + section headings for this screen. */
  labels: PickerLabels;
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
  pinned: PinnedEntry | null; // implicitly mounted, not part of `selected` and not toggleable
  flags: Map<string, EntryFlag>; // per-entry annotations for the current `cwd` view (by name)
  focus: 'tree' | 'selected'; // which pane keys drive (the browser, or the picks list)
  selCursor: number; // index into `selected` when `focus === "selected"`
  color: boolean;
  done: boolean; // ⏎ — caller should read `selected`
  cancelled: boolean; // esc / ctrl-c
}

export type Effect = { type: 'none' } | { type: 'readDir'; path: string }; // loop lists `path`, then calls `setListing`

export function initialState(
  cwd: string,
  color: boolean,
  preselected: string[] = [],
  roots: string[] | null = null,
  labels: PickerLabels = DEFAULT_LABELS,
  pinned: PinnedEntry | null = null,
): PickerState {
  const normalizedRoots = roots === null ? null : roots.map((r) => resolve(r));
  const pin = pinned === null ? null : { ...pinned, path: resolve(pinned.path) };
  // A single configured root needs no synthetic "roots" list — open straight inside it.
  const singleRoot = normalizedRoots !== null && normalizedRoots.length === 1;
  return {
    labels,
    roots: normalizedRoots,
    atRoots: normalizedRoots !== null && !singleRoot, // multi-root opens on the roots list
    cwd: resolve(singleRoot ? normalizedRoots[0] : cwd),
    entries: [],
    filter: '',
    cursor: 0,
    // The pinned folder is already mounted, so it never doubles as a pick (a config that named
    // it explicitly would otherwise show up twice, and re-mount onto the same target).
    selected: preselected.filter((p) => resolve(p) !== pin?.path),
    pinned: pin,
    flags: new Map(),
    focus: 'tree',
    selCursor: 0,
    color,
    done: false,
    cancelled: false,
  };
}

/** The current view's items (roots list when `atRoots`, else `cwd`'s subdirs), filtered. */
export function visible(state: PickerState): string[] {
  const items = state.atRoots ? (state.roots ?? []) : state.entries;
  const needle = state.filter.toLowerCase();
  if (needle === '') return items;
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
    filter: '',
    cursor: 0,
    flags: new Map(), // stale until the loop re-annotates the new listing
  };
}

/** Install per-entry annotations for the current listing (see `PickerOptions.annotate`). */
export function setFlags(
  state: PickerState,
  flags: Map<string, EntryFlag>,
): PickerState {
  return { ...state, flags };
}

// ── Reducer (pure) ─────────────────────────────────────────────────────────────

export interface Step {
  state: PickerState;
  effect: Effect;
}

const NONE: Effect = { type: 'none' };

export function reduce(state: PickerState, key: Key): Step {
  if (state.focus === 'selected') return reduceSelected(state, key);

  const list = visible(state);
  const focused = list[state.cursor];

  switch (key.name) {
    case 'up':
      // At the top of the browser, ↑ steps up into the picks pane sitting above it (landing on
      // the pick nearest the browser). Keeps the two stacked lists feeling like one column.
      if (state.cursor === 0 && state.selected.length > 0) {
        return {
          state: {
            ...state,
            focus: 'selected',
            selCursor: state.selected.length - 1,
          },
          effect: NONE,
        };
      }
      return {
        state: { ...state, cursor: clampCursor(state.cursor - 1, list.length) },
        effect: NONE,
      };
    case 'down':
      return {
        state: { ...state, cursor: clampCursor(state.cursor + 1, list.length) },
        effect: NONE,
      };

    case 'right': {
      if (focused === undefined) return { state, effect: NONE };
      // In the roots view `focused` is already an absolute path; in the tree it is a subdir name.
      const path = state.atRoots ? focused : join(state.cwd, focused);
      return { state, effect: { type: 'readDir', path } };
    }
    case 'left':
      return goUp(state);

    case 'tab':
      // Jump into the picks pane to prune selections (no-op when there is nothing picked).
      if (state.selected.length === 0) return { state, effect: NONE };
      return {
        state: {
          ...state,
          focus: 'selected',
          selCursor: clampCursor(state.selCursor, state.selected.length),
        },
        effect: NONE,
      };

    case 'backspace':
      if (state.filter !== '') {
        const filter = state.filter.slice(0, -1);
        return { state: { ...state, filter, cursor: 0 }, effect: NONE };
      }
      return goUp(state); // empty filter: backspace walks up, like a breadcrumb

    case 'char': {
      if (key.char === ' ') {
        // Roots are boundaries, not selections — space does nothing in the roots view.
        return state.atRoots ? { state, effect: NONE } : toggle(state, focused);
      }
      const filter = state.filter + (key.char ?? '');
      return { state: { ...state, filter, cursor: 0 }, effect: NONE };
    }

    case 'enter':
      return { state: { ...state, done: true }, effect: NONE };
    case 'escape':
    case 'ctrl-c':
      return { state: { ...state, cancelled: true }, effect: NONE };

    default:
      return { state, effect: NONE };
  }
}

/** Reducer for the picks pane: move over ticked folders and remove them directly. */
function reduceSelected(state: PickerState, key: Key): Step {
  const n = state.selected.length;
  switch (key.name) {
    case 'up':
      return {
        state: { ...state, selCursor: clampCursor(state.selCursor - 1, n) },
        effect: NONE,
      };
    case 'down':
      // Off the bottom of the picks, ↓ drops back into the browser below.
      if (state.selCursor >= n - 1) {
        return { state: { ...state, focus: 'tree', cursor: 0 }, effect: NONE };
      }
      return {
        state: { ...state, selCursor: clampCursor(state.selCursor + 1, n) },
        effect: NONE,
      };

    case 'tab':
    case 'left':
    case 'right':
      return { state: { ...state, focus: 'tree' }, effect: NONE };

    case 'backspace':
      return removeSelected(state);
    case 'char':
      return key.char === ' ' ? removeSelected(state) : { state, effect: NONE };

    case 'enter':
      return { state: { ...state, done: true }, effect: NONE };
    case 'escape':
    case 'ctrl-c':
      return { state: { ...state, cancelled: true }, effect: NONE };

    default:
      return { state, effect: NONE };
  }
}

/** Drop the focused pick; fall back to the browser once the picks list empties. */
function removeSelected(state: PickerState): Step {
  const n = state.selected.length;
  if (n === 0) return { state: { ...state, focus: 'tree' }, effect: NONE };
  const idx = clampCursor(state.selCursor, n);
  const selected = state.selected.filter((_, i) => i !== idx);
  if (selected.length === 0) {
    return {
      state: { ...state, selected, selCursor: 0, focus: 'tree' },
      effect: NONE,
    };
  }
  return {
    state: {
      ...state,
      selected,
      selCursor: Math.min(idx, selected.length - 1),
    },
    effect: NONE,
  };
}

function goUp(state: PickerState): Step {
  if (state.roots !== null) {
    // Bounded: never navigate above a root. At a root, `←` returns to the roots list — unless
    // there is only one root, which has no synthetic list to return to, so it's a no-op.
    if (state.atRoots) return { state, effect: NONE };
    if (state.roots.includes(state.cwd)) {
      if (state.roots.length <= 1) return { state, effect: NONE };
      return {
        state: { ...state, atRoots: true, filter: '', cursor: 0 },
        effect: NONE,
      };
    }
    return { state, effect: { type: 'readDir', path: dirname(state.cwd) } };
  }
  // Free: walk up to the filesystem root.
  const parent = dirname(state.cwd);
  if (parent === state.cwd) return { state, effect: NONE };
  return { state, effect: { type: 'readDir', path: parent } };
}

function toggle(state: PickerState, focused: string | undefined): Step {
  if (focused === undefined) return { state, effect: NONE };
  const path = join(state.cwd, focused);
  // The pinned folder is mounted either way — ticking it would only add a duplicate mount.
  if (path === state.pinned?.path) return { state, effect: NONE };
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
  const home = Deno.env.get('HOME');
  if (home && (path === home || path.startsWith(home + '/'))) {
    return '~' + path.slice(home.length);
  }
  return path;
}

// ── Frame chrome ─────────────────────────────────────────────────────────────
//
// The screen banner on line 1, then two labelled sections — the picks over the browser — set
// apart by blank lines, and one full-width rule above the footer legend. The sections carry no
// counts or box drawing: the headings say what each list is, and whitespace does the grouping.
//
// Section text never changes with focus: dimming the picks made them look like a read-out
// instead of a place you can prune. The live section is the one holding the `▸` row cursor
// (reverse-video on its row) — nothing else moves. Weight: banner (bold) > section headings
// (plain) > meta, hints and legend (dim).

/** A full-width horizontal divider. */
function hr(width: number, color: boolean): string {
  return DIM('─'.repeat(Math.max(1, width)), color);
}

/** A section heading: ` Heading  meta` — same weight whether the section is live or idle. */
function sectionHeader(title: string, meta: string, color: boolean): string {
  return ` ${title}` + (meta ? '  ' + DIM(meta, color) : '');
}

/**
 * One list row: `<cursor> <body>`. The `▸` marks the row cursor (reverse-video) and only
 * appears in the live section. `suffix` (e.g. a worktree warning) trails outside the highlight
 * so nested SGR codes don't clash.
 */
function listRow(
  body: string,
  opts: { cursor: boolean; color: boolean; suffix?: string },
): string {
  const { cursor, color, suffix } = opts;
  const inner = `${cursor ? '▸' : ' '} ${body}`;
  return (
    ` ${cursor ? REV(inner, color) : inner}` +
    (suffix ? (cursor ? suffix : DIM(suffix, color)) : '')
  );
}

export function render(state: PickerState, size: Size): string[] {
  const { color, atRoots } = state;
  const width = size.columns;
  const picksActive = state.focus === 'selected';
  const list = visible(state);
  const out: string[] = [];

  // The banner names the screen you are on; the two section headings below name its lists.
  out.push(BOLD(state.labels.screen, color));
  out.push('');

  // ── picks section ──
  const pinned = state.pinned;
  out.push(sectionHeader(state.labels.picks, '', color));
  out.push('');
  // The pinned row heads the section: a pick's shape with its own marker and no cursor, so it
  // reads as a given rather than something you chose — or could un-choose.
  if (pinned) {
    out.push(
      listRow(`◎ ${foldHome(pinned.path)}`, {
        cursor: false,
        color,
        suffix: `  ${pinned.note}`,
      }),
    );
  }
  // A pinned row is itself the answer to "what is mounted", so it stands alone; without one an
  // empty list still needs to say something.
  if (state.selected.length === 0) {
    if (!pinned) out.push('  ' + DIM('(none yet)', color));
  } else {
    const cap = Math.max(3, Math.min(8, size.rows - 12));
    const shown = Math.min(state.selected.length, cap);
    const first = picksActive
      ? Math.max(
          0,
          Math.min(
            state.selCursor - Math.floor(shown / 2),
            state.selected.length - shown,
          ),
        )
      : 0;
    state.selected.slice(first, first + shown).forEach((p, i) => {
      const idx = first + i;
      out.push(
        listRow(`◉ ${foldHome(p)}`, {
          cursor: picksActive && idx === state.selCursor,
          color,
        }),
      );
    });
    if (state.selected.length > shown) {
      out.push(
        '  ' + DIM(`… and ${state.selected.length - shown} more`, color),
      );
    }
  }

  // ── browse section ──
  // Blank line, not a rule: the two lists are one column, and a divider read as a hard split.
  out.push('');
  // At the synthetic roots list there is no current directory to name — the heading stands alone.
  out.push(
    sectionHeader(
      state.labels.browse,
      atRoots ? '' : foldHome(state.cwd) + '/',
      color,
    ),
  );
  out.push(
    '  ' +
      DIM('> ', color) +
      (state.filter || DIM('type to filter folders', color)),
  );

  // The browser gets whatever rows remain between the filter line and the footer (divider +
  // legend). Keep the cursor in view.
  const room = Math.max(3, size.rows - out.length - 2);
  if (list.length === 0) {
    const empty = atRoots
      ? '(no roots configured)'
      : state.entries.length === 0
        ? '(no subfolders)'
        : '(no matches)';
    out.push('  ' + DIM(empty, color));
  }
  const first = Math.max(
    0,
    Math.min(state.cursor - Math.floor(room / 2), list.length - room),
  );
  list.slice(first, first + room).forEach((name, i) => {
    const idx = first + i;
    const isCursor = idx === state.cursor && !picksActive;
    // Roots are navigable boundaries, not selections: no checkbox.
    const abs = atRoots ? null : join(state.cwd, name);
    const isPinned = abs !== null && abs === pinned?.path;
    // `◎` is `◉` with a hollow centre — on, but not by you, and not yours to change.
    const mark = isPinned ? '◎' : state.selected.includes(abs ?? '') ? '◉' : '◯';
    const body = atRoots ? `  ${foldHome(name)}/` : `${mark} ${name}/`;
    let suffix: string | undefined;
    if (isPinned) {
      // Ticked-looking but inert — say why, so the dead space bar isn't a mystery.
      suffix = `  ${pinned!.note}`;
    } else if (!atRoots) {
      const flag = state.flags.get(name);
      if (flag?.worktree && !flag.valid) {
        suffix =
          '  ⚠ primary not mounted' + (flag.reason ? ` (${flag.reason})` : '');
      }
    }
    out.push(listRow(body, { cursor: isCursor, color, suffix }));
  });

  // Footer: a divider, then a short hint for the live section — the cursor carries the rest, so
  // this is a reminder, not a manual.
  while (out.length < size.rows - 2) out.push('');
  out.push(hr(width, color));
  // `↑ into selected` only when there is a pick to step into — the pinned row is not one, and
  // advertising a dead key next to a visibly occupied list is worse than saying nothing.
  const intoPicks = state.selected.length > 0 ? '↑ into selected · ' : '';
  const legend = picksActive
    ? ' space remove · ↓ back to browse · ⏎ done · esc cancel'
    : atRoots
      ? ` → open · ${intoPicks}⏎ done · esc cancel`
      : ` space pick · → open · ← up · ${intoPicks}⏎ done · esc cancel`;
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
  /** Banner + section headings for this screen (e.g. `WORKSPACE CONFIG` / `Source Folders`). */
  labels: PickerLabels;
  /** Directory the picker opens in (free mode only; ignored when `roots` is given). */
  start: string;
  /** Absolute paths to pre-tick (e.g. folders already configured). */
  preselected?: string[];
  /**
   * A folder mounted regardless of the picks (see `PinnedEntry`). Displayed in SELECTED and
   * marked in the tree, but never selectable, and never part of the returned paths.
   */
  pinned?: PinnedEntry;
  /**
   * Bounded mode: absolute boundary directories shown as the top level; navigation can't go
   * above them and the roots themselves aren't selectable. Omit for free filesystem mode.
   */
  roots?: string[];
  /**
   * Optional per-listing annotator (tree view only). Given the current dir and its subdir
   * names, returns a flag per name to surface in the tree (e.g. worktree status). Runs after
   * each directory is listed.
   */
  annotate?: (dir: string, names: string[]) => Promise<Map<string, EntryFlag>>;
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
  'devc: the folder picker needs an interactive terminal';

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
    const isTerminal =
      deps.isTerminal ??
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
    opts.labels,
    opts.pinned ?? null,
  );
  // Annotate the freshly-listed tree view (no-op when no annotator, or on the roots list).
  const annotated = async (s: PickerState): Promise<PickerState> => {
    if (opts.annotate === undefined || s.atRoots) return s;
    return setFlags(s, await opts.annotate(s.cwd, s.entries));
  };

  // Whenever we don't open on the roots list — free mode, or a single bounded root we start
  // inside — list that starting directory now. Multi-root bounded mode shows the roots first.
  if (!state.atRoots) {
    state = await annotated(
      setListing(state, state.cwd, await readDir(state.cwd)),
    );
  }

  const term = await Terminal.open({
    output: deps.output,
    raw,
    size: deps.size,
  });
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
        if (step.effect.type === 'readDir') {
          state = await annotated(
            setListing(
              state,
              step.effect.path,
              await readDir(step.effect.path),
            ),
          );
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
