// End-to-end CLI tests, in-process (so no --allow-run and no compile step). Every case
// builds its own root / workspace dir / skills dir under Deno.makeTempDir().

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@^1";
import { basename, join } from "jsr:@std/path@^1";
import type { Options } from "../cli.ts";
import { run } from "../main.ts";
import { fenceEntries } from "../model.ts";
import { parseJsonc } from "../jsonc_edit.ts";
import { capture, fixture, makeExampleRoot, withTemp, writeConfig } from "./helpers.ts";

interface Env {
  root: string;
  workspaceDir: string;
  skillsRoot: string;
  configPath: string;
  devcontainer: string;
  workspaceFile: string;
}

/** A temp world: example root, a workspace dir outside it, two skill dirs, a config file. */
async function setup(
  fn: (env: Env) => Promise<void>,
  opts: { devcontainer?: string | null; config?: Record<string, unknown> } = {},
): Promise<void> {
  await withTemp(async (tmp) => {
    const root = join(tmp, "root");
    const workspaceDir = join(tmp, "ws");
    const skillsRoot = join(tmp, "skills");
    await Deno.mkdir(root, { recursive: true });
    await makeExampleRoot(root);
    await Deno.mkdir(join(workspaceDir, ".devcontainer"), { recursive: true });
    await Deno.mkdir(join(skillsRoot, "alpha"), { recursive: true });
    await Deno.mkdir(join(skillsRoot, "beta"), { recursive: true });

    const devcontainer = join(workspaceDir, ".devcontainer", "devcontainer.json");
    const contents = opts.devcontainer === undefined
      ? await fixture("devcontainer_existing.jsonc")
      : opts.devcontainer;
    if (contents !== null) await Deno.writeTextFile(devcontainer, contents);

    const configPath = await writeConfig(tmp, {
      root,
      containerRoot: "/workspaces",
      maxDepth: 3,
      skillsRoot,
      skillsContainerRoot: "/home/vscode/.claude/skills",
      devcontainerPath: ".devcontainer/devcontainer.json",
      workspaceFile: null,
      ...opts.config,
    });

    await fn({
      root,
      workspaceDir,
      skillsRoot,
      configPath,
      devcontainer,
      workspaceFile: join(workspaceDir, "ws.code-workspace"),
    });
  });
}

/** Invoke devc with the env's workspace dir and config, capturing output. */
async function cli(env: Env, ...args: string[]) {
  const cap = capture();
  const code = await run(
    [...args, "--workspace-dir", env.workspaceDir, "--config", env.configPath, "--no-color"],
    cap.io,
  );
  return { code, stdout: cap.stdout(), stderr: cap.stderr() };
}

async function readOrNull(path: string): Promise<string | null> {
  try {
    return await Deno.readTextFile(path);
  } catch {
    return null;
  }
}

Deno.test("cli: select writes both files, apply is idempotent, deselect restores them", async () => {
  await setup(async (env) => {
    const before = await Deno.readTextFile(env.devcontainer);

    const sel = await cli(env, "select", "projectb.worktrees/some-other");
    assertEquals(sel.code, 0, sel.stderr);
    assertStringIncludes(sel.stdout, `wrote ${env.devcontainer}`);
    assertStringIncludes(sel.stdout, `wrote ${env.workspaceFile}`);

    const dev = await Deno.readTextFile(env.devcontainer);
    // Two entries in the projects fence: the worktree and its force-included primary.
    assertEquals(fenceEntries(dev, "mounts", "projects").length, 2);
    assertEquals(fenceEntries(dev, "mounts", "skills").length, 0);
    assertStringIncludes(dev, `,source=${join(env.root, "projectb")},target=/workspaces/projectb"`);
    assertStringIncludes(
      dev,
      `,source=${join(env.root, "projectb.worktrees", "some-other")},target=/workspaces/projectb.worktrees/some-other"`,
    );
    // The user's own mount, comments and unrelated keys are all still there.
    assertStringIncludes(dev, "    // my ssh agent, nothing to do with devc\n");
    assertStringIncludes(dev, '"type=bind,source=/run/host-services/ssh-auth.sock,target=/ssh-agent"');
    const parsed = parseJsonc(dev) as { mounts: string[]; remoteUser: string };
    assertEquals(parsed.mounts.length, 3);
    assertEquals(parsed.remoteUser, "vscode");

    const ws = await Deno.readTextFile(env.workspaceFile);
    assertEquals(fenceEntries(ws, "folders", "folders").length, 1);
    // Host paths, relative to the workspace file: VS Code opens this file on the host, and
    // the root sits next to the workspace dir (`<tmp>/root` vs `<tmp>/ws`).
    assertEquals((parseJsonc(ws) as { folders: unknown[] }).folders, [
      { path: "." },
      {
        path: "../root/projectb.worktrees/some-other",
        name: "projectb.worktrees/some-other",
      },
    ]);

    // Idempotence: applying the same derived state changes nothing at all.
    const again = await cli(env, "apply");
    assertEquals(again.code, 0, again.stderr);
    assertEquals(again.stdout.trim(), "no changes");
    assertEquals(await Deno.readTextFile(env.devcontainer), dev);
    assertEquals(await Deno.readTextFile(env.workspaceFile), ws);

    // `list` marks the auto-included primary `[~]` and the worktree `[x]`.
    const listed = await cli(env, "list");
    assertEquals(listed.code, 0, listed.stderr);
    const line = listed.stdout.split("\n").find((l) => l.includes("] projectb"))!;
    assertStringIncludes(line, "[~]");
    assertStringIncludes(
      listed.stdout.split("\n").find((l) => l.includes("some-other"))!,
      "[x]",
    );
    const listedJson = await cli(env, "list", "--json");
    const nodes = (JSON.parse(listedJson.stdout) as {
      nodes: Array<{ id: string; selected: boolean; auto: boolean }>;
    }).nodes;
    assertEquals(nodes.find((n) => n.id === "projectb")!.auto, true);
    assertEquals(nodes.find((n) => n.id === "projectb")!.selected, false);
    assertEquals(nodes.find((n) => n.id === "projectb.worktrees/some-other")!.selected, true);

    // Deselecting empties both fences and restores the devcontainer byte-for-byte.
    const desel = await cli(env, "deselect", "projectb.worktrees/some-other");
    assertEquals(desel.code, 0, desel.stderr);
    assertEquals(await Deno.readTextFile(env.devcontainer), before);
    const wsAfter = await Deno.readTextFile(env.workspaceFile);
    assertEquals(fenceEntries(wsAfter, "folders", "folders").length, 0);
    assertEquals((parseJsonc(wsAfter) as { folders: unknown[] }).folders, [{ path: "." }]);
  });
});

Deno.test("cli: skills enable touches only the skills fence", async () => {
  await setup(async (env) => {
    assertEquals((await cli(env, "select", "projecta")).code, 0);
    const beforeProjects = fenceEntries(
      await Deno.readTextFile(env.devcontainer),
      "mounts",
      "projects",
    );

    const enabled = await cli(env, "skills", "enable", "alpha");
    assertEquals(enabled.code, 0, enabled.stderr);
    const dev = await Deno.readTextFile(env.devcontainer);
    assertEquals(fenceEntries(dev, "mounts", "skills"), [
      `"type=bind,source=${join(env.skillsRoot, "alpha")},target=/home/vscode/.claude/skills/alpha"`,
    ]);
    assertEquals(fenceEntries(dev, "mounts", "projects"), beforeProjects);
    assertEquals((parseJsonc(dev) as { mounts: string[] }).mounts.length, 3);

    const list = await cli(env, "skills", "list");
    assertStringIncludes(list.stdout, "[x] alpha");
    assertStringIncludes(list.stdout, "[ ] beta");

    const disabled = await cli(env, "skills", "disable", "alpha");
    assertEquals(disabled.code, 0, disabled.stderr);
    assertEquals(
      fenceEntries(await Deno.readTextFile(env.devcontainer), "mounts", "skills").length,
      0,
    );

    const unknown = await cli(env, "skills", "enable", "nope");
    assertEquals(unknown.code, 2);
    assertStringIncludes(unknown.stderr, 'devc: unknown skill "nope"');
  });
});

Deno.test("cli: --dry-run prints a diff and writes nothing", async () => {
  await setup(async (env) => {
    const dev = await Deno.readTextFile(env.devcontainer);
    const res = await cli(env, "select", "projecta", "--dry-run");
    assertEquals(res.code, 0, res.stderr);
    assertStringIncludes(res.stdout, `--- a/${env.devcontainer}`);
    assertStringIncludes(res.stdout, `+++ b/${env.devcontainer}`);
    assertStringIncludes(res.stdout, "@@");
    assertStringIncludes(res.stdout, `+    "type=bind,source=${join(env.root, "projecta")},target=/workspaces/projecta"`);
    assertStringIncludes(res.stdout, `--- a/${env.workspaceFile}`);

    assertEquals(await Deno.readTextFile(env.devcontainer), dev);
    assertEquals(await readOrNull(env.workspaceFile), null);
  });
});

Deno.test("cli: unknown id exits 2 and writes nothing", async () => {
  await setup(async (env) => {
    const dev = await Deno.readTextFile(env.devcontainer);
    const res = await cli(env, "select", "nope");
    assertEquals(res.code, 2);
    assertStringIncludes(res.stderr, 'devc: unknown project id "nope"');
    assertEquals(await Deno.readTextFile(env.devcontainer), dev);
    assertEquals(await readOrNull(env.workspaceFile), null);

    // A node that exists but cannot be selected fails the same way (exit 2, no writes).
    const orphan = await cli(env, "select", "org");
    assertEquals(orphan.code, 2);
    assertEquals(await Deno.readTextFile(env.devcontainer), dev);
  });
});

Deno.test("cli: a missing devcontainer needs --create", async () => {
  await setup(async (env) => {
    const bare = await cli(env, "select", "projecta");
    assertEquals(bare.code, 1);
    assertStringIncludes(
      bare.stderr,
      `devc: ${env.devcontainer} does not exist (pass --create to create it)`,
    );
    assertEquals(await readOrNull(env.devcontainer), null);
    assertEquals(await readOrNull(env.workspaceFile), null);

    const created = await cli(env, "select", "projecta", "--create");
    assertEquals(created.code, 0, created.stderr);
    const dev = await Deno.readTextFile(env.devcontainer);
    assertEquals(fenceEntries(dev, "mounts", "projects").length, 1);
    const parsed = parseJsonc(dev) as { name: string; mounts: string[] };
    assertEquals(parsed.name, "ws");
    assertEquals(parsed.mounts.length, 1);
    assertEquals(fenceEntries(await Deno.readTextFile(env.workspaceFile), "folders", "folders").length, 1);
  }, { devcontainer: null });
});

Deno.test("cli: an unterminated fence is refused before anything is written", async () => {
  const broken = await fixture("mounts_unterminated.jsonc");
  await setup(async (env) => {
    const res = await cli(env, "select", "projecta");
    assertEquals(res.code, 1);
    assertStringIncludes(
      res.stderr,
      `devc: unterminated devc:projects fence in ${env.devcontainer}`,
    );
    assertEquals(await Deno.readTextFile(env.devcontainer), broken);
    assertEquals(await readOrNull(env.workspaceFile), null);
  }, { devcontainer: broken });
});

Deno.test("cli: two *.code-workspace files with workspaceFile unset exits 2", async () => {
  await setup(async (env) => {
    await Deno.writeTextFile(join(env.workspaceDir, "one.code-workspace"), "{}\n");
    await Deno.writeTextFile(join(env.workspaceDir, "two.code-workspace"), "{}\n");
    const res = await cli(env, "status");
    assertEquals(res.code, 2);
    assertStringIncludes(res.stderr, "*.code-workspace files");
    assertStringIncludes(res.stderr, "one.code-workspace, two.code-workspace");
    assertStringIncludes(res.stderr, '"workspaceFile"');

    // Naming one in the config resolves the ambiguity.
    await Deno.writeTextFile(
      env.configPath,
      JSON.stringify(
        { ...JSON.parse(await Deno.readTextFile(env.configPath)), workspaceFile: "two.code-workspace" },
        null,
        2,
      ),
    );
    const ok = await cli(env, "status");
    assertEquals(ok.code, 0, ok.stderr);
    assertStringIncludes(ok.stdout, join(env.workspaceDir, "two.code-workspace"));
  });
});

Deno.test("cli: status reports the resolved paths and fence counts", async () => {
  await setup(async (env) => {
    assertEquals((await cli(env, "select", "projecta")).code, 0);
    const text = await cli(env, "status");
    assertEquals(text.code, 0, text.stderr);
    assertStringIncludes(text.stdout, `root `);
    assertStringIncludes(text.stdout, env.root);
    assertStringIncludes(text.stdout, `${env.devcontainer} (exists)`);
    assertStringIncludes(text.stdout, `${env.workspaceFile} (exists)`);
    assertStringIncludes(text.stdout, "devc:projects");

    const json = await cli(env, "status", "--json");
    const parsed = JSON.parse(json.stdout) as {
      config: string;
      workspaceDir: string;
      devcontainer: { path: string; exists: boolean };
      workspaceFile: { path: string; exists: boolean };
      fences: { projects: number; skills: number; folders: number };
    };
    assertEquals(parsed.config, env.configPath);
    assertEquals(parsed.workspaceDir, env.workspaceDir);
    assertEquals(parsed.devcontainer, { path: env.devcontainer, exists: true });
    assertEquals(parsed.workspaceFile, { path: env.workspaceFile, exists: true });
    assertEquals(parsed.fences, { projects: 1, skills: 0, folders: 1 });
  });
});

Deno.test("cli: --json write output lists the changed files", async () => {
  await setup(async (env) => {
    const res = await cli(env, "select", "projecta", "--json");
    assertEquals(res.code, 0, res.stderr);
    assertEquals(JSON.parse(res.stdout), { changed: [env.devcontainer, env.workspaceFile] });
    const again = await cli(env, "apply", "--json");
    assertEquals(JSON.parse(again.stdout), { changed: [] });
  });
});

Deno.test("cli: root must be configured, and config subcommands work without it", async () => {
  await withTemp(async (tmp) => {
    const cfgPath = join(tmp, "config.json");
    const cap = capture();
    // No config file yet: it is created with defaults on first use.
    assertEquals(await run(["config", "path", "--config", cfgPath], cap.io), 0);
    assertEquals(cap.stdout().trim(), cfgPath);

    const init = capture();
    assertEquals(await run(["config", "init", "--config", cfgPath], init.io), 0);
    assertStringIncludes(init.stdout(), "created");
    const defaults = JSON.parse(await Deno.readTextFile(cfgPath)) as Record<string, unknown>;
    assertEquals(defaults.root, "");
    assertEquals(defaults.containerRoot, "/workspaces");
    assertEquals(defaults.workspaceFile, null);

    const show = capture();
    assertEquals(await run(["config", "show", "--config", cfgPath], show.io), 0);
    assertEquals(JSON.parse(show.stdout()).containerRoot, "/workspaces");

    const listed = capture();
    assertEquals(
      await run(["list", "--config", cfgPath, "--workspace-dir", tmp], listed.io),
      2,
    );
    assertStringIncludes(listed.stderr(), 'devc: config "root" is not set');

    // --root fills it in for one invocation.
    const withRoot = capture();
    assertEquals(
      await run(["list", "--config", cfgPath, "--workspace-dir", tmp, "--root", tmp], withRoot.io),
      0,
    );
  });
});

Deno.test("cli: unknown keys in the config survive a rewrite", async () => {
  await withTemp(async (tmp) => {
    const cfgPath = await writeConfig(tmp, { root: tmp, futureFlag: true });
    const cap = capture();
    assertEquals(await run(["config", "show", "--config", cfgPath], cap.io), 0);
    assertEquals((JSON.parse(cap.stdout()) as { futureFlag: boolean }).futureFlag, true);
  });
});

Deno.test("cli: no args opens the interactive tree; --help exits 0", async () => {
  // No subcommand is the TUI, not a usage error. The launcher is injected here; the real
  // non-TTY refusal is covered in tui_app_test.ts.
  const none = capture();
  const seen: Options[] = [];
  const code = await run(["--no-color"], none.io, {
    tui: (opts) => {
      seen.push(opts);
      return Promise.resolve(0);
    },
  });
  assertEquals(code, 0);
  assertEquals(seen.length, 1);
  assertEquals(seen[0].noColor, true);
  assertEquals(none.stderr(), "");

  const help = capture();
  assertEquals(await run(["--help"], help.io), 0);
  assertStringIncludes(help.stdout(), "usage: devc");

  const bad = capture();
  assertEquals(await run(["nope"], bad.io), 2);
  assertStringIncludes(bad.stderr(), 'devc: unknown command "nope"');

  const badFlag = capture();
  assertEquals(await run(["list", "--nope"], badFlag.io), 2);
  assertStringIncludes(badFlag.stderr(), 'devc: unknown option "--nope"');
});

Deno.test("cli: the workspace dir may be the configured root itself", async () => {
  await withTemp(async (tmp) => {
    await makeExampleRoot(tmp);
    const cfgPath = await writeConfig(tmp, { root: tmp, containerRoot: "/workspaces" });
    const cap = capture();
    const code = await run(
      ["select", "projecta", "--config", cfgPath, "--workspace-dir", tmp, "--create", "--json"],
      cap.io,
    );
    assertEquals(code, 0, cap.stderr());
    const dev = await Deno.readTextFile(join(tmp, ".devcontainer", "devcontainer.json"));
    assertEquals(fenceEntries(dev, "mounts", "projects").length, 1);
    // The workspace file is named after the dir, and `.` still stands for the root itself.
    const ws = await Deno.readTextFile(join(tmp, `${basename(tmp)}.code-workspace`));
    assertEquals((parseJsonc(ws) as { folders: unknown[] }).folders, [
      { path: "." },
      { path: "projecta", name: "projecta" },
    ]);
    assert(JSON.parse(cap.stdout()).changed.length === 2);
  });
});
