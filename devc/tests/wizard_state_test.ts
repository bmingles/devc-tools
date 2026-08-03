import { assertEquals } from "jsr:@std/assert@^1";
import { decodeAll, type Key } from "../tui/keys.ts";
import {
  currentStep,
  type Effect,
  type GlobalStep,
  initialGlobalState,
  reduce,
  type WizardState,
} from "../tui/wizard_state.ts";

/** Narrow the current step to a GlobalStep (the only kind in the single-step wizard). */
function global(state: WizardState): GlobalStep {
  const step = currentStep(state);
  if (step.kind !== "global") {
    throw new Error(`expected global step, got ${step.kind}`);
  }
  return step;
}

/** Drive a key script through `reduce`, returning the final state and the last non-none effect. */
function run(keys: Key[]): { state: WizardState; effect: Effect } {
  let state = initialGlobalState([], [], false);
  let effect: Effect = { type: "none" };
  for (const k of keys) {
    const step = reduce(state, k);
    state = step.state;
    if (step.effect.type !== "none") {
      effect = step.effect;
      break; // save/quit terminate the loop
    }
  }
  return { state, effect };
}

Deno.test("add two entries via text input, focus lands on the new entry", () => {
  // Enter opens Add on the focused control (Code roots header). Type a path, Enter.
  const { state } = run(decodeAll("\r~/code\r"));
  const step = global(state);
  assertEquals(step.controls[0].items, ["~/code"]);
  assertEquals(state.focus, { control: 0, item: 0 });
});

Deno.test("Add ~/code to code roots, ~/.agents/skills to skills roots, Apply emits save", () => {
  const script: Key[] = [
    // Add ~/code to code roots (control 0 header focused initially).
    ...decodeAll("\r~/code\r"),
    // Move focus down to the Skills roots control header:
    //   slots: [c0 header, c0 item0, c1 header, c1 item0(none yet)].
    // After adding, focus is at c0 item0 (index 1). Two downs -> c1 header (index 2)... wait
    // there is no c1 item yet, so slots = [c0h, c0i0, c1h]; index1 -> down -> index2 (c1h).
    { name: "down" },
    // Add ~/.agents/skills to skills roots (Enter opens Add on the focused control).
    ...decodeAll("\r~/.agents/skills\r"),
    // Apply.
    { name: "char", char: "A" },
  ];

  // Build progressively so we can assert the save effect at the end.
  let state = initialGlobalState([], [], false);
  let effect: Effect = { type: "none" };
  for (const k of script) {
    const r = reduce(state, k);
    state = r.state;
    effect = r.effect;
    if (effect.type !== "none") break;
  }

  assertEquals(effect, {
    type: "save",
    codeRoots: ["~/code"],
    skillsRoots: ["~/.agents/skills"],
  });
});

Deno.test("Q emits quit with no save", () => {
  const { effect } = run([
    ...decodeAll("\r~/code\r"),
    { name: "char", char: "q" },
  ]);
  assertEquals(effect, { type: "quit" });
});

Deno.test("Backspace removes the focused entry", () => {
  // Add two, focus is on the second, Backspace removes it.
  let state = initialGlobalState([], [], false);
  for (const k of decodeAll("\r~/a\r")) state = reduce(state, k).state;
  for (const k of decodeAll("\r~/b\r")) state = reduce(state, k).state;
  // focus on the last added entry (~/b at item 1).
  assertEquals(global(state).controls[0].items, ["~/a", "~/b"]);
  state = reduce(state, { name: "backspace" }).state;
  assertEquals(global(state).controls[0].items, ["~/a"]);
});

Deno.test("Esc cancels the Add input without adding", () => {
  let state = initialGlobalState([], [], false);
  for (const k of decodeAll("\r~/x")) state = reduce(state, k).state;
  assertEquals(state.input?.value, "~/x");
  state = reduce(state, { name: "escape" }).state;
  assertEquals(state.input, null);
  assertEquals(global(state).controls[0].items, []);
});

Deno.test("ctrl-c quits from any mode", () => {
  const { effect } = run([{ name: "ctrl-c" }]);
  assertEquals(effect, { type: "quit" });
});
