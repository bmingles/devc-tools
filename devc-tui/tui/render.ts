// The frame renderer: `UiState` → exactly `size.rows` lines of ASCII (plus SGR escapes when
// colour is on). Pure — it never touches the terminal; `term.ts` does the writing.
//
// Two invariants the tests pin down, because everything else in the UI depends on them:
//
//   1. exactly `size.rows` lines, none wider than `size.columns` once ANSI is stripped;
//   2. with colour off there are no escape sequences at all, and the text is identical to the
//      coloured frame with ANSI stripped — so nothing is ever *encoded* in colour alone.
//      That is why the cursor row carries a literal `>` gutter as well as reverse video.

import { displayPath } from "../config.ts";
import {
  type Confirm,
  derived,
  type Fold,
  isDirty,
  type Marker,
  type Row,
  type UiState,
  visibleRows,
} from "./state.ts";

export interface Size {
  columns: number;
  rows: number;
}

export const MIN_COLUMNS = 40;
export const MIN_ROWS = 10;
export const TOO_SMALL = `terminal too small (need ${MIN_COLUMNS}x${MIN_ROWS})`;

/** Lines used by the header, the message line and the keys line. */
const CHROME_ROWS = 3;

const SGR = {
  bold: "1",
  dim: "2",
  red: "31",
  green: "32",
  yellow: "33",
};

interface Seg {
  text: string;
  style?: string;
}

/** True unless the user opted out with `--no-color` or `NO_COLOR`. */
export function colorEnabled(noColor: boolean): boolean {
  if (noColor) return false;
  const flag = Deno.env.get("NO_COLOR");
  return flag === undefined || flag === "";
}

/** Strip SGR sequences — used for width math and by the tests. */
export function stripAnsi(text: string): string {
  // deno-lint-ignore no-control-regex -- matching ESC is the entire point
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

export function render(state: UiState, size: Size): string[] {
  const height = Math.max(0, size.rows);
  if (size.columns < MIN_COLUMNS || size.rows < MIN_ROWS) {
    const lines = [TOO_SMALL.slice(0, Math.max(0, size.columns))];
    while (lines.length < height) lines.push("");
    return lines.slice(0, height);
  }

  const rows = visibleRows(state);
  const bodyHeight = height - CHROME_ROWS;
  const overflow = rows.length > bodyHeight;
  const width = overflow ? size.columns - 1 : size.columns;
  const offset = Math.max(0, Math.min(state.offset, Math.max(0, rows.length - bodyHeight)));

  const lines: string[] = [compose(headerSegs(state, size.columns), size.columns, state.color, false)];

  if (state.mode === "help") {
    const help = helpLines();
    for (let i = 0; i < bodyHeight; i++) {
      lines.push(compose(help[i] ?? [], size.columns, state.color, false));
    }
  } else {
    for (let i = 0; i < bodyHeight; i++) {
      const index = offset + i;
      const row = rows[index];
      const cursor = row !== undefined && row.focusable && row.key === state.cursor;
      const text = compose(row === undefined ? [] : rowSegs(row, cursor), width, state.color, cursor);
      lines.push(overflow ? text + scrollbarCell(i, bodyHeight, offset, rows.length) : text);
    }
  }

  lines.push(compose(messageSegs(state), size.columns, state.color, false));
  lines.push(compose(keysSegs(state), size.columns, state.color, false));
  return lines;
}

// --- header ----------------------------------------------------------------------

/** Minimum run of spaces between the title and the counts. */
const HEADER_GAP = 3;

/**
 * `devc-tui  <root> -> <containerRoot>` on the left, live counts on the right. The counts and
 * the unsaved marker are what a narrow terminal must keep, so the root path is shortened from
 * its head (`.../src`) and then dropped entirely before either of them gives way.
 */
function headerSegs(state: UiState, columns: number): Seg[] {
  const d = derived(state);
  const counts = `${d.mounts.length} mounts  ${d.folders.length} folders  ` +
    `${state.skillSelection.size} skills`;
  const dirty = isDirty(state);
  const name = " devc-tui";
  const arrow = ` -> ${state.cfg.containerRoot}`;
  const candidates = dirty ? [`${counts}   *unsaved`, "*unsaved"] : [counts, ""];

  let right = candidates[candidates.length - 1];
  let left = name;
  for (const candidate of candidates) {
    const room = columns - name.length - 2 - arrow.length - candidate.length - HEADER_GAP;
    const where = room >= 8
      ? `  ${shortenHead(displayPath(state.tree.root), room)}${arrow}`
      : "";
    if (name.length + where.length + candidate.length + 1 <= columns) {
      left = name + where;
      right = candidate;
      break;
    }
  }

  const gap = Math.max(1, columns - left.length - right.length);
  const segs: Seg[] = [{ text: left, style: SGR.bold }, { text: " ".repeat(gap) }];
  if (right !== "") segs.push({ text: right, style: dirty ? SGR.yellow : undefined });
  return segs;
}

/** Keep the tail of a path — the interesting end — behind an ellipsis. */
function shortenHead(text: string, max: number): string {
  if (text.length <= max) return text;
  return `...${text.slice(text.length - Math.max(0, max - 3))}`;
}

// --- rows ------------------------------------------------------------------------

const MARKERS: Record<Marker, string> = {
  none: "   ",
  off: "[ ]",
  on: "[x]",
  auto: "[~]",
  partial: "[-]",
};

const FOLDS: Record<Fold, string> = {
  none: " ",
  expanded: "v",
  collapsed: ">",
  blocked: "x",
};

function markerStyle(marker: Marker): string | undefined {
  if (marker === "on") return SGR.green;
  if (marker === "auto" || marker === "partial") return SGR.yellow;
  return undefined;
}

function rowSegs(row: Row, cursor: boolean): Seg[] {
  if (row.kind === "blank") return [];
  if (row.kind === "section") return [{ text: ` ${row.label}`, style: SGR.bold }];
  if (row.kind === "note") return [{ text: `   ${row.label}`, style: SGR.dim }];

  const segs: Seg[] = [
    { text: cursor ? ">" : " " },
    { text: ` ${"  ".repeat(row.depth)}` },
    { text: FOLDS[row.fold], style: SGR.dim },
    { text: " " },
    { text: MARKERS[row.marker], style: markerStyle(row.marker) },
    { text: ` ${row.label}` },
  ];
  for (const note of row.notes) segs.push({ text: `  ${note}`, style: SGR.dim });
  for (const warning of row.warnings) segs.push({ text: `  ! ${warning}`, style: SGR.red });
  return segs;
}

/** `#` for the thumb, `|` for the track — only ever called when the body overflows. */
function scrollbarCell(
  slot: number,
  bodyHeight: number,
  offset: number,
  total: number,
): string {
  const size = Math.max(1, Math.round((bodyHeight * bodyHeight) / total));
  const span = Math.max(1, bodyHeight - size);
  const maxOffset = Math.max(1, total - bodyHeight);
  const start = Math.min(bodyHeight - size, Math.round((offset / maxOffset) * span));
  return slot >= start && slot < start + size ? "#" : "|";
}

// --- message and keys ------------------------------------------------------------

function messageSegs(state: UiState): Seg[] {
  if (state.mode === "filter") {
    return [{ text: ` filter: ${state.filter}` }, { text: "_", style: SGR.dim }];
  }
  if (state.mode === "confirm" && state.confirm !== null) {
    return [{ text: ` ${confirmText(state.confirm)}` }];
  }
  if (state.mode === "help") return [{ text: " keybindings", style: SGR.dim }];
  if (state.message === "") return [];
  return [{ text: ` ${state.message}` }];
}

function confirmText(confirm: Confirm): string {
  return confirm.kind === "quit" ? `${confirm.text} [y/n/c]` : `${confirm.text} [y/n]`;
}

const KEYS_NAV = " arrows move  space toggle  / filter  a/n all/none  w write  ? help  q quit";
const KEYS_FILTER = " type to filter  Enter keep  Esc clear";
const KEYS_CONFIRM_WRITE = " y write  n cancel";
const KEYS_CONFIRM_QUIT = " y save and quit  n quit without saving  c cancel";
const KEYS_HELP = " any key returns to the tree";

function keysSegs(state: UiState): Seg[] {
  const text = keysText(state);
  return [{ text, style: SGR.dim }];
}

function keysText(state: UiState): string {
  if (state.mode === "filter") return KEYS_FILTER;
  if (state.mode === "help") return KEYS_HELP;
  if (state.mode === "confirm") {
    return state.confirm?.kind === "quit" ? KEYS_CONFIRM_QUIT : KEYS_CONFIRM_WRITE;
  }
  return KEYS_NAV;
}

/** Fits in 40 columns, so the whole table is readable on a small terminal. */
const HELP: Array<[string, string]> = [
  ["up/down, k/j", "move the cursor"],
  ["PgUp/PgDn", "move one screen"],
  ["Home/End, g/G", "first / last row"],
  ["space, Enter", "toggle the row"],
  ["right/left, l/h", "expand / collapse"],
  ["Tab", "next section"],
  ["/", "filter (Enter keeps, Esc clears)"],
  ["a / n", "select / deselect what is shown"],
  ["r", "rescan the root"],
  ["w", "write both files"],
  ["?", "close this help"],
  ["q", "quit (asks when unsaved)"],
  ["Ctrl-C", "quit now, writing nothing"],
];

function helpLines(): Seg[][] {
  const width = Math.max(...HELP.map(([k]) => k.length));
  const out: Seg[][] = [[{ text: " KEYBINDINGS", style: SGR.bold }]];
  for (const [k, what] of HELP) {
    out.push([{ text: `   ${k.padEnd(width)}`, style: SGR.bold }, { text: `  ${what}` }]);
  }
  return out;
}

// --- line assembly ---------------------------------------------------------------

/**
 * Lay segments out in `width` columns, padding to the full width so the scrollbar column
 * lines up. Reverse video wins over per-segment colour: nesting SGR resets inside a reverse
 * run is how you get a striped cursor row.
 */
function compose(segs: Seg[], width: number, color: boolean, reverse: boolean): string {
  let used = 0;
  let out = "";
  for (const seg of segs) {
    if (used >= width) break;
    const text = seg.text.slice(0, width - used);
    used += text.length;
    out += color && !reverse && seg.style !== undefined ? `\x1b[${seg.style}m${text}\x1b[0m` : text;
  }
  const padded = out + " ".repeat(Math.max(0, width - used));
  return reverse && color ? `\x1b[7m${padded}\x1b[0m` : padded;
}
