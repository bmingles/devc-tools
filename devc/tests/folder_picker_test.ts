// The folder picker's pure core, driven headlessly: scripted key sequences through `reduce`,
// plus a `render` frame assertion with colour off. No TTY involved — same style as the other
// pure-state suites.

import { assert, assertEquals } from "jsr:@std/assert@^1";
import { decodeAll } from "../tui/keys.ts";
import {
  initialState,
  type PickerState,
  reduce,
  render,
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

Deno.test("render has no ANSI escapes when colour is off", () => {
  const frame = render(start(), { columns: 60, rows: 20 }).join("\n");
  // deno-lint-ignore no-control-regex
  assert(!/\x1b\[/.test(frame), "no SGR sequences with colour off");
  assertEquals(render(start(), { columns: 60, rows: 20 }).length, 20);
});

// ── Bounded mode (roots as top-level boundaries) ────────────────────────────────

const ROOTS = ["/home/me/code", "/home/me/skills"];
const bounded = () => initialState("/unused", false, [], ROOTS);

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

Deno.test("the title is the heading, not a hardcoded string", () => {
  const s = initialState("/home/me", false, [], null, "Pick your code folder root(s)");
  const frame = render(s, { columns: 60, rows: 20 }).join("\n");
  assert(frame.includes("Pick your code folder root(s)"));
  assert(!frame.includes("pick folders to mount"));
});

Deno.test("bounded: roots render without a checkbox (they are boundaries, not picks)", () => {
  const frame = render(bounded(), { columns: 60, rows: 20 }).join("\n");
  assert(frame.includes("/home/me/code/"), "roots shown as navigable folders");
  assert(!frame.includes("◯"), "the roots list carries no checkboxes");
});
