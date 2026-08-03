// End-to-end through `runApp` with the IO injected: a scripted key sequence in, frames and
// real files out, no TTY anywhere. The headline case proves the UI and the CLI share one write
// path by comparing the bytes they produce.

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@^1";
import { join } from "jsr:@std/path@^1";
import { capture, fixture, makeExampleRoot, repo, withTemp, writeConfig } from "./helpers.ts";
import { DEFAULT_OPTIONS, type Options } from "../cli.ts";
import { run } from "../main.ts";
import { NOT_A_TERMINAL, runApp, startTui } from "../tui/app.ts";
import { frame } from "../tui/term.ts";
import { fenceEntries } from "../model.ts";

interface Env {
  root: string;
  workspaceDir: string;
  skillsRoot: string;
  configPath: string;
  devcontainer: string;
  workspaceFile: string;
  original: string;
}

/** The same temp world cli_test builds: example root, workspace dir outside it, two skills. */
async function setup(fn: (env: Env) => Promise<void>): Promise<void> {
  await withTemp(async (tmp) => {
    const root = join(tmp, "root");
    const workspaceDir = join(tmp, "ws");
    const skillsRoot = join(tmp, "skills");
    await Deno.mkdir(root, { recursive: true });
    await makeExampleRoot(root);
    await Deno.mkdir(join(workspaceDir, ".devcontainer"), { recursive: true });
    await Deno.mkdir(join(skillsRoot, "alpha"), { recursive: true });
    await Deno.mkdir(join(skillsRoot, "beta"), { recursive: true });

    const original = await fixture("devcontainer_existing.jsonc");
    const devcontainer = join(workspaceDir, ".devcontainer", "devcontainer.json");
    await Deno.writeTextFile(devcontainer, original);

    const configPath = await writeConfig(tmp, {
      root,
      containerRoot: "/workspaces",
      maxDepth: 3,
      skillsRoot,
      skillsContainerRoot: "/home/vscode/.claude/skills",
      devcontainerPath: ".devcontainer/devcontainer.json",
      workspaceFile: null,
    });

    await fn({
      root,
      workspaceDir,
      skillsRoot,
      configPath,
      devcontainer,
      workspaceFile: join(workspaceDir, "ws.code-workspace"),
      original,
    });
  });
}

function options(env: Env): Options {
  return {
    ...DEFAULT_OPTIONS,
    workspaceDir: env.workspaceDir,
    config: env.configPath,
    noColor: true,
  };
}

/**
 * Feed the app one step at a time. A function step is a side effect performed *between*
 * keystrokes; `highWaterMark: 0` is what keeps that ordering exact.
 */
function scripted(steps: Array<string | (() => Promise<void>)>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (i < steps.length) {
        const step = steps[i++];
        if (typeof step === "string") {
          controller.enqueue(encoder.encode(step));
          return;
        }
        await step();
      }
      controller.close();
    },
  }, new CountQueuingStrategy({ highWaterMark: 0 }));
}

function collector(): { stream: WritableStream<Uint8Array>; text: () => string } {
  const parts: string[] = [];
  const decoder = new TextDecoder();
  const stream = new WritableStream<Uint8Array>({
    write(chunk) {
      parts.push(decoder.decode(chunk));
    },
  });
  return { stream, text: () => parts.join("") };
}

/** Run the TUI over `env` with a scripted key sequence. */
async function tui(env: Env, steps: Array<string | (() => Promise<void>)>) {
  const out = collector();
  const cap = capture();
  const code = await runApp({
    opts: options(env),
    io: cap.io,
    input: scripted(steps),
    output: out.stream,
    size: () => ({ columns: 80, rows: 24 }),
  });
  return { code, frames: out.text(), stderr: cap.stderr() };
}

const DOWN = "\x1b[B";
const SPACE = " ";
const CTRL_C = "\x03";

async function readOrNull(path: string): Promise<string | null> {
  try {
    return await Deno.readTextFile(path);
  } catch {
    return null;
  }
}

Deno.test("app: the UI writes exactly what the CLI writes", async () => {
  await setup(async (env) => {
    // The tree opens collapsed, so `down` from the first row (`org`) lands straight on
    // `projecta` without stepping through `org`'s contents; space checks it, `w` writes.
    const session = await tui(env, [DOWN, SPACE, "w", "q"]);
    assertEquals(session.code, 0, session.stderr);
    const uiDevcontainer = await Deno.readTextFile(env.devcontainer);
    const uiWorkspace = await Deno.readTextFile(env.workspaceFile);

    // The frames show the tree, the checked row and the result of the write.
    assertStringIncludes(session.frames, "PROJECTS");
    assertStringIncludes(session.frames, "[x] projecta");
    assertStringIncludes(
      session.frames,
      "wrote .devcontainer/devcontainer.json, ws.code-workspace",
    );

    // Same starting point, same selection, through the CLI this time.
    await Deno.writeTextFile(env.devcontainer, env.original);
    await Deno.remove(env.workspaceFile);
    const cap = capture();
    const code = await run(
      ["select", "projecta", "--workspace-dir", env.workspaceDir, "--config", env.configPath],
      cap.io,
    );
    assertEquals(code, 0, cap.stderr());

    assertEquals(uiDevcontainer, await Deno.readTextFile(env.devcontainer));
    assertEquals(uiWorkspace, await Deno.readTextFile(env.workspaceFile));
    assertEquals(fenceEntries(uiDevcontainer, "mounts", "projects").length, 1);
    assertEquals(fenceEntries(uiWorkspace, "folders", "folders").length, 1);
  });
});

Deno.test("app: writing twice is a no-op, and skills go through the same path", async () => {
  await setup(async (env) => {
    // Tab jumps to the skills section; space enables `alpha`.
    const session = await tui(env, ["\t", SPACE, "w", "w", "q"]);
    assertEquals(session.code, 0, session.stderr);
    const dev = await Deno.readTextFile(env.devcontainer);
    assertEquals(fenceEntries(dev, "mounts", "skills"), [
      `"type=bind,source=${join(env.skillsRoot, "alpha")},target=/home/vscode/.claude/skills/alpha"`,
    ]);
    assertEquals(fenceEntries(dev, "mounts", "projects").length, 0);
    // The second `w` had nothing left to do — the baseline moved with the first one.
    assertStringIncludes(session.frames, "no changes");
    assert(!session.frames.trimEnd().endsWith("*unsaved"));
  });
});

Deno.test("app: Ctrl-C after a toggle writes nothing at all", async () => {
  await setup(async (env) => {
    const session = await tui(env, [DOWN, SPACE, CTRL_C]);
    assertEquals(session.code, 0, session.stderr);
    assertStringIncludes(session.frames, "*unsaved");
    assertEquals(await Deno.readTextFile(env.devcontainer), env.original);
    assertEquals(await readOrNull(env.workspaceFile), null);
  });
});

Deno.test("app: quitting dirty and answering y saves on the way out", async () => {
  await setup(async (env) => {
    const session = await tui(env, [DOWN, SPACE, "q", "y"]);
    assertEquals(session.code, 0, session.stderr);
    assertStringIncludes(session.frames, "save before quitting? [y/n/c]");
    assertEquals(fenceEntries(await Deno.readTextFile(env.devcontainer), "mounts", "projects").length, 1);

    // ... and answering n does not.
    await Deno.writeTextFile(env.devcontainer, env.original);
    await Deno.remove(env.workspaceFile);
    const discarded = await tui(env, [DOWN, SPACE, "q", "n"]);
    assertEquals(discarded.code, 0, discarded.stderr);
    assertEquals(await Deno.readTextFile(env.devcontainer), env.original);
    assertEquals(await readOrNull(env.workspaceFile), null);
  });
});

Deno.test("app: r rescans and keeps the selection by id", async () => {
  await setup(async (env) => {
    const session = await tui(env, [
      DOWN,
      SPACE, // projecta selected
      async () => await repo(join(env.root, "zeta")),
      "r",
      "w",
      "q",
    ]);
    assertEquals(session.code, 0, session.stderr);
    // The new project shows up, and the earlier pick survived the rescan.
    assertStringIncludes(session.frames, "[ ] zeta");
    assertStringIncludes(session.frames, "[x] projecta");
    const dev = await Deno.readTextFile(env.devcontainer);
    assertEquals(fenceEntries(dev, "mounts", "projects").length, 1);
    assertStringIncludes(dev, `,target=/workspaces/projecta"`);
  });
});

Deno.test("app: a missing devcontainer asks before creating it", async () => {
  await setup(async (env) => {
    await Deno.remove(env.devcontainer);
    // `w` opens the prompt; anything but `y` cancels.
    const cancelled = await tui(env, [DOWN, SPACE, "w", "n"]);
    assertEquals(cancelled.code, 0, cancelled.stderr);
    assertStringIncludes(cancelled.frames, "create .devcontainer/devcontainer.json? [y/n]");
    assertStringIncludes(cancelled.frames, "cancelled");
    assertEquals(await readOrNull(env.devcontainer), null);

    const created = await tui(env, [DOWN, SPACE, "w", "y", "q"]);
    assertEquals(created.code, 0, created.stderr);
    const dev = await Deno.readTextFile(env.devcontainer);
    assertEquals(fenceEntries(dev, "mounts", "projects").length, 1);
    assertStringIncludes(dev, "Created by devc");
  });
});

Deno.test("app: a filter plus a drives a bulk selection", async () => {
  await setup(async (env) => {
    const session = await tui(env, ["/", "some", "\r", "a", "w", "q"]);
    assertEquals(session.code, 0, session.stderr);
    assertStringIncludes(session.frames, "filter: some");
    const ws = await Deno.readTextFile(env.workspaceFile);
    assertEquals(fenceEntries(ws, "folders", "folders").length, 2);
    // Both worktrees, and their two primaries pulled in as auto mounts.
    assertEquals(fenceEntries(await Deno.readTextFile(env.devcontainer), "mounts", "projects").length, 4);
  });
});

Deno.test("term: a frame homes the cursor and clears every line it writes", () => {
  assertEquals(frame(["a", "b"]), "\x1b[Ha\x1b[K\r\nb\x1b[K");
});

Deno.test("app: every keystroke paints one full frame", async () => {
  await setup(async (env) => {
    const session = await tui(env, [DOWN, DOWN, "q"]);
    assertEquals(session.code, 0, session.stderr);
    // One frame at startup plus one per key, each homing the cursor first. `q` quits without
    // painting again — there is nothing left to look at.
    assertEquals(session.frames.split("\x1b[H").length - 1, 3);
    // Nothing entered the alternate screen: `raw` is off, so this is safe in a test runner.
    assert(!session.frames.includes("\x1b[?1049h"));
  });
});

Deno.test("app: without a terminal the TUI refuses and points at the CLI", async () => {
  await setup(async (env) => {
    const cap = capture();
    assertEquals(await startTui(options(env), cap.io, { isTerminal: () => false }), 2);
    assertEquals(cap.stderr().trim(), NOT_A_TERMINAL);
    assertStringIncludes(cap.stderr(), "not a terminal");
    assertEquals(cap.stdout(), "");
    assertEquals(await readOrNull(env.workspaceFile), null);
  });
});
