import { assert, assertEquals } from "jsr:@std/assert@^1";
import { decodeAll, type Key } from "../tui/keys.ts";
import {
  currentStep,
  type Effect,
  initialProjectState,
  type MountsStep,
  openPicker,
  openRootPicker,
  type ProjectWizardInit,
  reduce,
  setPickerListing,
  sourceRows,
  type WizardState,
} from "../tui/wizard_state.ts";

function init(over: Partial<ProjectWizardInit> = {}): WizardState {
  return initialProjectState({
    basePath: "/proj/.devcontainer/devcontainer.json",
    creating: true,
    sourceRows: [],
    skillsRows: [],
    color: false,
    ...over,
  });
}

/** Drive keys, returning the final state and the last non-none effect. */
function drive(
  state: WizardState,
  keys: Key[],
): { state: WizardState; effect: Effect } {
  let effect: Effect = { type: "none" };
  for (const k of keys) {
    const r = reduce(state, k);
    state = r.state;
    if (r.effect.type !== "none") {
      effect = r.effect;
      if (
        r.effect.type === "apply" || r.effect.type === "quit" ||
        r.effect.type === "save"
      ) {
        break;
      }
    }
  }
  return { state, effect };
}

function mounts(state: WizardState, which: "source" | "skills"): MountsStep {
  const s = state.steps.find((s) => s.kind === "mounts" && s.which === which);
  if (s === undefined || s.kind !== "mounts") throw new Error("no mounts step");
  return s;
}

Deno.test("steps: overview, source, skills, review (no global step by default)", () => {
  const state = init();
  assertEquals(state.steps.map((s) => s.kind), [
    "overview",
    "mounts",
    "mounts",
    "review",
  ]);
});

Deno.test("global step is prepended when requested", () => {
  const state = init({ globalStep: { codeRoots: [], skillsRoots: [] } });
  assertEquals(state.steps.map((s) => s.kind), [
    "global",
    "overview",
    "mounts",
    "mounts",
    "review",
  ]);
});

Deno.test("N advances overview -> source; A on the Add row emits pickRoots", () => {
  let state = init();
  state = reduce(state, { name: "char", char: "n" }).state; // overview -> source
  assertEquals(currentStep(state).kind, "mounts");
  const r = reduce(state, { name: "char", char: "a" });
  assertEquals(r.effect, { type: "pickRoots", kind: "source" });
});

Deno.test("picker: descend, select a directory, row gets defaults; toggle readonly; remove", () => {
  let state = init();
  state = reduce(state, { name: "char", char: "n" }).state; // -> source step

  // Open the picker at a single root and supply a listing.
  state = openPicker(state, "source", "/home/me/code");
  state = setPickerListing(state, ["..", "my-repo", "other"]);

  // Move to "my-repo" (cursor -1 -> 0 (..) -> 1 (my-repo)) and descend.
  state = reduce(state, { name: "down" }).state; // cursor 0 (..)
  state = reduce(state, { name: "down" }).state; // cursor 1 (my-repo)
  const desc = reduce(state, { name: "enter" });
  assertEquals(desc.effect, { type: "readDir", path: "/home/me/code/my-repo" });
  state = desc.state;
  state = setPickerListing(state, []); // no subdirs

  // Select this directory (cursor is -1 after a listing).
  state = reduce(state, { name: "enter" }).state;
  assertEquals(state.picker, null);
  const step = mounts(state, "source");
  assertEquals(step.rows, [{
    source: "/home/me/code/my-repo",
    target: "/workspaces/my-repo",
    readonly: false,
  }]);

  // Toggle read-only on the focused row.
  state = reduce(state, { name: "char", char: "o" }).state;
  assertEquals(mounts(state, "source").rows[0].readonly, true);

  // Remove it.
  state = reduce(state, { name: "char", char: "d" }).state;
  assertEquals(mounts(state, "source").rows, []);
});

Deno.test("root picker: choose a root, then browse it", () => {
  let state = init();
  state = reduce(state, { name: "char", char: "n" }).state; // -> source
  state = openRootPicker(state, "source", ["/a", "/b"]);
  assert(state.rootPicker !== null);
  // Choose the second root.
  state = reduce(state, { name: "down" }).state;
  const r = reduce(state, { name: "enter" });
  assertEquals(r.effect, { type: "readDir", path: "/b" });
  assert(r.state.rootPicker === null);
  assert(r.state.picker !== null);
  assertEquals(r.state.picker!.cwd, "/b");
});

Deno.test("duplicate container target is refused (leaves an error message)", () => {
  let state = init({
    sourceRows: [{ source: "/x", target: "/workspaces/p", readonly: false }],
  });
  state = reduce(state, { name: "char", char: "n" }).state; // -> source

  // Pick a second folder whose basename also yields /workspaces/p.
  state = openPicker(state, "source", "/other/place");
  state = setPickerListing(state, ["p"]);
  state = reduce(state, { name: "down" }).state; // cursor 0 -> "p"
  const desc = reduce(state, { name: "enter" });
  state = desc.state;
  state = setPickerListing(state, []);
  state = reduce(state, { name: "enter" }).state; // select /other/place/p (target /workspaces/p)

  // Rejected: still one row, and a message is shown.
  assertEquals(mounts(state, "source").rows.length, 1);
  assert(state.message.includes("/workspaces/p"));
});

Deno.test("edit container path via text input; dup edit refused", () => {
  let state = init({
    sourceRows: [
      { source: "/x", target: "/workspaces/a", readonly: false },
      { source: "/y", target: "/workspaces/b", readonly: false },
    ],
  });
  state = reduce(state, { name: "char", char: "n" }).state; // -> source
  // Focus the first row (Add header is -1; one down = row 0).
  state = reduce(state, { name: "down" }).state;
  // Edit its target to a new unique value.
  state = reduce(state, { name: "char", char: "e" }).state;
  assert(state.input !== null && state.input.editRow === 0);
  for (const k of decodeAll("/workspaces/z")) state = reduce(state, k).state;
  // Clear and retype: simplest is to just append then commit — but value started from old target.
  // Instead, verify commit of a fresh value: cancel and re-open, typing a full replacement.
  state = reduce(state, { name: "escape" }).state;
  state = reduce(state, { name: "char", char: "e" }).state;
  // Backspace the whole existing value then type a colliding one.
  for (let i = 0; i < 40; i++) {
    state = reduce(state, { name: "backspace" }).state;
  }
  for (const k of decodeAll("/workspaces/b")) state = reduce(state, k).state;
  state = reduce(state, { name: "enter" }).state;
  // Rejected: row 0 target unchanged, message set.
  assertEquals(mounts(state, "source").rows[0].target, "/workspaces/a");
  assert(state.message.includes("/workspaces/b"));
});

Deno.test("apply on review emits the two selections; cancel emits quit with nothing", () => {
  const state = init({
    sourceRows: [{ source: "/s", target: "/workspaces/s", readonly: false }],
    skillsRows: [{
      source: "/k",
      target: "/home/vscode/.claude/skills/k",
      readonly: true,
    }],
  });
  // Advance to review: overview -> source -> skills -> review.
  const { state: atReview } = drive(state, [
    { name: "char", char: "n" },
    { name: "char", char: "n" },
    { name: "char", char: "n" },
  ]);
  assertEquals(currentStep(atReview).kind, "review");
  const applied = reduce(atReview, { name: "char", char: "a" });
  assertEquals(applied.effect.type, "apply");
  if (applied.effect.type === "apply") {
    assertEquals(applied.effect.source, sourceRows(atReview));
    assertEquals(applied.effect.skills.length, 1);
  }

  // Q from any step quits without applying.
  const q = reduce(state, { name: "char", char: "q" });
  assertEquals(q.effect, { type: "quit" });
});
