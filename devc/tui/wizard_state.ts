// The pure core of the wizard: `WizardState` + `reduce(state, key)` → `{ state, effect }`.
// No IO — `wizard.ts` owns the terminal and performs the effects.
//
// The shell is generic over an ordered list of **steps**. This phase ships exactly one step
// (the Global config step); the state machine, render, and app loop are structured so the
// next phase can add steps without changing the shell. A step exposes:
//   - a sidebar `title`,
//   - a flat list of **focusables** (controls and their entries),
//   - key handling that mutates only that step's own model.
//
// Only the last step is the "review" step, where `A`/Apply is active and emits `save`.

import type { Key } from "./keys.ts";

/** What the app loop should do after a `reduce` call. */
export type Effect =
  | { type: "none" }
  | { type: "save"; codeRoots: string[]; skillsRoots: string[] }
  | { type: "quit" };

const NONE: Effect = { type: "none" };

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

export type Step = GlobalStep;

/**
 * Focus is a flat cursor over the step's rows: each control header plus each of its entries
 * is a focusable slot. `{ control, item }` where `item === -1` means the control header
 * (Add lands here), and `item >= 0` selects that entry (Remove acts on it).
 */
export interface Focus {
  control: number;
  item: number;
}

/** The single-line text input shown while Adding an entry. */
export interface TextInput {
  /** The control the new entry will be appended to. */
  control: number;
  value: string;
}

export interface WizardState {
  steps: Step[];
  /** Index of the current step in `steps`. */
  step: number;
  focus: Focus;
  /** Non-null while in the Add text-input sub-mode. */
  input: TextInput | null;
  /** Whether colour SGR codes are emitted by the renderer. */
  color: boolean;
  /** A transient status/error line. */
  message: string;
}

/** Build the flat list of focus slots for a step, in top-to-bottom order. */
export function focusSlots(step: Step): Focus[] {
  const slots: Focus[] = [];
  step.controls.forEach((control, c) => {
    slots.push({ control: c, item: -1 });
    control.items.forEach((_, i) => slots.push({ control: c, item: i }));
  });
  return slots;
}

function slotIndex(step: Step, focus: Focus): number {
  const slots = focusSlots(step);
  const idx = slots.findIndex((s) => s.control === focus.control && s.item === focus.item);
  return idx === -1 ? 0 : idx;
}

/** Clamp focus onto a slot that still exists (entries may have been removed). */
function clampFocus(step: Step, focus: Focus): Focus {
  const slots = focusSlots(step);
  if (slots.length === 0) return { control: 0, item: -1 };
  const control = step.controls[focus.control];
  if (control === undefined) return slots[0];
  if (focus.item >= control.items.length) {
    return { control: focus.control, item: control.items.length - 1 };
  }
  return focus;
}

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
    color,
    message: "",
  };
}

/** True when the current step is the last (review) step, where Apply is active. */
export function isReviewStep(state: WizardState): boolean {
  return state.step === state.steps.length - 1;
}

/** The step currently in view. */
export function currentStep(state: WizardState): Step {
  return state.steps[state.step];
}

function withStep(state: WizardState, step: Step): WizardState {
  const steps = state.steps.slice();
  steps[state.step] = step;
  return { ...state, steps };
}

function saveEffect(state: WizardState): Effect {
  const step = currentStep(state);
  return {
    type: "save",
    codeRoots: [...step.controls[0].items],
    skillsRoots: [...step.controls[1].items],
  };
}

/**
 * Advance the pure state one key. Returns the next state and the effect the app loop must
 * perform. All key handling for the Add text-input sub-mode is handled first.
 */
export function reduce(state: WizardState, k: Key): { state: WizardState; effect: Effect } {
  if (k.name === "ctrl-c") return { state, effect: { type: "quit" } };

  if (state.input !== null) {
    return { state: reduceInput(state, k), effect: NONE };
  }

  const step = currentStep(state);
  const slots = focusSlots(step);
  const index = slotIndex(step, state.focus);

  switch (k.name) {
    case "up":
      return move(state, slots, index - 1);
    case "down":
      return move(state, slots, index + 1);
    case "tab":
      return move(state, slots, index + 1);
    case "enter": {
      // Enter on a control header (or an entry) opens Add for that control.
      return { state: openInput(state, state.focus.control), effect: NONE };
    }
    case "backspace": {
      // Remove the focused entry.
      return { state: removeFocused(state), effect: NONE };
    }
    case "escape":
      // No previous step in this phase: Esc is a no-op (Back becomes active with >1 step).
      return { state, effect: NONE };
    case "char": {
      const c = (k.char ?? "").toLowerCase();
      if (c === "q") return { state, effect: { type: "quit" } };
      if (c === "a") {
        if (isReviewStep(state)) return { state, effect: saveEffect(state) };
        return { state, effect: NONE };
      }
      if (c === "d" || c === "r") {
        // Remove the focused entry (keyboard alternative to Backspace).
        return { state: removeFocused(state), effect: NONE };
      }
      return { state, effect: NONE };
    }
    default:
      return { state, effect: NONE };
  }
}

function move(
  state: WizardState,
  slots: Focus[],
  target: number,
): { state: WizardState; effect: Effect } {
  if (slots.length === 0) return { state, effect: NONE };
  const wrapped = ((target % slots.length) + slots.length) % slots.length;
  return { state: { ...state, focus: slots[wrapped], message: "" }, effect: NONE };
}

function openInput(state: WizardState, control: number): WizardState {
  return { ...state, input: { control, value: "" }, message: "" };
}

function reduceInput(state: WizardState, k: Key): WizardState {
  const input = state.input!;
  switch (k.name) {
    case "escape":
      return { ...state, input: null };
    case "enter": {
      const value = input.value.trim();
      if (value === "") return { ...state, input: null };
      const step = currentStep(state);
      const controls = step.controls.map((ctrl, c) =>
        c === input.control ? { ...ctrl, items: [...ctrl.items, value] } : ctrl
      );
      const next = withStep({ ...state, input: null }, { ...step, controls });
      // Focus the newly added entry.
      const newItem = controls[input.control].items.length - 1;
      return { ...next, focus: { control: input.control, item: newItem } };
    }
    case "backspace":
      return { ...state, input: { ...input, value: input.value.slice(0, -1) } };
    case "char":
      return { ...state, input: { ...input, value: input.value + (k.char ?? "") } };
    default:
      return state;
  }
}

function removeFocused(state: WizardState): WizardState {
  const step = currentStep(state);
  const { control, item } = state.focus;
  if (item < 0 || step.controls[control] === undefined) return state;
  const controls = step.controls.map((ctrl, c) =>
    c === control ? { ...ctrl, items: ctrl.items.filter((_, i) => i !== item) } : ctrl
  );
  const next = withStep(state, { ...step, controls });
  return { ...next, focus: clampFocus(next.steps[next.step], state.focus) };
}
