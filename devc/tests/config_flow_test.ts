// The project-config flow driven headlessly: a scripted key stream + fake `readDir`, asserting
// that `apply` receives the rows the pickers produced. No TTY (raw off).

import { assert, assertEquals } from "jsr:@std/assert@^1";
import {
  type FlowDeps,
  type ProjectFlowOptions,
  runProjectFlow,
} from "../tui/config_flow.ts";
import type { WizardSelection } from "../wizard_apply.ts";

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
    // bounded pickers open on the roots list — open the root (→) before picking.
    // source: open /code, tick "app", Enter · skills: open /skills, down to "writing", tick, Enter · confirm y
    input: streamOfKeys([RIGHT, SPACE, ENTER, RIGHT, DOWN, SPACE, ENTER, "y"]),
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
    // src: open root, pick, done · skills: open root, none, done · confirm n
    input: streamOfKeys([RIGHT, SPACE, ENTER, RIGHT, ENTER, "n"]),
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
