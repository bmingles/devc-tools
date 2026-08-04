// The project-config flow driven headlessly: a scripted key stream + fake `readDir`, asserting
// that `apply` receives the rows the pickers produced. No TTY (raw off).

import { assert, assertEquals } from "jsr:@std/assert@^1";
import {
  type FlowDeps,
  type ProjectFlowOptions,
  runProjectFlow,
} from "../tui/config_flow.ts";
import type { WizardSelection } from "../wizard_apply.ts";
import type { FsProbe } from "../worktree.ts";

const FS: Record<string, string[]> = {
  "/code": ["app", "lib"],
  "/skills": ["review", "writing"],
};
const fakeReadDir = (p: string) => Promise.resolve(FS[p] ?? []);

/** One chunk per key so a picker never over-reads keys meant for the next step. */
function streamOfKeys(keys: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const k of keys) c.enqueue(enc.encode(k));
      c.close();
    },
  });
}

function sink(): WritableStream<Uint8Array> {
  return new WritableStream({ write() {} });
}

function baseOpts(): ProjectFlowOptions {
  return {
    projectDir: "/proj",
    configPath: "/proj/.devcontainer/devcontainer.json",
    creating: true,
    sourceRows: [],
    skillsRows: [],
    codeRoots: ["/code"],
    skillsRoots: ["/skills"],
    color: false,
  };
}

const SPACE = " ";
const ENTER = "\r";
const DOWN = "\x1b[B";
const RIGHT = "\x1b[C";
const ESC = "\x1b";

Deno.test("project flow: pick one source + one skills folder, apply gets the rows", async () => {
  let captured: WizardSelection | null = null;
  const deps: FlowDeps = {
    // A single configured root opens inside itself — no → needed to enter it.
    // source: tick "app", Enter · skills: down to "writing", tick, Enter · confirm y
    input: streamOfKeys([SPACE, ENTER, DOWN, SPACE, ENTER, "y"]),
    output: sink(),
    size: () => ({ columns: 80, rows: 24 }),
    raw: false,
    readDir: fakeReadDir,
    apply: (_dir, sel) => {
      captured = sel;
      return Promise.resolve({
        created: true,
        configPath: "/proj/.devcontainer/devcontainer.json",
        written: [],
      });
    },
  };

  const result = await runProjectFlow(baseOpts(), deps);
  assertEquals(result.applied, true);
  assert(captured !== null);
  const sel = captured as unknown as WizardSelection;

  assertEquals(sel.source, [{
    source: "/code/app",
    target: "/workspaces/app",
    readonly: false,
  }]);
  assertEquals(sel.skills, [{
    source: "/skills/writing",
    target: "/home/vscode/.claude/skills/writing",
    readonly: true,
  }]);
});

Deno.test("project flow: declining the confirm applies nothing", async () => {
  let called = false;
  const deps: FlowDeps = {
    // single roots open inside · src: pick, done · skills: none, done · confirm n
    input: streamOfKeys([SPACE, ENTER, ENTER, "n"]),
    output: sink(),
    size: () => ({ columns: 80, rows: 24 }),
    raw: false,
    readDir: fakeReadDir,
    apply: () => {
      called = true;
      return Promise.resolve({ created: true, configPath: "x", written: [] });
    },
  };
  const result = await runProjectFlow(baseOpts(), deps);
  assertEquals(result.applied, false);
  assertEquals(called, false);
});

Deno.test("project flow: Esc in the source picker cancels the whole flow", async () => {
  let called = false;
  const deps: FlowDeps = {
    input: streamOfKeys([ESC]),
    output: sink(),
    size: () => ({ columns: 80, rows: 24 }),
    raw: false,
    readDir: fakeReadDir,
    apply: () => {
      called = true;
      return Promise.resolve({ created: true, configPath: "x", written: [] });
    },
  };
  const result = await runProjectFlow(baseOpts(), deps);
  assertEquals(result.applied, false);
  assertEquals(called, false);
});

// ── worktree-aware source mounts ────────────────────────────────────────────────

const WFS: Record<string, string[]> = {
  "/code": ["myproject", "myproject.worktrees"],
  "/code/myproject.worktrees": ["feature1", "feature2"],
  "/skills": [],
};
const wReadDir = (p: string) => Promise.resolve(WFS[p] ?? []);

/** A fake FsProbe backed by an explicit set of `.git` files. */
function fsProbe(files: Record<string, string>): FsProbe {
  return {
    statIsFile: (p) => Promise.resolve(p in files),
    readText: (p) => Promise.resolve(files[p] ?? null),
  };
}

/** Run the flow with the worktree FS and capture the applied selection. */
async function runWith(
  keys: string[],
  files: Record<string, string>,
): Promise<WizardSelection> {
  let captured: WizardSelection | null = null;
  const deps: FlowDeps = {
    input: streamOfKeys(keys),
    output: sink(),
    size: () => ({ columns: 80, rows: 24 }),
    raw: false,
    readDir: wReadDir,
    fsProbe: fsProbe(files),
    apply: (_dir, sel) => {
      captured = sel;
      return Promise.resolve({ created: true, configPath: "x", written: [] });
    },
  };
  const result = await runProjectFlow(baseOpts(), deps);
  assertEquals(result.applied, true);
  assert(captured !== null);
  return captured as unknown as WizardSelection;
}

Deno.test("worktree flow: source keeps its sub-path and mounts the primary .git", async () => {
  // start in /code, down to myproject.worktrees, open it, tick feature1, done · skills none · y
  const sel = await runWith(
    [DOWN, RIGHT, SPACE, ENTER, ENTER, "y"],
    {
      "/code/myproject.worktrees/feature1/.git":
        "gitdir: ../../myproject/.git/worktrees/feature1\n",
    },
  );
  assertEquals(sel.source, [
    {
      source: "/code/myproject.worktrees/feature1",
      target: "/workspaces/myproject.worktrees/feature1",
      readonly: false,
    },
    {
      source: "/code/myproject/.git",
      target: "/workspaces/myproject/.git",
      readonly: false,
    },
  ]);
});

Deno.test("worktree flow: an absolute-path worktree mounts the folder but not the primary", async () => {
  const sel = await runWith(
    [DOWN, RIGHT, SPACE, ENTER, ENTER, "y"],
    {
      "/code/myproject.worktrees/feature1/.git":
        "gitdir: /code/myproject/.git/worktrees/feature1\n",
    },
  );
  assertEquals(sel.source, [
    {
      source: "/code/myproject.worktrees/feature1",
      target: "/workspaces/myproject.worktrees/feature1",
      readonly: false,
    },
  ]);
});

Deno.test("worktree flow: two worktrees of one primary share a single .git mount", async () => {
  // start in /code, down, open worktrees, tick feature1, down, tick feature2, done · skills · y
  const sel = await runWith(
    [DOWN, RIGHT, SPACE, DOWN, SPACE, ENTER, ENTER, "y"],
    {
      "/code/myproject.worktrees/feature1/.git":
        "gitdir: ../../myproject/.git/worktrees/feature1\n",
      "/code/myproject.worktrees/feature2/.git":
        "gitdir: ../../myproject/.git/worktrees/feature2\n",
    },
  );
  const primaries = sel.source.filter((r) => r.target === "/workspaces/myproject/.git");
  assertEquals(primaries.length, 1);
  const targets = sel.source.map((r) => r.target).sort();
  assertEquals(targets, [
    "/workspaces/myproject.worktrees/feature1",
    "/workspaces/myproject.worktrees/feature2",
    "/workspaces/myproject/.git",
  ]);
});

Deno.test("worktree flow: picking the primary working tree too skips the redundant .git mount", async () => {
  // start in /code, tick myproject, down to worktrees, open, tick feature1, done · skills · y
  const sel = await runWith(
    [SPACE, DOWN, RIGHT, SPACE, ENTER, ENTER, "y"],
    {
      "/code/myproject.worktrees/feature1/.git":
        "gitdir: ../../myproject/.git/worktrees/feature1\n",
    },
  );
  assertEquals(sel.source.map((r) => r.target).sort(), [
    "/workspaces/myproject",
    "/workspaces/myproject.worktrees/feature1",
  ]);
});
