// The interactive tree, as a pure state machine. No IO, no terminal, no writing — the only
// way this file affects the world is by returning an `Effect` for `app.ts` to perform.
//
// Three functions carry the whole UI:
//
//   visibleRows(state)      the scan tree + skills flattened into display rows
//   reduce(state, key)      one keystroke → the next state (+ an optional effect)
//   render(state, size)     (render.ts) rows → exactly `size.rows` lines
//
// Selection lives in exactly the same shape the CLI uses — a `Set` of node ids plus a `Set`
// of skill names — so `w` can hand it straight to `applySelection()` with no translation.

import type { Config } from "../config.ts";
import { derive, type Derived } from "../model.ts";
import { flatten, type Node, type Tree } from "../scan.ts";
import type { Skill } from "../skills.ts";
import type { Key } from "./keys.ts";

export type Mode = "nav" | "filter" | "confirm" | "help";

/**
 * Checkbox state of a row. `auto` is `[~]`, `partial` is `[-]`, and `none` prints blanks —
 * which is how a row says "you cannot check me"; the reason follows in its notes or warnings.
 */
export type Marker = "none" | "off" | "on" | "auto" | "partial";

/** Fold column: `v`, `>`, or blank. Fold state only — selectability lives in the checkbox. */
export type Fold = "none" | "expanded" | "collapsed";

export type RowKind = "section" | "blank" | "note" | "node" | "skill";

export type Section = "projects" | "skills";

export interface Row {
  kind: RowKind;
  /** Unique, stable across repaints: `node:<id>`, `skill:<name>`, `section:<name>`. */
  key: string;
  label: string;
  depth: number;
  focusable: boolean;
  /** With a filter active: does this row itself match (vs. being shown as an ancestor)? */
  matched: boolean;
  marker: Marker;
  fold: Fold;
  notes: string[];
  warnings: string[];
  section?: Section;
  node?: Node;
  skill?: Skill;
}

export interface Confirm {
  kind: "write-create" | "quit";
  text: string;
}

export interface Baseline {
  selection: Set<string>;
  skills: Set<string>;
}

export interface UiState {
  cfg: Config;
  tree: Tree;
  skills: Skill[];
  /** Absolute skills root, or "" when unconfigured. */
  skillsRoot: string;
  selection: Set<string>;
  skillSelection: Set<string>;
  expanded: Set<string>;
  /** Row key of the cursor; "" when nothing is focusable. */
  cursor: string;
  offset: number;
  bodyHeight: number;
  mode: Mode;
  filter: string;
  message: string;
  confirm: Confirm | null;
  baseline: Baseline;
  /** True when the devcontainer file does not exist yet, so `w` must ask first. */
  needsCreate: boolean;
  color: boolean;
  /** Target files as the message line should name them — short labels, not resolved paths. */
  paths: { devcontainer: string; workspaceFile: string };
}

export type Effect =
  | { type: "write" }
  | { type: "rescan" }
  | { type: "quit"; save: boolean };

export interface Reduced {
  state: UiState;
  effect?: Effect;
}

export const DEFAULT_BODY_HEIGHT = 21;

/** Rows kept between the cursor and the top/bottom of the body while scrolling. */
const SCROLL_MARGIN = 2;

export interface InitOptions {
  cfg: Config;
  tree: Tree;
  skills: Skill[];
  skillsRoot: string;
  selection: Set<string>;
  skillSelection: Set<string>;
  paths: { devcontainer: string; workspaceFile: string };
  needsCreate: boolean;
  color: boolean;
  bodyHeight?: number;
}

/**
 * Folders start collapsed, like any file tree — except along the path to something already
 * selected, so what the container currently mounts is visible on the first frame.
 */
export function initialState(init: InitOptions): UiState {
  const expanded = ancestorsOf(init.tree, init.selection);
  const state: UiState = {
    cfg: init.cfg,
    tree: init.tree,
    skills: init.skills,
    skillsRoot: init.skillsRoot,
    selection: new Set(init.selection),
    skillSelection: new Set(init.skillSelection),
    expanded,
    cursor: "",
    offset: 0,
    bodyHeight: init.bodyHeight ?? DEFAULT_BODY_HEIGHT,
    mode: "nav",
    filter: "",
    message: "",
    confirm: null,
    baseline: {
      selection: new Set(init.selection),
      skills: new Set(init.skillSelection),
    },
    needsCreate: init.needsCreate,
    color: init.color,
    paths: init.paths,
  };
  return normalizeCursor(state);
}

/** Ids of every node with a selected node somewhere beneath it — the folds to open. */
function ancestorsOf(tree: Tree, selection: Set<string>): Set<string> {
  const out = new Set<string>();
  const walk = (nodes: Node[]): boolean => {
    let hit = false;
    for (const n of nodes) {
      const below = walk(n.children);
      if (below) out.add(n.id);
      if (below || selection.has(n.id)) hit = true;
    }
    return hit;
  };
  walk(tree.nodes);
  return out;
}

// --- rows ------------------------------------------------------------------------

/** Derived mounts/folders for the current selection (drives `[~]` and the header counts). */
export function derived(state: UiState): Derived {
  return derive(state.tree, state.selection, state.cfg);
}

/**
 * Flatten the tree and the skills list into display rows, honoring expansion and the filter.
 *
 * With a filter active, expansion is ignored: a node is shown when it matches or when
 * something beneath it does, which is what "matches stay visible, auto-expanded" means.
 */
export function visibleRows(state: UiState): Row[] {
  const d = derived(state);
  const filter = state.filter.trim().toLowerCase();
  const rows: Row[] = [];

  rows.push(sectionRow("projects", "PROJECTS"));
  const nodes = nodeRows(state, state.tree.nodes, d, filter);
  if (nodes.length === 0) {
    rows.push(noteRow(filter === "" ? "(no projects found)" : "(nothing matches the filter)"));
  } else {
    rows.push(...nodes);
  }

  rows.push(blankRow());
  rows.push(sectionRow("skills", skillsHeading(state)));
  const skills = state.skills.filter((s) => matches(s.name, filter));
  if (skills.length === 0) {
    rows.push(noteRow(state.skillsRoot === "" ? "(skillsRoot is not set)" : "(no skills)"));
  } else {
    for (const s of skills) {
      rows.push({
        kind: "skill",
        key: `skill:${s.name}`,
        label: s.name,
        depth: 1,
        focusable: true,
        matched: filter === "" || matches(s.name, filter),
        marker: s.warnings.length > 0 ? "none" : state.skillSelection.has(s.name) ? "on" : "off",
        fold: "none",
        notes: [],
        warnings: s.warnings,
        section: "skills",
        skill: s,
      });
    }
  }
  return rows;
}

function skillsHeading(state: UiState): string {
  if (state.skillsRoot === "") return "SKILLS  (skillsRoot is not set)";
  return `SKILLS  ${state.skillsRoot} -> ${state.cfg.skillsContainerRoot}`;
}

function nodeRows(state: UiState, nodes: Node[], d: Derived, filter: string): Row[] {
  const out: Row[] = [];
  for (const n of nodes) {
    const self = matches(n.id, filter);
    const below = filter !== "" && subtreeMatches(n, filter);
    if (filter !== "" && !self && !below) continue;
    const open = filter !== "" ? below : state.expanded.has(n.id);
    const children = open ? nodeRows(state, n.children, d, filter) : [];
    out.push({
      kind: "node",
      key: `node:${n.id}`,
      label: n.name,
      depth: n.depth,
      focusable: true,
      matched: filter === "" || self,
      marker: markerFor(state, n, d),
      fold: foldFor(n, open),
      notes: notesFor(state, n, d),
      warnings: warningsFor(n),
      section: "projects",
      node: n,
    });
    out.push(...children);
  }
  return out;
}

function matches(text: string, filter: string): boolean {
  return filter === "" || text.toLowerCase().includes(filter);
}

function subtreeMatches(node: Node, filter: string): boolean {
  for (const c of node.children) {
    if (matches(c.id, filter) || subtreeMatches(c, filter)) return true;
  }
  return false;
}

/** No checkbox at all is how a row says it cannot be checked. */
function markerFor(state: UiState, n: Node, d: Derived): Marker {
  if (n.kind === "group") {
    const ids = selectableDescendants(n);
    if (ids.length === 0) return "none";
    const on = ids.filter((id) => state.selection.has(id)).length;
    if (on === 0) return "off";
    return on === ids.length ? "on" : "partial";
  }
  if (state.selection.has(n.id)) return "on";
  // `[~]` outranks unselectable: the node really is mounted, whoever asked for it.
  if (d.auto.has(n.id)) return "auto";
  return n.selectable ? "off" : "none";
}

function foldFor(n: Node, open: boolean): Fold {
  if (n.children.length === 0) return "none";
  return open ? "expanded" : "collapsed";
}

function notesFor(state: UiState, n: Node, d: Derived): string[] {
  const notes: string[] = [];
  if (n.isWorkspace) notes.push("(workspace)");
  if (d.auto.has(n.id) && !state.selection.has(n.id)) notes.push("(required by worktree)");
  return notes;
}

function warningsFor(n: Node): string[] {
  const out = [...n.warnings];
  if (n.kind === "worktree" && n.relativeGitdir === false) out.push("absolute gitdir");
  return out;
}

/** Project/worktree ids beneath `node` the user may check. */
export function selectableDescendants(node: Node): string[] {
  return flatten(node.children).filter((n) => n.kind !== "group" && n.selectable).map((n) => n.id);
}

function sectionRow(section: Section, label: string): Row {
  return {
    kind: "section",
    key: `section:${section}`,
    label,
    depth: 0,
    focusable: false,
    matched: true,
    marker: "none",
    fold: "none",
    notes: [],
    warnings: [],
    section,
  };
}

function blankRow(): Row {
  return {
    kind: "blank",
    key: "blank",
    label: "",
    depth: 0,
    focusable: false,
    matched: true,
    marker: "none",
    fold: "none",
    notes: [],
    warnings: [],
  };
}

function noteRow(label: string): Row {
  return {
    kind: "note",
    key: `note:${label}`,
    label,
    depth: 0,
    focusable: false,
    matched: true,
    marker: "none",
    fold: "none",
    notes: [],
    warnings: [],
  };
}

// --- queries ---------------------------------------------------------------------

export function cursorIndex(rows: Row[], cursor: string): number {
  return rows.findIndex((r) => r.key === cursor);
}

export function currentRow(state: UiState, rows: Row[] = visibleRows(state)): Row | undefined {
  const i = cursorIndex(rows, state.cursor);
  return i < 0 ? undefined : rows[i];
}

export function isDirty(state: UiState): boolean {
  return !setEquals(state.selection, state.baseline.selection) ||
    !setEquals(state.skillSelection, state.baseline.skills);
}

function setEquals(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

// --- transitions the app performs directly ---------------------------------------

/** Adopt a new terminal size (body height = rows minus header, message and keys lines). */
export function setSize(state: UiState, size: { rows: number }): UiState {
  const bodyHeight = Math.max(1, size.rows - 3);
  return normalizeCursor({ ...state, bodyHeight });
}

/** After a successful write: the on-disk selection is now the in-memory one. */
export function markSaved(state: UiState, message: string): UiState {
  return {
    ...state,
    baseline: { selection: new Set(state.selection), skills: new Set(state.skillSelection) },
    needsCreate: false,
    message,
  };
}

export function withMessage(state: UiState, message: string): UiState {
  return { ...state, message };
}

/**
 * Swap in a freshly scanned tree, keeping the selection (which is keyed by id). Folds survive
 * a rescan untouched — a directory that appeared since the last scan stays collapsed, like
 * every other one.
 */
export function rescanned(
  state: UiState,
  tree: Tree,
  skills: Skill[],
  message: string,
): UiState {
  const expanded = new Set<string>();
  for (const n of flatten(tree.nodes)) {
    if (n.children.length > 0 && state.expanded.has(n.id)) expanded.add(n.id);
  }
  return normalizeCursor({ ...state, tree, skills, expanded, message });
}

// --- reduce ----------------------------------------------------------------------

export function reduce(state: UiState, k: Key): Reduced {
  switch (state.mode) {
    case "filter":
      return reduceFilter(state, k);
    case "confirm":
      return reduceConfirm(state, k);
    case "help":
      return reduceHelp(state, k);
    default:
      return reduceNav(state, k);
  }
}

const QUIT: Effect = { type: "quit", save: false };

function reduceNav(state: UiState, k: Key): Reduced {
  const rows = visibleRows(state);
  const ch = k.name === "char" ? (k.char ?? "") : "";

  if (k.name === "ctrl-c") return { state, effect: QUIT };
  if (k.name === "up" || ch === "k") return { state: moveBy(state, rows, -1) };
  if (k.name === "down" || ch === "j") return { state: moveBy(state, rows, 1) };
  if (k.name === "pageup") return { state: moveBy(state, rows, -page(state)) };
  if (k.name === "pagedown") return { state: moveBy(state, rows, page(state)) };
  if (k.name === "home" || ch === "g") return { state: moveTo(state, rows, firstFocusable(rows)) };
  if (k.name === "end" || ch === "G") return { state: moveTo(state, rows, lastFocusable(rows)) };
  if (k.name === "enter" || ch === " ") return { state: toggle(state, rows) };
  if (k.name === "right" || ch === "l") return { state: expand(state, rows) };
  if (k.name === "left" || ch === "h") return { state: collapseOrParent(state, rows) };
  if (k.name === "tab") return { state: jumpSection(state, rows) };
  if (k.name === "escape") {
    return state.filter === ""
      ? { state: withMessage(state, "") }
      : { state: normalizeCursor({ ...state, filter: "", message: "" }) };
  }
  if (ch === "/") return { state: { ...state, mode: "filter", message: "" } };
  if (ch === "a") return { state: setVisible(state, rows, true) };
  if (ch === "n") return { state: setVisible(state, rows, false) };
  if (ch === "r") return { state: withMessage(state, "rescanning..."), effect: { type: "rescan" } };
  if (ch === "w") {
    if (state.needsCreate) {
      return {
        state: {
          ...state,
          mode: "confirm",
          confirm: { kind: "write-create", text: `create ${state.paths.devcontainer}?` },
        },
      };
    }
    return { state, effect: { type: "write" } };
  }
  if (ch === "?") return { state: { ...state, mode: "help", message: "" } };
  if (ch === "q") {
    if (isDirty(state)) {
      return {
        state: { ...state, mode: "confirm", confirm: { kind: "quit", text: "save before quitting?" } },
      };
    }
    return { state, effect: QUIT };
  }
  return { state };
}

function page(state: UiState): number {
  return Math.max(1, state.bodyHeight - 1);
}

function reduceFilter(state: UiState, k: Key): Reduced {
  if (k.name === "ctrl-c") return { state, effect: QUIT };
  if (k.name === "escape") {
    return { state: normalizeCursor({ ...state, filter: "", mode: "nav", message: "" }) };
  }
  if (k.name === "enter") return { state: normalizeCursor({ ...state, mode: "nav", message: "" }) };
  if (k.name === "backspace") {
    return { state: normalizeCursor({ ...state, filter: state.filter.slice(0, -1) }) };
  }
  if (k.name === "char") {
    return { state: normalizeCursor({ ...state, filter: state.filter + (k.char ?? "") }) };
  }
  return { state };
}

function reduceConfirm(state: UiState, k: Key): Reduced {
  if (k.name === "ctrl-c") return { state, effect: QUIT };
  const ch = k.name === "char" ? (k.char ?? "").toLowerCase() : "";
  const cancelled: UiState = { ...state, mode: "nav", confirm: null, message: "cancelled" };
  if (state.confirm?.kind === "quit") {
    if (ch === "y") {
      return { state: { ...state, mode: "nav", confirm: null }, effect: { type: "quit", save: true } };
    }
    if (ch === "n") return { state, effect: QUIT };
    return { state: cancelled };
  }
  if (ch === "y") {
    return { state: { ...state, mode: "nav", confirm: null, message: "" }, effect: { type: "write" } };
  }
  return { state: cancelled };
}

function reduceHelp(state: UiState, k: Key): Reduced {
  if (k.name === "ctrl-c") return { state, effect: QUIT };
  return { state: { ...state, mode: "nav" } };
}

// --- navigation ------------------------------------------------------------------

function firstFocusable(rows: Row[]): number {
  return rows.findIndex((r) => r.focusable);
}

function lastFocusable(rows: Row[]): number {
  for (let i = rows.length - 1; i >= 0; i--) if (rows[i].focusable) return i;
  return -1;
}

/** Move `delta` focusable rows, never landing on a section header or a blank. */
function moveBy(state: UiState, rows: Row[], delta: number): UiState {
  const from = cursorIndex(rows, state.cursor);
  if (from < 0) return moveTo(state, rows, firstFocusable(rows));
  const step = delta > 0 ? 1 : -1;
  let at = from;
  for (let n = Math.abs(delta); n > 0; n--) {
    let next = at + step;
    while (next >= 0 && next < rows.length && !rows[next].focusable) next += step;
    if (next < 0 || next >= rows.length) break;
    at = next;
  }
  return moveTo(state, rows, at);
}

function moveTo(state: UiState, rows: Row[], index: number): UiState {
  if (index < 0 || index >= rows.length) return state;
  const cursor = rows[index].key;
  return { ...state, cursor, offset: scrollTo(rows.length, index, state.offset, state.bodyHeight), message: "" };
}

/** Keep the cursor `SCROLL_MARGIN` rows away from both body edges where possible. */
function scrollTo(total: number, index: number, offset: number, bodyHeight: number): number {
  if (total <= bodyHeight) return 0;
  let off = offset;
  if (index - SCROLL_MARGIN < off) off = index - SCROLL_MARGIN;
  if (index + SCROLL_MARGIN > off + bodyHeight - 1) off = index + SCROLL_MARGIN - bodyHeight + 1;
  return Math.max(0, Math.min(off, total - bodyHeight));
}

/** After anything that changes the row set: keep the cursor on a real, focusable row. */
export function normalizeCursor(state: UiState): UiState {
  const rows = visibleRows(state);
  let index = cursorIndex(rows, state.cursor);
  if (index < 0 || !rows[index].focusable) index = firstFocusable(rows);
  if (index < 0) return { ...state, cursor: "", offset: 0 };
  return {
    ...state,
    cursor: rows[index].key,
    offset: scrollTo(rows.length, index, state.offset, state.bodyHeight),
  };
}

function jumpSection(state: UiState, rows: Row[]): UiState {
  const at = cursorIndex(rows, state.cursor);
  const headers = rows.map((r, i) => ({ r, i })).filter((x) => x.r.kind === "section");
  if (headers.length === 0) return state;
  const target = headers.find((h) => h.i > at) ?? headers[0];
  for (let j = target.i + 1; j < rows.length; j++) {
    if (rows[j].focusable) return moveTo(state, rows, j);
  }
  return state;
}

function expand(state: UiState, rows: Row[]): UiState {
  const row = rowAt(state, rows);
  if (row?.node === undefined || row.node.children.length === 0) return state;
  const expanded = new Set(state.expanded);
  expanded.add(row.node.id);
  return normalizeCursor({ ...state, expanded, message: "" });
}

function collapseOrParent(state: UiState, rows: Row[]): UiState {
  const row = rowAt(state, rows);
  if (row?.node === undefined) return state;
  const node = row.node;
  if (node.children.length > 0 && state.expanded.has(node.id)) {
    const expanded = new Set(state.expanded);
    expanded.delete(node.id);
    return normalizeCursor({ ...state, expanded, message: "" });
  }
  const parent = parentOf(state.tree, node.id);
  if (parent === undefined) return state;
  const index = cursorIndex(rows, `node:${parent}`);
  return index < 0 ? state : moveTo(state, rows, index);
}

/** Id of the node whose children contain `id`. */
export function parentOf(tree: Tree, id: string): string | undefined {
  const walk = (nodes: Node[], parent: string | undefined): string | undefined => {
    for (const n of nodes) {
      if (n.id === id) return parent;
      const found = walk(n.children, n.id);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  return walk(tree.nodes, undefined);
}

function rowAt(state: UiState, rows: Row[]): Row | undefined {
  const i = cursorIndex(rows, state.cursor);
  return i < 0 ? undefined : rows[i];
}

// --- selection -------------------------------------------------------------------

function toggle(state: UiState, rows: Row[]): UiState {
  const row = rowAt(state, rows);
  if (row === undefined) return state;

  if (row.kind === "skill" && row.skill !== undefined) {
    if (row.skill.warnings.length > 0) {
      return withMessage(state, `${row.skill.name}: ${row.skill.warnings[0]}`);
    }
    const skillSelection = new Set(state.skillSelection);
    if (!skillSelection.delete(row.skill.name)) skillSelection.add(row.skill.name);
    return { ...state, skillSelection, message: "" };
  }
  if (row.kind !== "node" || row.node === undefined) return state;
  const node = row.node;

  if (node.kind === "group") {
    const ids = selectableDescendants(node);
    if (ids.length === 0) return withMessage(state, `${node.name}: nothing selectable beneath it`);
    const selection = new Set(state.selection);
    const all = ids.every((id) => selection.has(id));
    for (const id of ids) {
      if (all) selection.delete(id);
      else selection.add(id);
    }
    return { ...state, selection, message: "" };
  }

  if (!node.selectable) return withMessage(state, `${node.name}: ${whyBlocked(node)}`);

  const selection = new Set(state.selection);
  if (selection.delete(node.id)) {
    // Deselecting a primary a selected worktree still needs leaves it mounted as `[~]`.
    const stillMounted = derive(state.tree, selection, state.cfg).auto.has(node.id);
    return {
      ...state,
      selection,
      message: stillMounted ? `${node.name} stays mounted: a selected worktree needs it` : "",
    };
  }
  selection.add(node.id);
  return { ...state, selection, message: "" };
}

function whyBlocked(node: Node): string {
  if (node.isWorkspace) return "this is the current workspace; the container already mounts it";
  return node.warnings.join("; ") || "not selectable";
}

/**
 * `a` / `n` over the rows on screen. With a filter active only *matching* rows are affected —
 * ancestors are on screen for context, not to be bulk-selected.
 */
function setVisible(state: UiState, rows: Row[], on: boolean): UiState {
  const selection = new Set(state.selection);
  const skillSelection = new Set(state.skillSelection);
  let touched = 0;
  for (const row of rows) {
    if (!row.focusable || !row.matched) continue;
    if (row.kind === "skill" && row.skill !== undefined) {
      if (row.skill.warnings.length > 0) continue;
      if (on) skillSelection.add(row.skill.name);
      else skillSelection.delete(row.skill.name);
      touched++;
      continue;
    }
    const node = row.node;
    if (node === undefined || node.kind === "group" || !node.selectable) continue;
    if (on) selection.add(node.id);
    else selection.delete(node.id);
    touched++;
  }
  const what = state.filter.trim() === "" ? "visible" : "matching";
  return {
    ...state,
    selection,
    skillSelection,
    message: `${on ? "selected" : "deselected"} ${touched} ${what} ${touched === 1 ? "row" : "rows"}`,
  };
}
