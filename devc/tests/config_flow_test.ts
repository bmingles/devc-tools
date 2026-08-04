// The project-config flow driven headlessly: a scripted key stream + fake `readDir`, asserting
// that `apply` receives the rows the pickers produced. No TTY (raw off).

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@^1";
import {
  type FlowDeps,
  type FlowResult,
  type ProjectFlowOptions,
  runProjectFlow,
} from "../tui/config_flow.ts";
import type { WizardSelection } from "../wizard_apply.ts";
import type { FsProbe } from "../worktree.ts";
import type { ContainerStatus } from "../container.ts";

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
        changed: true,
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
      return Promise.resolve({
        created: true,
        changed: true,
        configPath: "x",
        written: [],
      });
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
      return Promise.resolve({
        created: true,
        changed: true,
        configPath: "x",
        written: [],
      });
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
      return Promise.resolve({
        created: true,
        changed: true,
        configPath: "x",
        written: [],
      });
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

// ── post-apply rebuild prompt ───────────────────────────────────────────────────

/** Capture every line the flow writes, so the prompts/notices can be asserted. */
function capturingSink(out: string[]): WritableStream<Uint8Array> {
  const dec = new TextDecoder();
  return new WritableStream({
    write(chunk) {
      out.push(dec.decode(chunk));
    },
  });
}

interface RebuildRun {
  result: FlowResult;
  text: string;
  rebuiltDirs: string[];
}

/**
 * Run the flow with a stub apply reporting `changed`, a stub container status, and a stub
 * rebuild — the minimal pick-one-source path plus whatever keys the prompt needs.
 */
async function runRebuild(
  changed: boolean,
  status: ContainerStatus,
  extraKeys: string[],
  opts: { failRebuild?: boolean } = {},
): Promise<RebuildRun> {
  const chunks: string[] = [];
  const rebuiltDirs: string[] = [];
  const deps: FlowDeps = {
    // src: tick "app", done · skills: none, done · confirm apply y · then extraKeys
    input: streamOfKeys([SPACE, ENTER, ENTER, "y", ...extraKeys]),
    output: capturingSink(chunks),
    size: () => ({ columns: 80, rows: 24 }),
    raw: false,
    readDir: fakeReadDir,
    err: (m) => chunks.push(m + "\n"),
    apply: () =>
      Promise.resolve({
        created: false,
        changed,
        configPath: "/proj/.devcontainer/devcontainer.json",
        written: [],
      }),
    containerStatus: () => Promise.resolve(status),
    rebuild: (dir) => {
      rebuiltDirs.push(dir);
      if (opts.failRebuild) return Promise.reject(new Error("build blew up"));
      return Promise.resolve("abc123 running — workspace /workspaces/proj");
    },
  };
  const result = await runProjectFlow(baseOpts(), deps);
  return { result, text: chunks.join(""), rebuiltDirs };
}

Deno.test("rebuild prompt: a changed config with an existing container offers a rebuild", async () => {
  const { result, text, rebuiltDirs } = await runRebuild(true, "running", ["y"]);
  assertEquals(result.applied, true);
  assertEquals(result.changed, true);
  assertEquals(result.rebuilt, true);
  assertStringIncludes(text, "must be rebuilt");
  assertStringIncludes(text, "Rebuild now?");
  assertEquals(rebuiltDirs, ["/proj"]);
  assertStringIncludes(text, "abc123 running");
});

Deno.test("rebuild prompt: declining leaves the container alone", async () => {
  const { result, text, rebuiltDirs } = await runRebuild(true, "stopped", ["n"]);
  assertEquals(result.changed, true);
  assertEquals(result.rebuilt, false);
  assertEquals(rebuiltDirs, []);
  assertStringIncludes(text, "Skipped — run `devc build` when you're ready.");
});

Deno.test("rebuild prompt: an unchanged config never prompts and never rebuilds", async () => {
  // No prompt keys supplied: if the flow asked anything, it would read past the stream's end.
  const { result, text, rebuiltDirs } = await runRebuild(false, "running", []);
  assertEquals(result.applied, true);
  assertEquals(result.changed, false);
  assertEquals(result.rebuilt, false);
  assertEquals(rebuiltDirs, []);
  assertStringIncludes(text, "No config changes — no rebuild needed.");
  assert(!text.includes("Rebuild now?"), "must not offer a rebuild");
  assertStringIncludes(text, "Unchanged /proj/.devcontainer/devcontainer.json");
});

Deno.test("rebuild prompt: no container yet is worded as a first build", async () => {
  const { result, text, rebuiltDirs } = await runRebuild(true, "missing", ["y"]);
  assertStringIncludes(text, "No dev container exists for this project yet.");
  assertStringIncludes(text, "Build it now?");
  assertEquals(rebuiltDirs, ["/proj"]);
  assertEquals(result.rebuilt, true);
});

Deno.test("rebuild prompt: a failed rebuild is reported, not thrown", async () => {
  const { result, text } = await runRebuild(true, "running", ["y"], {
    failRebuild: true,
  });
  assertEquals(result.applied, true);
  assertEquals(result.rebuilt, false);
  assertStringIncludes(text, "devc: build blew up");
});

Deno.test("rebuild prompt: without the deps the flow only points at `devc build`", async () => {
  const chunks: string[] = [];
  const deps: FlowDeps = {
    input: streamOfKeys([SPACE, ENTER, ENTER, "y"]),
    output: capturingSink(chunks),
    size: () => ({ columns: 80, rows: 24 }),
    raw: false,
    readDir: fakeReadDir,
    apply: () =>
      Promise.resolve({
        created: false,
        changed: true,
        configPath: "/proj/.devcontainer/devcontainer.json",
        written: [],
      }),
  };
  const result = await runProjectFlow(baseOpts(), deps);
  assertEquals(result.rebuilt, false);
  assertStringIncludes(chunks.join(""), "run `devc build` to rebuild");
});

Deno.test("rebuild prompt: a failed status lookup falls back to the `devc build` hint", async () => {
  const chunks: string[] = [];
  let rebuildCalled = false;
  const deps: FlowDeps = {
    input: streamOfKeys([SPACE, ENTER, ENTER, "y"]),
    output: capturingSink(chunks),
    size: () => ({ columns: 80, rows: 24 }),
    raw: false,
    readDir: fakeReadDir,
    apply: () =>
      Promise.resolve({
        created: false,
        changed: true,
        configPath: "/proj/.devcontainer/devcontainer.json",
        written: [],
      }),
    // e.g. no docker on PATH.
    containerStatus: () => Promise.reject(new Error("docker not found")),
    rebuild: () => {
      rebuildCalled = true;
      return Promise.resolve("never");
    },
  };
  const result = await runProjectFlow(baseOpts(), deps);
  assertEquals(result.rebuilt, false);
  assertEquals(rebuildCalled, false);
  assertStringIncludes(chunks.join(""), "run `devc build` to rebuild");
});
