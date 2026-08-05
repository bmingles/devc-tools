// The folder picker's pure core, driven headlessly: scripted key sequences through `reduce`,
// plus a `render` frame assertion with colour off. No TTY involved — same style as the other
// pure-state suites.

import { assert, assertEquals } from "jsr:@std/assert@^1";
import { decodeAll } from "../tui/keys.ts";
import {
  type EntryFlag,
  initialState,
  type PickerState,
  reduce,
  render,
  setFlags,
  setListing,
  visible,
} from "../tui/folder_picker.ts";

// A deterministic fake filesystem so navigation is reproducible.
const FS: Record<string, string[]> = {
  "/home/me": [".claude", "downloads", "projects", "work"],
  "/home/me/.claude": ["plugins", "skills"],
  "/home/me/projects": ["app", "lib"],
  "/home/me/code": ["app", "lib"],
  "/home/me/code/app": ["src"],
  "/home/me/skills": ["review", "writing"],
};
const list = (p: string) => FS[p] ?? [];

/** Feed a key string through `reduce`, resolving any `readDir` effect against the fake FS. */
function feed(state: PickerState, text: string): PickerState {
  let s = state;
  for (const k of decodeAll(text)) {
    const step = reduce(s, k);
    s = step.state;
    if (step.effect.type === "readDir") {
      s = setListing(s, step.effect.path, list(step.effect.path));
    }
  }
  return s;
}

function start(): PickerState {
  const s = initialState("/home/me", false);
  return setListing(s, "/home/me", list("/home/me"));
}

Deno.test("typing narrows the current folder (case-insensitive substring)", () => {
  const s = feed(start(), "cla");
  assertEquals(visible(s), [".claude"]);
  assertEquals(s.filter, "cla");
  assertEquals(s.cursor, 0);
});

Deno.test("right opens the focused folder and clears the filter", () => {
  // filter to .claude, then open it
  const s = feed(start(), "cla\x1b[C");
  assertEquals(s.cwd, "/home/me/.claude");
  assertEquals(s.filter, "");
  assertEquals(visible(s), ["plugins", "skills"]);
});

Deno.test("left walks up a level", () => {
  const s = feed(start(), "cla\x1b[C\x1b[D");
  assertEquals(s.cwd, "/home/me");
});

Deno.test("backspace deletes the filter, then walks up when empty", () => {
  // type "cla" (filter), backspace x3 empties it, one more backspace walks up from a child
  let s = feed(start(), "cla\x1b[C"); // now in /home/me/.claude, filter empty
  s = feed(s, "pl"); // filter "pl"
  assertEquals(s.filter, "pl");
  s = feed(s, "\x7f\x7f"); // two backspaces empty the filter
  assertEquals(s.filter, "");
  s = feed(s, "\x7f"); // empty-filter backspace walks up
  assertEquals(s.cwd, "/home/me");
});

Deno.test("space ticks the focused folder and selection persists across folders", () => {
  // open .claude, tick plugins, down, tick skills, go back up — both survive
  const s = feed(start(), "cla\x1b[C \x1b[B \x1b[D");
  assertEquals(s.cwd, "/home/me");
  assertEquals(s.selected, [
    "/home/me/.claude/plugins",
    "/home/me/.claude/skills",
  ]);
  // and a second space on an already-ticked row unticks it
  const s2 = feed(start(), "cla\x1b[C  "); // tick then untick plugins
  assertEquals(s2.selected, []);
});

Deno.test("enter finishes; escape cancels", () => {
  const done = feed(start(), " \r"); // tick .claude, enter
  assert(done.done);
  assert(!done.cancelled);
  assertEquals(done.selected, ["/home/me/.claude"]);

  const cancelled = feed(start(), " \x1b"); // tick, escape
  assert(cancelled.cancelled);
  assert(!cancelled.done);
});

Deno.test("preselected paths render as ticked", () => {
  const s = setListing(
    initialState("/home/me", false, ["/home/me/work"]),
    "/home/me",
    list("/home/me"),
  );
  const frame = render(s, { columns: 60, rows: 20 }).join("\n");
  assert(frame.includes("◉ work/"), "preselected 'work' should be ticked");
  assert(frame.includes("◯ downloads/"), "unselected 'downloads' should be empty");
});

// ── Picks pane (the selected list above the browser, editable in place) ─────────

Deno.test("tab enters the picks pane and space removes the focused pick", () => {
  // open .claude, tick plugins, down, tick skills → two picks, still in the tree
  let s = feed(start(), "cla\x1b[C \x1b[B ");
  assertEquals(s.selected, [
    "/home/me/.claude/plugins",
    "/home/me/.claude/skills",
  ]);
  assertEquals(s.focus, "tree");

  s = feed(s, "\t"); // tab → picks pane, cursor on the first pick
  assertEquals(s.focus, "selected");
  assertEquals(s.selCursor, 0);

  s = feed(s, " "); // remove the focused pick (plugins)
  assertEquals(s.selected, ["/home/me/.claude/skills"]);
  assertEquals(s.focus, "selected");

  s = feed(s, " "); // removing the last pick drops back to the browser
  assertEquals(s.selected, []);
  assertEquals(s.focus, "tree");
});

Deno.test("↑ off the top of the browser steps into the picks pane; ↓ returns", () => {
  // tick .claude, down, tick downloads → two picks, browser cursor on "downloads"
  let s = feed(start(), " \x1b[B ");
  assertEquals(s.selected, ["/home/me/.claude", "/home/me/downloads"]);
  assertEquals(s.focus, "tree");

  s = feed(s, "\x1b[A"); // up → browser cursor back to the top row
  assertEquals(s.focus, "tree");
  assertEquals(s.cursor, 0);

  s = feed(s, "\x1b[A"); // up at the top → cross into the picks, on the pick nearest the browser
  assertEquals(s.focus, "selected");
  assertEquals(s.selCursor, 1);

  s = feed(s, "\x1b[B"); // down off the bottom of the picks → back into the browser
  assertEquals(s.focus, "tree");
  assertEquals(s.cursor, 0);
});

Deno.test("picks pane: ↑↓ move the pick cursor; backspace removes that one", () => {
  // tick .claude, down, tick downloads
  let s = feed(start(), " \x1b[B ");
  assertEquals(s.selected, ["/home/me/.claude", "/home/me/downloads"]);

  s = feed(s, "\t\x1b[B\x7f"); // tab in, down to the 2nd pick, backspace removes it
  assertEquals(s.selected, ["/home/me/.claude"]);
  assertEquals(s.focus, "selected");
});

Deno.test("tab / left leave the picks pane without removing anything", () => {
  let s = feed(start(), " \t"); // tick .claude, tab into picks
  assertEquals(s.focus, "selected");
  s = feed(s, "\x1b[D"); // left → back to the browser
  assertEquals(s.focus, "tree");
  assertEquals(s.selected, ["/home/me/.claude"]);
});

Deno.test("tab is a no-op when nothing is picked", () => {
  const s = feed(start(), "\t");
  assertEquals(s.focus, "tree");
});

Deno.test("render: the picks list sits above the browser and shows ticked folders", () => {
  const s = setListing(
    initialState("/home/me", false, ["/home/me/work"]),
    "/home/me",
    list("/home/me"),
  );
  const frame = render(s, { columns: 60, rows: 20 });
  const picksIdx = frame.findIndex((l) => l.includes("Selected"));
  const browserIdx = frame.findIndex((l) => l.includes("Add Folders"));
  assert(picksIdx >= 0, "picks heading present");
  assert(browserIdx >= 0, "browse heading present");
  assert(picksIdx < browserIdx, "the picks list is rendered above the browser");
  assert(
    frame.join("\n").includes("◉ /home/me/work"),
    "the pick is listed in the picks section",
  );
});

Deno.test("the ▸ cursor is the only thing that marks the focused section", () => {
  let s = feed(start(), " "); // tick .claude → one pick, browser still focused
  let frame = render(s, { columns: 60, rows: 20 });
  // Browser focused: the cursor is on a browse entry (a folder name ending in "/").
  let cursorLine = frame.find((l) => l.includes("▸"))!;
  assert(cursorLine.includes(".claude/"), "cursor is on a browse row when the browser is focused");
  const headings = () => frame.filter((l) => /Selected|Add Folders/.test(l));
  const browseFocused = headings();

  s = feed(s, "\t"); // move focus to the picks list
  frame = render(s, { columns: 60, rows: 20 });
  cursorLine = frame.find((l) => l.includes("▸"))!;
  assert(
    cursorLine.includes("/home/me/.claude") && !cursorLine.includes(".claude/"),
    "cursor is on a pick (an absolute path) when the picks list is focused",
  );
  // The headings themselves are identical either way — focus must not restyle a section.
  assertEquals(headings(), browseFocused, "section headings do not change with focus");
});

Deno.test("an invalid-worktree entry renders the ⚠ marker + reason", () => {
  const flags = new Map<string, EntryFlag>([
    ["projects", { worktree: true, valid: false, reason: "worktree uses absolute paths" }],
    ["work", { worktree: true, valid: true }], // valid worktree → no marker
  ]);
  const s = setFlags(start(), flags);
  const frame = render(s, { columns: 100, rows: 20 }).join("\n");
  assert(
    frame.includes("projects/  ⚠ primary not mounted (worktree uses absolute paths)"),
    "invalid worktree is flagged with its reason",
  );
  // A valid worktree and a plain folder carry no marker.
  assert(!frame.includes("work/  ⚠"), "valid worktree is not flagged");
  assert(!frame.includes("downloads/  ⚠"), "plain folder is not flagged");
});

Deno.test("render has no ANSI escapes when colour is off", () => {
  const frame = render(start(), { columns: 60, rows: 20 }).join("\n");
  // deno-lint-ignore no-control-regex
  assert(!/\x1b\[/.test(frame), "no SGR sequences with colour off");
  assertEquals(render(start(), { columns: 60, rows: 20 }).length, 20);
});

// ── Bounded mode (roots as top-level boundaries) ────────────────────────────────

const ROOTS = ["/home/me/code", "/home/me/skills"];
const bounded = () => initialState("/unused", false, [], ROOTS);

Deno.test("bounded with a single root opens inside it, not on a roots list", () => {
  const s = initialState("/unused", false, [], ["/home/me/code"]);
  assert(!s.atRoots, "a single root starts inside the root");
  assertEquals(s.cwd, "/home/me/code");
});

Deno.test("bounded single root: ← at the root is a no-op (no roots list to return to)", () => {
  const base = initialState("/unused", false, [], ["/home/me/code"]);
  const s = setListing(base, base.cwd, list(base.cwd));
  assertEquals(visible(s), ["app", "lib"]); // opened straight into the root
  const s2 = feed(s, "\x1b[D"); // ← at the root
  assertEquals(s2.cwd, "/home/me/code");
  assert(!s2.atRoots);
});

Deno.test("bounded: opens on the roots list, not a directory", () => {
  const s = bounded();
  assert(s.atRoots);
  assertEquals(visible(s), ROOTS);
});

Deno.test("bounded: right opens the focused root into its subtree", () => {
  const s = feed(bounded(), "\x1b[C"); // right on /home/me/code
  assert(!s.atRoots);
  assertEquals(s.cwd, "/home/me/code");
  assertEquals(visible(s), ["app", "lib"]);
});

Deno.test("bounded: roots are not selectable (space is a no-op at the roots list)", () => {
  const s = feed(bounded(), " ");
  assertEquals(s.selected, []);
  assert(s.atRoots);
});

Deno.test("bounded: left never escapes a root — it stops at the roots list", () => {
  // code → app (deeper), then walk back up: app → code → roots → (stays) roots
  let s = feed(bounded(), "\x1b[C\x1b[C"); // into code, then into app
  assertEquals(s.cwd, "/home/me/code/app");
  s = feed(s, "\x1b[D"); // up to the root itself
  assertEquals(s.cwd, "/home/me/code");
  assert(!s.atRoots);
  s = feed(s, "\x1b[D"); // at the root, left returns to the roots list
  assert(s.atRoots);
  s = feed(s, "\x1b[D"); // already at the top: no-op, never above a root
  assert(s.atRoots);
});

Deno.test("bounded: folders inside a root are selectable and persist across roots", () => {
  let s = feed(bounded(), "\x1b[C "); // open code, tick "app"
  assertEquals(s.selected, ["/home/me/code/app"]);
  s = feed(s, "\x1b[D"); // back to roots
  assert(s.atRoots);
  assertEquals(s.selected, ["/home/me/code/app"]); // survives leaving the root
  const done = feed(s, "\r");
  assertEquals(done.selected, ["/home/me/code/app"]);
});

Deno.test("the labels are the screen's copy, not hardcoded strings", () => {
  const s = setListing(
    initialState("/home/me", false, [], null, {
      screen: "GLOBAL CONFIG",
      picks: "Source Folder Roots",
      browse: "Add Roots",
    }),
    "/home/me",
    list("/home/me"),
  );
  const frame = render(s, { columns: 60, rows: 20 });
  assertEquals(frame[0], "GLOBAL CONFIG", "the banner is the first line, flush left");
  assertEquals(frame[1], "", "a blank line sets the banner off from the sections");
  assertEquals(frame[2], " Source Folder Roots");
  assert(
    frame.some((l) => l.startsWith(" Add Roots  /home/me/")),
    "the browse heading carries the current folder",
  );
  assert(!frame.join("\n").includes("Pick folders"), "no leftover default heading");
});

Deno.test("frame: banner, two sections split by blank lines, one rule above the legend", () => {
  const s = setListing(
    initialState("/home/me", false, ["/home/me/work"], null, {
      screen: "WORKSPACE CONFIG",
      picks: "Source Folders",
      browse: "Add Source Folders",
    }),
    "/home/me",
    list("/home/me"),
  );
  const frame = render(s, { columns: 60, rows: 20 });
  assertEquals(frame.slice(0, 6), [
    "WORKSPACE CONFIG",
    "",
    " Source Folders",
    "",
    "   ◉ /home/me/work",
    "",
  ]);
  assertEquals(frame[6], " Add Source Folders  /home/me/");
  assertEquals(frame[7], "  > type to filter folders", "the filter line is a `>` prompt");
  // Exactly one divider, and it sits directly above the legend.
  const rules = frame.filter((l) => l.startsWith("─"));
  assertEquals(rules.length, 1, "no rule between the two sections");
  assertEquals(frame.indexOf(rules[0]), frame.length - 2);
  assert(frame[frame.length - 1].includes("⏎ done"), "the legend is the last line");
});

Deno.test("frame: typing replaces the filter placeholder", () => {
  const s = feed(start(), "cla");
  const frame = render(s, { columns: 60, rows: 20 });
  assert(frame.includes("  > cla"), "the typed filter shows after the prompt");
  assert(!frame.some((l) => l.includes("type to filter folders")), "placeholder is gone");
});

Deno.test("frame: an empty picks list says so only when nothing is pinned", () => {
  const frame = render(start(), { columns: 60, rows: 20 }).join("\n");
  assert(frame.includes("  (none yet)"));
});

// ── Pinned folder (mounted implicitly, never a pick) ────────────────────────────

const PIN = { path: "/home/me/projects", note: "this project (always mounted)" };

/** Browsing /home/me with `projects` pinned. */
function withPin(preselected: string[] = []): PickerState {
  const s = initialState("/home/me", false, preselected, null, undefined, PIN);
  return setListing(s, "/home/me", list("/home/me"));
}

Deno.test("pinned: heads the picks list, so an empty one isn't 'nothing mounted'", () => {
  const frame = render(withPin(), { columns: 80, rows: 20 }).join("\n");
  assert(
    frame.includes("◎ /home/me/projects  this project (always mounted)"),
    "the pinned folder is listed with its reason",
  );
  assert(
    !frame.includes("(none yet)"),
    "an empty-list placeholder would contradict the pinned row",
  );
});

Deno.test("pinned: the tree row is marked and inert — space cannot tick it", () => {
  const frame = render(withPin(), { columns: 80, rows: 20 }).join("\n");
  assert(
    frame.includes("◎ projects/  this project (always mounted)"),
    "the pinned folder is marked in the tree too",
  );
  const s = feed(withPin(), "\x1b[B\x1b[B "); // down to "projects", space
  assertEquals(s.selected, [], "the pinned folder never becomes a pick");
  assertEquals(feed(s, "\t").focus, "tree", "with no picks, tab still cannot enter the pane");
  // A neighbouring folder still ticks normally.
  assertEquals(feed(s, "\x1b[B ").selected, ["/home/me/work"]);
});

Deno.test("pinned: a preselected path equal to the pin is not also shown as a pick", () => {
  const s = withPin(["/home/me/projects", "/home/me/work"]);
  assertEquals(s.selected, ["/home/me/work"]);
  const frame = render(s, { columns: 80, rows: 20 }).join("\n");
  assert(!frame.includes("◉ /home/me/projects"), "the pin is not duplicated as a pick");
  assert(frame.includes("◎ projects/"), "and it keeps the pinned marker in the tree");
});

Deno.test("bounded: roots render without a checkbox (they are boundaries, not picks)", () => {
  const frame = render(bounded(), { columns: 60, rows: 20 }).join("\n");
  assert(frame.includes("/home/me/code/"), "roots shown as navigable folders");
  assert(!frame.includes("◯"), "the roots list carries no checkboxes");
});
