// The pure UI core: rows, navigation, the three toggle flavors, filtering, and the dirty
// flag. No terminal, no files — `reduce` only ever returns state and (occasionally) an effect.

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@^1";
import { join } from "jsr:@std/path@^1";
import { type Config, DEFAULT_CONFIG } from "../config.ts";
import { scanRoot } from "../scan.ts";
import { listSkills } from "../skills.ts";
import { charKey, key, type Key } from "../tui/keys.ts";
import {
  type Effect,
  initialState,
  isDirty,
  markSaved,
  reduce,
  setSize,
  type UiState,
  visibleRows,
} from "../tui/state.ts";
import { makeExampleRoot, repo, withTemp } from "./helpers.ts";

interface Fixture {
  state: UiState;
  root: string;
  cfg: Config;
}

/**
 * The core plan's example root, plus a second project under `org` so the group has more than
 * one selectable descendant (that is what makes `[-]` observable), and two skill dirs.
 */
async function withUi(fn: (fx: Fixture) => Promise<void> | void): Promise<void> {
  await withTemp(async (tmp) => {
    const root = join(tmp, "root");
    const workspaceDir = join(tmp, "ws");
    const skillsRoot = join(tmp, "skills");
    await Deno.mkdir(root, { recursive: true });
    await Deno.mkdir(workspaceDir, { recursive: true });
    await makeExampleRoot(root);
    await repo(join(root, "org", "extra"));
    await Deno.mkdir(join(skillsRoot, "alpha"), { recursive: true });
    await Deno.mkdir(join(skillsRoot, "beta"), { recursive: true });

    const cfg: Config = { ...DEFAULT_CONFIG, root, skillsRoot };
    const tree = await scanRoot(root, cfg.maxDepth, { workspaceDir });
    const state = initialState({
      cfg,
      tree,
      skills: await listSkills(skillsRoot),
      skillsRoot,
      selection: new Set(),
      skillSelection: new Set(),
      paths: {
        devcontainer: join(workspaceDir, ".devcontainer", "devcontainer.json"),
        workspaceFile: join(workspaceDir, "ws.code-workspace"),
      },
      needsCreate: false,
      color: false,
    });
    await fn({ state, root, cfg });
  });
}

/** Apply keys in order, collecting any effects `reduce` asked for. */
function press(state: UiState, ...keys: Key[]): { state: UiState; effects: Effect[] } {
  const effects: Effect[] = [];
  let next = state;
  for (const k of keys) {
    const step = reduce(next, k);
    next = step.state;
    if (step.effect !== undefined) effects.push(step.effect);
  }
  return { state: next, effects };
}

const SPACE = charKey(" ");

function chars(text: string): Key[] {
  return [...text].map(charKey);
}

function rowKeys(state: UiState): string[] {
  return visibleRows(state).map((r) => r.key);
}

function markerOf(state: UiState, rowKey: string): string {
  const row = visibleRows(state).find((r) => r.key === rowKey);
  assert(row !== undefined, `no row ${rowKey}`);
  return row.marker;
}

/** Move the cursor onto a row by key, without caring how many `down`s that takes. */
function focus(state: UiState, rowKey: string): UiState {
  let next = press(state, key("home")).state;
  for (let i = 0; i < 100 && next.cursor !== rowKey; i++) {
    next = press(next, key("down")).state;
  }
  assertEquals(next.cursor, rowKey, `could not reach ${rowKey}`);
  return next;
}

Deno.test("state: rows are the tree plus the skills section, in scan order", async () => {
  await withUi(({ state }) => {
    assertEquals(rowKeys(state), [
      "section:projects",
      "node:org",
      "node:org/extra",
      "node:org/tools",
      "node:projecta",
      "node:projecta.worktrees/some-feature",
      "node:projectb",
      "node:projectb.worktrees/some-other",
      "node:projectb.worktrees/yet-another",
      "blank",
      "section:skills",
      "skill:alpha",
      "skill:beta",
    ]);
    // The cursor starts on the first focusable row, never on a heading.
    assertEquals(state.cursor, "node:org");
    const worktree = visibleRows(state).find((r) => r.key === "node:projectb.worktrees/yet-another")!;
    assertEquals(worktree.warnings, ["absolute gitdir"]);
  });
});

Deno.test("state: navigation skips headings, End lands last, left folds then walks up", async () => {
  await withUi(({ state }) => {
    // `down` many more times than there are rows: never a heading, never past the end.
    let cursor = state;
    const visited: string[] = [cursor.cursor];
    for (let i = 0; i < 30; i++) {
      cursor = press(cursor, key("down")).state;
      visited.push(cursor.cursor);
    }
    for (const c of visited) {
      assert(!c.startsWith("section:") && c !== "blank", `cursor landed on ${c}`);
    }
    assertEquals(cursor.cursor, "skill:beta");
    assertEquals(press(state, key("end")).state.cursor, "skill:beta");
    assertEquals(press(cursor, key("home")).state.cursor, "node:org");
    assertEquals(press(cursor, charKey("g")).state.cursor, "node:org");
    assertEquals(press(state, charKey("G")).state.cursor, "skill:beta");

    // `left` on a leaf jumps to its parent; on the parent it folds it away.
    const onLeaf = focus(state, "node:org/tools");
    const atParent = press(onLeaf, key("left")).state;
    assertEquals(atParent.cursor, "node:org");
    const folded = press(atParent, key("left")).state;
    assert(!rowKeys(folded).includes("node:org/tools"));
    assertEquals(markerOf(folded, "node:org"), "off");
    assertEquals(
      visibleRows(folded).find((r) => r.key === "node:org")!.fold,
      "collapsed",
    );

    // `right` expands it again; on a leaf it does nothing.
    const unfolded = press(folded, key("right")).state;
    assert(rowKeys(unfolded).includes("node:org/tools"));
    const leaf = focus(unfolded, "node:org/tools");
    assertEquals(rowKeys(press(leaf, key("right")).state), rowKeys(leaf));

    // Tab jumps to the first row of the next section, and wraps.
    const skills = press(state, key("tab")).state;
    assertEquals(skills.cursor, "skill:alpha");
    assertEquals(press(skills, key("tab")).state.cursor, "node:org");
  });
});

Deno.test("state: toggling a worktree makes its primary [~], and [~] never becomes [ ]", async () => {
  await withUi(({ state }) => {
    const onWorktree = focus(state, "node:projectb.worktrees/some-other");
    const selected = press(onWorktree, SPACE).state;
    assertEquals([...selected.selection], ["projectb.worktrees/some-other"]);
    assertEquals(markerOf(selected, "node:projectb.worktrees/some-other"), "on");
    assertEquals(markerOf(selected, "node:projectb"), "auto");
    assertStringIncludes(
      visibleRows(selected).find((r) => r.key === "node:projectb")!.notes.join(" "),
      "(required by worktree)",
    );

    // Explicit on the primary: `[~]` → `[x]`.
    const explicit = press(focus(selected, "node:projectb"), SPACE).state;
    assertEquals(markerOf(explicit, "node:projectb"), "on");
    assert(explicit.selection.has("projectb"));

    // And back: `[x]` → `[~]`, not `[ ]`, with the reason on the message line.
    const back = press(explicit, SPACE).state;
    assertEquals(markerOf(back, "node:projectb"), "auto");
    assert(!back.selection.has("projectb"));
    assertStringIncludes(back.message, "stays mounted");

    // Deselecting the worktree finally releases it.
    const released = press(focus(back, "node:projectb.worktrees/some-other"), SPACE).state;
    assertEquals(markerOf(released, "node:projectb"), "off");
    assertEquals([...released.selection], []);
  });
});

Deno.test("state: toggling a group selects all its descendants, then none", async () => {
  await withUi(({ state }) => {
    const onGroup = focus(state, "node:org");
    const all = press(onGroup, SPACE).state;
    assertEquals([...all.selection].sort(), ["org/extra", "org/tools"]);
    assertEquals(markerOf(all, "node:org"), "on");

    const none = press(all, SPACE).state;
    assertEquals([...none.selection], []);
    assertEquals(markerOf(none, "node:org"), "off");

    // One of two selected: the group reports `[-]`.
    const partial = press(focus(none, "node:org/tools"), SPACE).state;
    assertEquals(markerOf(partial, "node:org"), "partial");
  });
});

Deno.test("state: a filter narrows the rows, and a/n act on the matches only", async () => {
  await withUi(({ state }) => {
    const filtered = press(state, charKey("/"), ...chars("some"), key("enter")).state;
    assertEquals(filtered.mode, "nav");
    assertEquals(rowKeys(filtered), [
      "section:projects",
      "node:projecta",
      "node:projecta.worktrees/some-feature",
      "node:projectb",
      "node:projectb.worktrees/some-other",
      "blank",
      "section:skills",
      "note:(no skills)",
    ]);
    // Ancestors are shown for context but are not themselves matches.
    const rows = visibleRows(filtered);
    assertEquals(rows.find((r) => r.key === "node:projecta")!.matched, false);
    assertEquals(rows.find((r) => r.key === "node:projecta.worktrees/some-feature")!.matched, true);

    const selected = press(filtered, charKey("a")).state;
    assertEquals([...selected.selection].sort(), [
      "projecta.worktrees/some-feature",
      "projectb.worktrees/some-other",
    ]);
    assertEquals(selected.skillSelection.size, 0);

    // Esc clears the filter without touching the selection.
    const cleared = press(selected, key("escape")).state;
    assertEquals(cleared.filter, "");
    assertEquals(rowKeys(cleared).length, 13);
    assertEquals([...cleared.selection].sort(), [
      "projecta.worktrees/some-feature",
      "projectb.worktrees/some-other",
    ]);

    // `n` on the same filtered set takes them back out again.
    const off = press(selected, charKey("/"), key("enter"), charKey("n")).state;
    assertEquals([...off.selection], []);

    // Backspacing the filter widens it again.
    const wider = press(filtered, charKey("/"), key("backspace"), key("backspace")).state;
    assertEquals(wider.filter, "so");
    assert(rowKeys(wider).includes("node:projectb.worktrees/some-other"));
  });
});

Deno.test("state: unfiltered a/n act on every visible selectable row", async () => {
  await withUi(({ state }) => {
    const all = press(state, charKey("a")).state;
    assertEquals([...all.selection].sort(), [
      "org/extra",
      "org/tools",
      "projecta",
      "projecta.worktrees/some-feature",
      "projectb",
      "projectb.worktrees/some-other",
      "projectb.worktrees/yet-another",
    ]);
    assertEquals([...all.skillSelection].sort(), ["alpha", "beta"]);
    assertEquals([...press(all, charKey("n")).state.selection], []);

    // A folded-away row is not visible, so `a` leaves it alone.
    const folded = press(focus(state, "node:org"), key("left")).state;
    const some = press(folded, charKey("a")).state;
    assert(!some.selection.has("org/tools"));
  });
});

Deno.test("state: dirty tracks the selection against what is on disk", async () => {
  await withUi(({ state }) => {
    assertEquals(isDirty(state), false);
    const toggled = press(focus(state, "node:projecta"), SPACE).state;
    assertEquals(isDirty(toggled), true);

    // Toggling back to the baseline is not dirty either.
    assertEquals(isDirty(press(toggled, SPACE).state), false);

    // `w` asks for a write; the app calls markSaved when it succeeds.
    const step = reduce(toggled, charKey("w"));
    assertEquals(step.effect, { type: "write" });
    assertEquals(isDirty(markSaved(step.state, "wrote")), false);

    // A skill counts too.
    const skill = press(focus(state, "skill:alpha"), SPACE).state;
    assertEquals(isDirty(skill), true);
  });
});

Deno.test("state: q and w prompt when they need to, Ctrl-C never does", async () => {
  await withUi(({ state }) => {
    // Clean: `q` quits straight away.
    assertEquals(press(state, charKey("q")).effects, [{ type: "quit", save: false }]);

    const dirty = press(focus(state, "node:projecta"), SPACE).state;
    const prompt = press(dirty, charKey("q"));
    assertEquals(prompt.effects, []);
    assertEquals(prompt.state.mode, "confirm");
    assertEquals(prompt.state.confirm?.kind, "quit");
    assertEquals(press(prompt.state, charKey("y")).effects, [{ type: "quit", save: true }]);
    assertEquals(press(prompt.state, charKey("n")).effects, [{ type: "quit", save: false }]);
    const cancelled = press(prompt.state, charKey("c")).state;
    assertEquals(cancelled.mode, "nav");
    assertEquals(cancelled.message, "cancelled");
    // Any other key cancels as well.
    assertEquals(press(prompt.state, charKey("z")).state.mode, "nav");

    // A missing devcontainer means `w` asks first.
    const needsCreate = press({ ...dirty, needsCreate: true }, charKey("w"));
    assertEquals(needsCreate.effects, []);
    assertEquals(needsCreate.state.confirm?.kind, "write-create");
    assertStringIncludes(needsCreate.state.confirm!.text, "devcontainer.json");
    assertEquals(press(needsCreate.state, charKey("y")).effects, [{ type: "write" }]);
    assertEquals(press(needsCreate.state, charKey("n")).effects, []);

    // Ctrl-C quits from every mode, writing nothing.
    for (const from of [state, dirty, prompt.state, press(state, charKey("/")).state]) {
      assertEquals(press(from, key("ctrl-c")).effects, [{ type: "quit", save: false }]);
    }

    // `r` asks for a rescan, `?` opens help and any key closes it.
    assertEquals(press(state, charKey("r")).effects, [{ type: "rescan" }]);
    const help = press(state, charKey("?")).state;
    assertEquals(help.mode, "help");
    assertEquals(press(help, charKey("x")).state.mode, "nav");
  });
});

Deno.test("state: scrolling keeps a margin around the cursor", async () => {
  await withUi(({ state }) => {
    // 13 rows in a 6-row body.
    const small = setSize(state, { rows: 9 });
    assertEquals(small.bodyHeight, 6);
    assertEquals(small.offset, 0);

    const down = press(small, key("down"), key("down"), key("down")).state;
    assertEquals(down.cursor, "node:projecta");
    assertEquals(down.offset, 1); // pushed by the 2-row bottom margin

    const end = press(small, key("end")).state;
    assertEquals(end.cursor, "skill:beta");
    assertEquals(end.offset, 13 - 6);

    const home = press(end, key("home")).state;
    assertEquals(home.offset, 0);

    // Paging moves about a screen at a time and stops at the ends.
    const paged = press(small, key("pagedown")).state;
    assertEquals(paged.cursor, "node:projectb");
    assertEquals(press(paged, key("pageup")).state.cursor, "node:org");

    // A body taller than the list never scrolls.
    assertEquals(press(state, key("end")).state.offset, 0);
  });
});
