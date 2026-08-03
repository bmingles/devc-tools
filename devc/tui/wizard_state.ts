// The pure core of the wizard: `WizardState` + `reduce(state, key)` → `{ state, effect }`.
// No IO — `wizard.ts` owns the terminal and performs the effects.
//
// The shell is generic over an ordered list of **steps**. A step exposes a sidebar `title`,
// a flat list of **focusables**, and key handling that mutates only that step's own model.
// Steps:
//   - `global`  — two string-list controls (code/skills roots). Present only on first run.
//   - `overview`— informational (base path + new/update status). No focusables.
//   - `mounts`  — a table of bind-mount rows (source or skills), with a directory picker and
//                 a text-input sub-mode for editing the container path.
//   - `review`  — a read-only preview of the two fences' would-be contents; `A`/Apply active.
//
// Only the last step (review) makes `A`/Apply active and emits the `apply` effect. On a
// mounts step, `A` advances instead. The directory picker and text input are modeled as pure
// sub-mode state; the shell fills directory listings via `setPickerListing` in response to a
// `readDir` effect, so the reducer stays IO-free and fully scriptable in tests.

import type { Key } from "./keys.ts";
import {
  assertNoDuplicateTarget,
  DuplicateTargetError,
  type MountKind,
  type MountRow,
  rowForHostPath,
} from "../mounts.ts";

/** What the app loop should do after a `reduce` call. */
export type Effect =
  | { type: "none" }
  | { type: "save"; codeRoots: string[]; skillsRoots: string[] }
  | { type: "apply"; source: MountRow[]; skills: MountRow[] }
  | { type: "readDir"; path: string }
  | { type: "pickRoots"; kind: MountKind }
  | { type: "quit" };

const NONE: Effect = { type: "none" };

// --- steps ---------------------------------------------------------------------

/** A single editable string-list control (e.g. "Code roots"). */
export interface ListControl {
  label: string;
  items: string[];
}

/** The Global config step model: two string-list controls. */
export interface GlobalStep {
  kind: "global";
  title: string;
  controls: ListControl[];
}

/** The overview step: informational only. */
export interface OverviewStep {
  kind: "overview";
  title: string;
  /** Absolute base path (`PATH/.devcontainer/devcontainer.json`). */
  basePath: string;
  /** True when no project config exists yet (first creation). */
  creating: boolean;
}

/** A mounts step: a table of bind-mount rows for one fence (`source` or `skills`). */
export interface MountsStep {
  kind: "mounts";
  which: MountKind;
  title: string;
  rows: MountRow[];
}

/** The review step: read-only preview of the two fences. */
export interface ReviewStep {
  kind: "review";
  title: string;
}

export type Step = GlobalStep | OverviewStep | MountsStep | ReviewStep;

// --- focus + sub-modes ---------------------------------------------------------

/**
 * Focus is a flat cursor over the step's rows. For the Global step: `{ control, item }` where
 * `item === -1` is the control header. For a mounts step: `control` is unused (0) and `item`
 * indexes into `rows` (`-1` = the "Add" header row).
 */
export interface Focus {
  control: number;
  item: number;
}

/** The single-line text input (Add on Global; container-path edit on a mounts step). */
export interface TextInput {
  /** The control the new entry appends to (Global step only). */
  control: number;
  value: string;
  /** When set, this input edits row `editRow`'s container path on a mounts step. */
  editRow?: number;
}

/** The directory picker sub-mode: pick a host folder from a configured root. */
export interface Picker {
  kind: MountKind;
  /** Absolute directory currently being browsed. */
  cwd: string;
  /** Subdirectory names in `cwd` (filled by the shell via `setPickerListing`). */
  entries: string[];
  /** Cursor into `entries`; `-1` selects "choose this directory" / ".." row. */
  cursor: number;
}

/** The root-selection sub-mode: choose which configured root to browse (when there are >1). */
export interface RootPicker {
  kind: MountKind;
  /** Absolute configured roots to choose from. */
  roots: string[];
  cursor: number;
}

export interface WizardState {
  steps: Step[];
  step: number;
  focus: Focus;
  input: TextInput | null;
  picker: Picker | null;
  rootPicker: RootPicker | null;
  color: boolean;
  message: string;
}

// --- focus helpers -------------------------------------------------------------

/** Build the flat list of focus slots for a step, in top-to-bottom order. */
export function focusSlots(step: Step): Focus[] {
  const slots: Focus[] = [];
  if (step.kind === "global") {
    step.controls.forEach((control, c) => {
      slots.push({ control: c, item: -1 });
      control.items.forEach((_, i) => slots.push({ control: c, item: i }));
    });
    return slots;
  }
  if (step.kind === "mounts") {
    slots.push({ control: 0, item: -1 }); // the Add header row
    step.rows.forEach((_, i) => slots.push({ control: 0, item: i }));
    return slots;
  }
  return slots; // overview / review: no focusables
}

function slotIndex(step: Step, focus: Focus): number {
  const slots = focusSlots(step);
  const idx = slots.findIndex((s) =>
    s.control === focus.control && s.item === focus.item
  );
  return idx === -1 ? 0 : idx;
}

/** Clamp focus onto a slot that still exists. */
function clampFocus(step: Step, focus: Focus): Focus {
  const slots = focusSlots(step);
  if (slots.length === 0) return { control: 0, item: -1 };
  if (step.kind === "global") {
    const control = step.controls[focus.control];
    if (control === undefined) return slots[0];
    if (focus.item >= control.items.length) {
      return { control: focus.control, item: control.items.length - 1 };
    }
    return focus;
  }
  if (step.kind === "mounts") {
    if (focus.item >= step.rows.length) {
      return { control: 0, item: step.rows.length - 1 };
    }
    return focus;
  }
  return { control: 0, item: -1 };
}

// --- initial states ------------------------------------------------------------

/** The initial state for the Global config step, seeded from existing roots. */
export function initialGlobalState(
  codeRoots: string[],
  skillsRoots: string[],
  color: boolean,
): WizardState {
  const step: GlobalStep = {
    kind: "global",
    title: "Global config",
    controls: [
      { label: "Code roots", items: [...codeRoots] },
      { label: "Skills roots", items: [...skillsRoots] },
    ],
  };
  return {
    steps: [step],
    step: 0,
    focus: { control: 0, item: -1 },
    input: null,
    picker: null,
    rootPicker: null,
    color,
    message: "",
  };
}

/** Options for the full project wizard's initial state. */
export interface ProjectWizardInit {
  /** Absolute path of the base `devcontainer.json` (for the overview). */
  basePath: string;
  /** True when no project config exists yet. */
  creating: boolean;
  /** Seed rows for the source fence. */
  sourceRows: MountRow[];
  /** Seed rows for the skills fence. */
  skillsRows: MountRow[];
  color: boolean;
  /** Prepend the Global config step (first run, config missing). */
  globalStep?: { codeRoots: string[]; skillsRoots: string[] };
}

/** The initial state for the full four-step project wizard. */
export function initialProjectState(init: ProjectWizardInit): WizardState {
  const steps: Step[] = [];
  if (init.globalStep !== undefined) {
    steps.push({
      kind: "global",
      title: "Global config",
      controls: [
        { label: "Code roots", items: [...init.globalStep.codeRoots] },
        { label: "Skills roots", items: [...init.globalStep.skillsRoots] },
      ],
    });
  }
  steps.push({
    kind: "overview",
    title: "Overview",
    basePath: init.basePath,
    creating: init.creating,
  });
  steps.push({
    kind: "mounts",
    which: "source",
    title: "Source folders",
    rows: [...init.sourceRows],
  });
  steps.push({
    kind: "mounts",
    which: "skills",
    title: "Skills",
    rows: [...init.skillsRows],
  });
  steps.push({ kind: "review", title: "Review" });

  const first = steps[0];
  const focus: Focus = first.kind === "global" || first.kind === "mounts"
    ? { control: 0, item: -1 }
    : { control: 0, item: -1 };
  return {
    steps,
    step: 0,
    focus,
    input: null,
    picker: null,
    rootPicker: null,
    color: init.color,
    message: "",
  };
}

// --- queries -------------------------------------------------------------------

/** True when the current step is the last (review) step, where Apply is active. */
export function isReviewStep(state: WizardState): boolean {
  return currentStep(state).kind === "review";
}

/** The step currently in view. */
export function currentStep(state: WizardState): Step {
  return state.steps[state.step];
}

/** The source-fence rows (for the review preview / apply). */
export function sourceRows(state: WizardState): MountRow[] {
  const s = state.steps.find((s) =>
    s.kind === "mounts" && s.which === "source"
  );
  return s !== undefined && s.kind === "mounts" ? s.rows : [];
}

/** The skills-fence rows (for the review preview / apply). */
export function skillsRows(state: WizardState): MountRow[] {
  const s = state.steps.find((s) =>
    s.kind === "mounts" && s.which === "skills"
  );
  return s !== undefined && s.kind === "mounts" ? s.rows : [];
}

function withStep(state: WizardState, step: Step): WizardState {
  const steps = state.steps.slice();
  steps[state.step] = step;
  return { ...state, steps };
}

function saveEffect(state: WizardState): Effect {
  const step = currentStep(state);
  if (step.kind !== "global") return NONE;
  return {
    type: "save",
    codeRoots: [...step.controls[0].items],
    skillsRoots: [...step.controls[1].items],
  };
}

function applyEffect(state: WizardState): Effect {
  return {
    type: "apply",
    source: sourceRows(state),
    skills: skillsRows(state),
  };
}

// --- reduce --------------------------------------------------------------------

/**
 * Advance the pure state one key. Returns the next state and the effect the app loop must
 * perform. Sub-modes (text input, directory picker) are handled first.
 */
export function reduce(
  state: WizardState,
  k: Key,
): { state: WizardState; effect: Effect } {
  if (k.name === "ctrl-c") return { state, effect: { type: "quit" } };

  if (state.input !== null) {
    return { state: reduceInput(state, k), effect: NONE };
  }
  if (state.rootPicker !== null) return reduceRootPicker(state, k);
  if (state.picker !== null) return reducePicker(state, k);

  const step = currentStep(state);
  if (step.kind === "mounts") return reduceMounts(state, step, k);
  if (step.kind === "overview" || step.kind === "review") {
    return reduceStatic(state, step, k);
  }
  return reduceGlobal(state, step, k);
}

// --- global step (single-step wizard, unchanged behavior) ----------------------

function reduceGlobal(
  state: WizardState,
  step: GlobalStep,
  k: Key,
): { state: WizardState; effect: Effect } {
  const slots = focusSlots(step);
  const index = slotIndex(step, state.focus);
  switch (k.name) {
    case "up":
      return move(state, slots, index - 1);
    case "down":
    case "tab":
      return move(state, slots, index + 1);
    case "enter":
      return { state: openInput(state, state.focus.control), effect: NONE };
    case "backspace":
      return { state: removeFocusedListItem(state), effect: NONE };
    case "escape":
      return maybeBack(state);
    case "char": {
      const c = (k.char ?? "").toLowerCase();
      if (c === "q") return { state, effect: { type: "quit" } };
      if (c === "a") {
        // In the single-step global wizard, the global step IS the last step: Apply saves.
        // In the project wizard it precedes the project steps: Apply advances instead.
        if (state.step === state.steps.length - 1) {
          return { state, effect: saveEffect(state) };
        }
        return advance(state);
      }
      if (c === "d" || c === "r") {
        return { state: removeFocusedListItem(state), effect: NONE };
      }
      return { state, effect: NONE };
    }
    default:
      return { state, effect: NONE };
  }
}

// --- overview / review (no focusables) -----------------------------------------

function reduceStatic(
  state: WizardState,
  step: Step,
  k: Key,
): { state: WizardState; effect: Effect } {
  switch (k.name) {
    case "escape":
      return maybeBack(state);
    case "tab":
    case "right":
      return advance(state);
    case "left":
      return maybeBack(state);
    case "char": {
      const c = (k.char ?? "").toLowerCase();
      if (c === "q") return { state, effect: { type: "quit" } };
      if (c === "a") {
        if (step.kind === "review") {
          return { state, effect: applyEffect(state) };
        }
        return advance(state);
      }
      if (c === "n") return advance(state);
      if (c === "b") return maybeBack(state);
      return { state, effect: NONE };
    }
    default:
      return { state, effect: NONE };
  }
}

// --- mounts step ---------------------------------------------------------------

function reduceMounts(
  state: WizardState,
  step: MountsStep,
  k: Key,
): { state: WizardState; effect: Effect } {
  const slots = focusSlots(step);
  const index = slotIndex(step, state.focus);
  switch (k.name) {
    case "up":
      return move(state, slots, index - 1);
    case "down":
    case "tab":
      return move(state, slots, index + 1);
    case "enter": {
      // On the Add header: open the directory picker. On a row: edit its container path.
      if (state.focus.item < 0) {
        return { state, effect: { type: "pickRoots", kind: step.which } };
      }
      return {
        state: openTargetEdit(state, step, state.focus.item),
        effect: NONE,
      };
    }
    case "backspace":
      return { state: removeFocusedRow(state, step), effect: NONE };
    case "escape":
      return maybeBack(state);
    case "char": {
      const c = (k.char ?? "").toLowerCase();
      if (c === "q") return { state, effect: { type: "quit" } };
      if (c === "a") {
        return { state, effect: { type: "pickRoots", kind: step.which } };
      }
      if (c === "n") return advance(state);
      if (c === "b") return maybeBack(state);
      if (c === "d" || c === "r") {
        return { state: removeFocusedRow(state, step), effect: NONE };
      }
      if (c === "e") {
        if (state.focus.item >= 0) {
          return {
            state: openTargetEdit(state, step, state.focus.item),
            effect: NONE,
          };
        }
        return { state, effect: NONE };
      }
      if (c === "o") {
        return { state: toggleReadonly(state, step), effect: NONE };
      }
      return { state, effect: NONE };
    }
    default:
      return { state, effect: NONE };
  }
}

function removeFocusedRow(state: WizardState, step: MountsStep): WizardState {
  const item = state.focus.item;
  if (item < 0 || step.rows[item] === undefined) return state;
  const rows = step.rows.filter((_, i) => i !== item);
  const next = withStep(state, { ...step, rows });
  return {
    ...next,
    focus: clampFocus(next.steps[next.step], state.focus),
    message: "",
  };
}

function toggleReadonly(state: WizardState, step: MountsStep): WizardState {
  const item = state.focus.item;
  if (item < 0 || step.rows[item] === undefined) return state;
  const rows = step.rows.map((
    r,
    i,
  ) => (i === item ? { ...r, readonly: !r.readonly } : r));
  return { ...withStep(state, { ...step, rows }), message: "" };
}

function openTargetEdit(
  state: WizardState,
  step: MountsStep,
  item: number,
): WizardState {
  const row = step.rows[item];
  if (row === undefined) return state;
  return {
    ...state,
    input: { control: 0, value: row.target, editRow: item },
    message: "",
  };
}

// --- navigation helpers --------------------------------------------------------

/** Focus the first focusable of the current step. */
function firstFocus(step: Step): Focus {
  const slots = focusSlots(step);
  return slots.length > 0 ? slots[0] : { control: 0, item: -1 };
}

function advance(state: WizardState): { state: WizardState; effect: Effect } {
  if (state.step >= state.steps.length - 1) return { state, effect: NONE };
  const step = state.step + 1;
  return {
    state: {
      ...state,
      step,
      focus: firstFocus(state.steps[step]),
      message: "",
    },
    effect: NONE,
  };
}

function maybeBack(state: WizardState): { state: WizardState; effect: Effect } {
  if (state.step === 0) return { state, effect: NONE };
  const step = state.step - 1;
  return {
    state: {
      ...state,
      step,
      focus: firstFocus(state.steps[step]),
      message: "",
    },
    effect: NONE,
  };
}

function move(
  state: WizardState,
  slots: Focus[],
  target: number,
): { state: WizardState; effect: Effect } {
  if (slots.length === 0) return { state, effect: NONE };
  const wrapped = ((target % slots.length) + slots.length) % slots.length;
  return {
    state: { ...state, focus: slots[wrapped], message: "" },
    effect: NONE,
  };
}

// --- text input sub-mode -------------------------------------------------------

function openInput(state: WizardState, control: number): WizardState {
  return { ...state, input: { control, value: "" }, message: "" };
}

function reduceInput(state: WizardState, k: Key): WizardState {
  const input = state.input!;
  switch (k.name) {
    case "escape":
      return { ...state, input: null };
    case "enter":
      return input.editRow !== undefined
        ? commitTargetEdit(state, input)
        : commitListAdd(state, input);
    case "backspace":
      return { ...state, input: { ...input, value: input.value.slice(0, -1) } };
    case "char":
      return {
        ...state,
        input: { ...input, value: input.value + (k.char ?? "") },
      };
    default:
      return state;
  }
}

function commitListAdd(state: WizardState, input: TextInput): WizardState {
  const value = input.value.trim();
  if (value === "") return { ...state, input: null };
  const step = currentStep(state);
  if (step.kind !== "global") return { ...state, input: null };
  const controls = step.controls.map((ctrl, c) =>
    c === input.control ? { ...ctrl, items: [...ctrl.items, value] } : ctrl
  );
  const next = withStep({ ...state, input: null }, { ...step, controls });
  const newItem = controls[input.control].items.length - 1;
  return { ...next, focus: { control: input.control, item: newItem } };
}

function commitTargetEdit(state: WizardState, input: TextInput): WizardState {
  const step = currentStep(state);
  if (step.kind !== "mounts" || input.editRow === undefined) {
    return { ...state, input: null };
  }
  const value = input.value.trim();
  if (value === "") return { ...state, input: null };
  const candidate: MountRow = { ...step.rows[input.editRow], target: value };
  try {
    assertNoDuplicateTarget(step.rows, candidate, input.editRow);
  } catch (e) {
    if (e instanceof DuplicateTargetError) {
      return { ...state, input: null, message: e.message };
    }
    throw e;
  }
  const rows = step.rows.map((r, i) => (i === input.editRow ? candidate : r));
  return {
    ...withStep({ ...state, input: null }, { ...step, rows }),
    message: "",
  };
}

function removeFocusedListItem(state: WizardState): WizardState {
  const step = currentStep(state);
  if (step.kind !== "global") return state;
  const { control, item } = state.focus;
  if (item < 0 || step.controls[control] === undefined) return state;
  const controls = step.controls.map((ctrl, c) =>
    c === control
      ? { ...ctrl, items: ctrl.items.filter((_, i) => i !== item) }
      : ctrl
  );
  const next = withStep(state, { ...step, controls });
  return { ...next, focus: clampFocus(next.steps[next.step], state.focus) };
}

// --- directory picker sub-mode -------------------------------------------------

/** Open the picker rooted at `cwd`; the shell then supplies the listing via `setPickerListing`. */
export function openPicker(
  state: WizardState,
  kind: MountKind,
  cwd: string,
): WizardState {
  return {
    ...state,
    picker: { kind, cwd, entries: [], cursor: -1 },
    message: "",
  };
}

/** Supply the directory listing for the picker's current `cwd` (shell → reducer). */
export function setPickerListing(
  state: WizardState,
  entries: string[],
): WizardState {
  if (state.picker === null) return state;
  return {
    ...state,
    picker: { ...state.picker, entries: [...entries], cursor: -1 },
  };
}

/** Close the picker (cancel). */
export function closePicker(state: WizardState): WizardState {
  return { ...state, picker: null };
}

/**
 * Add a picked host directory as a new row in the current mounts step. Rejects a duplicate
 * container target (leaves the step unchanged with an error message).
 */
export function addPickedRow(
  state: WizardState,
  hostPath: string,
): WizardState {
  const step = currentStep(state);
  if (step.kind !== "mounts") return { ...state, picker: null };
  const row = rowForHostPath(step.which, hostPath);
  try {
    assertNoDuplicateTarget(step.rows, row);
  } catch (e) {
    if (e instanceof DuplicateTargetError) {
      return { ...state, picker: null, message: e.message };
    }
    throw e;
  }
  const rows = [...step.rows, row];
  const next = withStep({ ...state, picker: null }, { ...step, rows });
  return { ...next, focus: { control: 0, item: rows.length - 1 }, message: "" };
}

/**
 * Picker key handling. The picker rows are, top to bottom: `[choose this dir]`, `[..]` (unless
 * at a configured root — but we always allow it here for simplicity), then each subdirectory.
 * `cursor === -1` is the "choose this dir" row; `cursor >= 0` indexes `entries`.
 *   - Up/Down move the cursor.
 *   - Enter on "choose this dir" adds the row; Enter on a subdir descends (emits `readDir`).
 *   - Esc / `q` cancels.
 */
function reducePicker(
  state: WizardState,
  k: Key,
): { state: WizardState; effect: Effect } {
  const picker = state.picker!;
  const max = picker.entries.length - 1;
  switch (k.name) {
    case "up": {
      const cursor = picker.cursor <= -1 ? max : picker.cursor - 1;
      return {
        state: { ...state, picker: { ...picker, cursor } },
        effect: NONE,
      };
    }
    case "down":
    case "tab": {
      const cursor = picker.cursor >= max ? -1 : picker.cursor + 1;
      return {
        state: { ...state, picker: { ...picker, cursor } },
        effect: NONE,
      };
    }
    case "escape":
      return { state: closePicker(state), effect: NONE };
    case "enter": {
      if (picker.cursor === -1) {
        return { state: addPickedRow(state, picker.cwd), effect: NONE };
      }
      const name = picker.entries[picker.cursor];
      if (name === undefined) return { state, effect: NONE };
      const cwd = name === ".."
        ? parentDir(picker.cwd)
        : `${picker.cwd}/${name}`;
      return {
        state: {
          ...state,
          picker: { ...picker, cwd, entries: [], cursor: -1 },
        },
        effect: { type: "readDir", path: cwd },
      };
    }
    case "char": {
      const c = (k.char ?? "").toLowerCase();
      if (c === "q") return { state: closePicker(state), effect: NONE };
      if (c === "s") {
        return { state: addPickedRow(state, picker.cwd), effect: NONE };
      }
      return { state, effect: NONE };
    }
    default:
      return { state, effect: NONE };
  }
}

function parentDir(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const slash = trimmed.lastIndexOf("/");
  if (slash <= 0) return "/";
  return trimmed.slice(0, slash);
}

// --- root picker sub-mode ------------------------------------------------------

/** Open the root-selection sub-mode (shell → reducer) when there is more than one root. */
export function openRootPicker(
  state: WizardState,
  kind: MountKind,
  roots: string[],
): WizardState {
  return {
    ...state,
    rootPicker: { kind, roots: [...roots], cursor: 0 },
    message: "",
  };
}

function reduceRootPicker(
  state: WizardState,
  k: Key,
): { state: WizardState; effect: Effect } {
  const rp = state.rootPicker!;
  const max = rp.roots.length - 1;
  switch (k.name) {
    case "up": {
      const cursor = rp.cursor <= 0 ? max : rp.cursor - 1;
      return {
        state: { ...state, rootPicker: { ...rp, cursor } },
        effect: NONE,
      };
    }
    case "down":
    case "tab": {
      const cursor = rp.cursor >= max ? 0 : rp.cursor + 1;
      return {
        state: { ...state, rootPicker: { ...rp, cursor } },
        effect: NONE,
      };
    }
    case "escape":
      return { state: { ...state, rootPicker: null }, effect: NONE };
    case "enter": {
      const root = rp.roots[rp.cursor];
      if (root === undefined) {
        return { state: { ...state, rootPicker: null }, effect: NONE };
      }
      const opened = openPicker({ ...state, rootPicker: null }, rp.kind, root);
      return { state: opened, effect: { type: "readDir", path: root } };
    }
    case "char":
      if ((k.char ?? "").toLowerCase() === "q") {
        return { state: { ...state, rootPicker: null }, effect: NONE };
      }
      return { state, effect: NONE };
    default:
      return { state, effect: NONE };
  }
}
