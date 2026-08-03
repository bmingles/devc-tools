// The renderer's contract: exactly `size.rows` lines, never wider than `size.columns`, one
// reverse-video row, a scrollbar only when it is needed, and nothing encoded in colour alone.

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@^1";
import { join } from "jsr:@std/path@^1";
import { type Config, DEFAULT_CONFIG } from "../config.ts";
import { scanRoot } from "../scan.ts";
import { listSkills } from "../skills.ts";
import { charKey, key } from "../tui/keys.ts";
import {
  colorEnabled,
  MIN_COLUMNS,
  render,
  type Size,
  stripAnsi,
  TOO_SMALL,
} from "../tui/render.ts";
import { initialState, reduce, setSize, type UiState } from "../tui/state.ts";
import { makeExampleRoot, repo, withTemp, worktree } from "./helpers.ts";

async function withUi(fn: (state: UiState) => Promise<void> | void): Promise<void> {
  await withTemp(async (tmp) => {
    const root = join(tmp, "root");
    const workspaceDir = join(tmp, "ws");
    const skillsRoot = join(tmp, "skills");
    await Deno.mkdir(root, { recursive: true });
    await Deno.mkdir(workspaceDir, { recursive: true });
    await makeExampleRoot(root);
    await Deno.mkdir(join(skillsRoot, "alpha"), { recursive: true });
    await Deno.mkdir(join(skillsRoot, "beta"), { recursive: true });
    const cfg: Config = { ...DEFAULT_CONFIG, root, skillsRoot };
    await fn(initialState({
      cfg,
      tree: await scanRoot(root, cfg.maxDepth, { workspaceDir }),
      skills: await listSkills(skillsRoot),
      skillsRoot,
      selection: new Set(["projectb.worktrees/some-other"]),
      skillSelection: new Set(["alpha"]),
      paths: {
        devcontainer: join(workspaceDir, ".devcontainer", "devcontainer.json"),
        workspaceFile: join(workspaceDir, "ws.code-workspace"),
      },
      needsCreate: false,
      color: true,
    }));
  });
}

const SIZES: Size[] = [
  { columns: 80, rows: 24 },
  { columns: 120, rows: 40 },
  { columns: 40, rows: 10 },
];

function widths(lines: string[]): number[] {
  return lines.map((l) => stripAnsi(l).length);
}

Deno.test("render: every size yields exactly rows lines, none too wide", async () => {
  await withUi((state) => {
    for (const size of SIZES) {
      const lines = render(setSize(state, size), size);
      assertEquals(lines.length, size.rows, `${size.columns}x${size.rows}`);
      for (const w of widths(lines)) {
        assert(w <= size.columns, `line of ${w} columns in a ${size.columns}-column frame`);
      }
    }
  });
});

Deno.test("render: the header, message and keys lines say what they should", async () => {
  await withUi((state) => {
    const size = { columns: 80, rows: 24 };
    const lines = render(setSize(state, size), size).map(stripAnsi);
    // 2 mounts (the worktree plus its auto primary), 1 folder, 1 skill.
    assertStringIncludes(lines[0], "devc");
    assertStringIncludes(lines[0], "-> /workspaces");
    assertStringIncludes(lines[0], "2 mounts  1 folders  1 skills");
    assert(!lines[0].includes("*unsaved"));
    assertStringIncludes(lines[1], "PROJECTS");
    assertStringIncludes(lines[size.rows - 1], "q quit");

    // Selection markers, the auto primary and its note, and the worktree warning.
    const body = lines.slice(1, size.rows - 2);
    assertStringIncludes(body.find((l) => l.includes("some-other"))!, "[x]");
    assertStringIncludes(body.find((l) => l.includes("[~] projectb"))!, "(required by worktree)");
    assertStringIncludes(body.find((l) => l.includes("yet-another"))!, "! absolute gitdir");
    assertStringIncludes(body.find((l) => l.includes("alpha"))!, "[x]");
    assertStringIncludes(body.find((l) => l.includes("beta"))!, "[ ]");
    // The skills heading names both ends of the mapping (a wide frame shows all of it).
    const wide = { columns: 160, rows: 24 };
    assertStringIncludes(
      render(setSize(state, wide), wide).map(stripAnsi).find((l) => l.includes("SKILLS"))!,
      "-> /home/vscode/.claude/skills",
    );

    // A toggle marks the header unsaved and a message shows up on the message line.
    const dirty = reduce(setSize(state, size), charKey(" ")).state;
    const after = render(dirty, size).map(stripAnsi);
    assertStringIncludes(after[0], "*unsaved");

    // Filter mode takes over the message and keys lines.
    const filtering = reduce(dirty, charKey("/")).state;
    const prompt = render(reduce(filtering, charKey("s")).state, size).map(stripAnsi);
    assertStringIncludes(prompt[size.rows - 2], "filter: s");
    assertStringIncludes(prompt[size.rows - 1], "Esc clear");

    // The help overlay replaces the body.
    const help = render(reduce(state, charKey("?")).state, size).map(stripAnsi);
    assertStringIncludes(help[1], "KEYBINDINGS");
    assertStringIncludes(help.join("\n"), "quit now, writing nothing");
  });
});

Deno.test("render: the cursor row is the only reverse-video row", async () => {
  await withUi((state) => {
    const size = { columns: 80, rows: 24 };
    const sized = setSize(state, size);
    const lines = render(sized, size);
    assertEquals(lines.filter((l) => l.includes("\x1b[7m")).length, 1);
    const cursorLine = lines.find((l) => l.includes("\x1b[7m"))!;
    // The row is also marked in plain text, so `--no-color` loses nothing.
    assertStringIncludes(stripAnsi(cursorLine), ">");
    assertStringIncludes(stripAnsi(cursorLine), "org");

    // `org` starts folded, so open it before stepping into it.
    const opened = reduce(sized, key("right")).state;
    const moved = render(reduce(opened, key("down")).state, size);
    assertEquals(moved.filter((l) => l.includes("\x1b[7m")).length, 1);
    assertStringIncludes(stripAnsi(moved.find((l) => l.includes("\x1b[7m"))!), "tools");
  });
});

Deno.test("render: the fold column is fold state only, and no checkbox means not selectable", async () => {
  await withTemp(async (tmp) => {
    // A root holding the workspace dir itself, a normal worktree group, and an orphaned one —
    // every reason a row can be unselectable, in one frame.
    const root = join(tmp, "root");
    const workspaceDir = join(root, "here");
    await repo(workspaceDir);
    await repo(join(root, "projecta"));
    await worktree(join(root, "projecta.worktrees", "feat"), "../../projecta/.git/worktrees/feat");
    await worktree(join(root, "orphan.worktrees", "stray"), "../../orphan/.git/worktrees/stray");

    const cfg: Config = { ...DEFAULT_CONFIG, root };
    const state = initialState({
      cfg,
      tree: await scanRoot(root, cfg.maxDepth, { workspaceDir }),
      skills: [],
      skillsRoot: "",
      selection: new Set(),
      skillSelection: new Set(),
      paths: { devcontainer: "d", workspaceFile: "w" },
      needsCreate: false,
      color: false,
    });

    const size = { columns: 80, rows: 24 };
    // Rows sort by name: here, orphan.worktrees, projecta, projecta.worktrees. Open the
    // orphan group so one of each fold state is on screen.
    const expanded = reduce(reduce(setSize(state, size), key("down")).state, key("right")).state;
    const body = render(expanded, size).slice(1, size.rows - 2);
    const row = (text: string) => body.find((l) => l.includes(text))!;

    // Fold column: `>` closed, `v` open, blank for a leaf — and nothing else. The old `x`
    // (which meant "not selectable") is gone, so no row starts with one.
    assertStringIncludes(row("orphan.worktrees"), "v");
    assertStringIncludes(row("projecta.worktrees"), ">");
    for (const line of body) {
      assertEquals(/^.\s*x/.test(line), false, `fold-column x in ${JSON.stringify(line)}`);
    }

    // No checkbox at all is how a row says it cannot be checked; the text says why.
    assertStringIncludes(row("here"), "(workspace)");
    assertEquals(row("here").includes("["), false, "the workspace dir has no checkbox");
    assertStringIncludes(row("stray"), "! primary repo not found");
    assertEquals(row("stray").includes("["), false, "an orphaned worktree has no checkbox");
    assertEquals(row("orphan.worktrees").includes("["), false, "nothing selectable beneath it");

    // A group with something selectable under it does get one.
    assertStringIncludes(row("projecta.worktrees"), "[ ]");
  });
});

Deno.test("render: the scrollbar shows up only when the body overflows", async () => {
  await withUi((state) => {
    // 12 rows in a 21-row body: no scrollbar at all, so the last column is content or blank
    // (neither `|` nor `#` occurs anywhere in this fixture's text).
    const roomy = { columns: 80, rows: 24 };
    const wide = render(setSize(state, roomy), roomy).map(stripAnsi);
    const body = (lines: string[], size: Size) => lines.slice(1, size.rows - 2);
    for (const line of body(wide, roomy)) {
      assert(!"|#".includes(line[roomy.columns - 1]), `scrollbar in ${JSON.stringify(line)}`);
    }

    // 12 rows in a 7-row body: a track with a thumb.
    const tight = { columns: 40, rows: 10 };
    const narrow = render(setSize(state, tight), tight).map(stripAnsi);
    const column = body(narrow, tight).map((l) => l[tight.columns - 1]).join("");
    assertEquals(column.length, 7);
    assert(column.includes("#"), `no thumb in ${JSON.stringify(column)}`);
    assert(column.includes("|"), `no track in ${JSON.stringify(column)}`);
    // The thumb is one contiguous run, and it starts at the top when unscrolled.
    assertEquals(/^#+\|+$/.test(column), true, column);

    // Scrolling to the end moves the thumb to the bottom.
    const scrolled = reduce(setSize(state, tight), key("end")).state;
    const atEnd = render(scrolled, tight).map(stripAnsi);
    const endColumn = body(atEnd, tight).map((l) => l[tight.columns - 1]).join("");
    assertEquals(/^\|+#+$/.test(endColumn), true, endColumn);
  });
});

Deno.test("render: too small terminals say so instead of drawing a broken frame", async () => {
  await withUi((state) => {
    const narrow = { columns: MIN_COLUMNS - 1, rows: 24 };
    const lines = render(state, narrow);
    assertEquals(lines.length, narrow.rows);
    assertEquals(lines[0], TOO_SMALL.slice(0, narrow.columns));
    assertStringIncludes(lines[0], "terminal too small");

    const short = render(state, { columns: 80, rows: 9 });
    assertEquals(short.length, 9);
    assertEquals(short[0], TOO_SMALL);
  });
});

Deno.test("render: NO_COLOR drops every escape and changes no text", async () => {
  const previous = Deno.env.get("NO_COLOR");
  try {
    Deno.env.set("NO_COLOR", "1");
    assertEquals(colorEnabled(false), false);
    Deno.env.delete("NO_COLOR");
    assertEquals(colorEnabled(false), true);
    assertEquals(colorEnabled(true), false, "--no-color wins on its own");
    Deno.env.set("NO_COLOR", "1");

    const size = { columns: 80, rows: 24 };
    await withUi((state) => {
      const sized = setSize(state, size);
      const colored = render(sized, size);
      const plain = render({ ...sized, color: colorEnabled(false) }, size);
      assertEquals(plain.some((l) => l.includes("\x1b[")), false, "escape in a NO_COLOR frame");
      assert(colored.some((l) => l.includes("\x1b[")), "coloured frame has no escapes at all");
      assertEquals(plain, colored.map(stripAnsi));
    });
  } finally {
    if (previous === undefined) Deno.env.delete("NO_COLOR");
    else Deno.env.set("NO_COLOR", previous);
  }
});
