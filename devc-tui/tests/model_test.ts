// Derivation tests: the worktree closure, the target mapping that keeps a relative gitdir
// resolvable, read-back, and the two ways the workspace dir interacts with the scan.

import { assert, assertEquals } from "jsr:@std/assert@^1";
import { join, relative } from "jsr:@std/path@^1";
import { type Config, DEFAULT_CONFIG } from "../config.ts";
import { nodeIndex, scanRoot } from "../scan.ts";
import {
  derive,
  deriveFolders,
  deriveMounts,
  folderLines,
  mountLines,
  mountSourceFor,
  readSelection,
  readSkills,
  skillMountLines,
  targetFor,
} from "../model.ts";
import { applyDevcontainer } from "../devcontainer.ts";
import { applyWorkspace, WORKSPACE_TEMPLATE } from "../workspace.ts";
import { makeExampleRoot, withTemp } from "./helpers.ts";

function config(root: string, over: Partial<Config> = {}): Config {
  return { ...DEFAULT_CONFIG, root, ...over };
}

Deno.test("model: selecting a worktree force-includes its primary as an auto mount", async () => {
  await withTemp(async (root) => {
    await makeExampleRoot(root);
    const tree = await scanRoot(root, 3, { workspaceDir: root });
    const cfg = config(root);
    const selection = new Set(["projectb.worktrees/some-other"]);

    const mounts = deriveMounts(tree, selection, cfg);
    assertEquals(mounts.map((m) => [m.id, m.auto]), [
      ["projectb", true],
      ["projectb.worktrees/some-other", false],
    ]);
    assertEquals(mounts[0].source, join(root, "projectb"));
    assertEquals(mounts[0].target, "/workspaces/projectb");

    // The workspace only ever lists explicit picks — never the auto primary.
    assertEquals(deriveFolders(tree, selection, cfg).map((f) => f.name), [
      "projectb.worktrees/some-other",
    ]);

    assertEquals(mountLines(mounts), [
      `"type=bind,source=${join(root, "projectb")},target=/workspaces/projectb"`,
      `"type=bind,source=${
        join(root, "projectb.worktrees", "some-other")
      },target=/workspaces/projectb.worktrees/some-other"`,
    ]);
    // Folder paths are host paths relative to the workspace file — here the workspace dir is
    // the root itself, so the path is just the id. The mount above keeps the container target.
    assertEquals(folderLines(deriveFolders(tree, selection, cfg)), [
      '{ "path": "projectb.worktrees/some-other", "name": "projectb.worktrees/some-other" }',
    ]);
  });
});

Deno.test("model: targets preserve the host-relative offset a relative gitdir needs", async () => {
  await withTemp(async (root) => {
    await makeExampleRoot(root);
    const cfg = config(root);
    const primary = targetFor(cfg, "projecta");
    const wt = targetFor(cfg, "projecta.worktrees/some-feature");
    assertEquals(primary, "/workspaces/projecta");
    assertEquals(wt, "/workspaces/projecta.worktrees/some-feature");

    // `gitdir: ../../projecta/...` resolves the same way on the host and in the container.
    assertEquals(relative(wt, primary), "../../projecta");
    assertEquals(
      relative(join(root, "projecta.worktrees", "some-feature"), join(root, "projecta")),
      "../../projecta",
    );
  });
});

Deno.test("model: deriveFolders round-trips through readSelection", async () => {
  await withTemp(async (root) => {
    await makeExampleRoot(root);
    const tree = await scanRoot(root, 3, { workspaceDir: root });
    const cfg = config(root);
    const selection = new Set([
      "projecta",
      "org/tools",
      "projectb.worktrees/some-other",
    ]);
    const src = applyWorkspace(
      WORKSPACE_TEMPLATE,
      folderLines(deriveFolders(tree, selection, cfg)),
      "ws",
    );
    const read = readSelection(null, src, tree, cfg);
    assertEquals([...read.selection].sort(), [...selection].sort());
    assertEquals(read.warnings, []);

    // A host path landing outside root is dropped with a warning — that is how a folder the
    // user added by hand, pointing somewhere else entirely, is left alone.
    const stale = applyWorkspace(
      WORKSPACE_TEMPLATE,
      ['{ "path": "../../elsewhere/gone", "name": "gone" }'],
      "ws",
    );
    const staleRead = readSelection(null, stale, tree, cfg);
    assertEquals([...staleRead.selection], []);
    assertEquals(staleRead.warnings.length, 1);
  });
});

Deno.test("model: workspace folders are host paths relative to the workspace file", async () => {
  await withTemp(async (tmp) => {
    const root = join(tmp, "root");
    await Deno.mkdir(root, { recursive: true });
    await makeExampleRoot(root);
    const selection = new Set(["projecta"]);

    // The three shapes of workspace dir, and where each puts the same project.
    const cases: Array<{ what: string; workspaceDir: string; cfg: Config; expected: string }> = [
      {
        what: "beside root",
        workspaceDir: join(tmp, "ws"),
        cfg: config(root),
        expected: "../root/projecta",
      },
      {
        what: "inside root",
        workspaceDir: join(root, "here"),
        cfg: config(root),
        expected: "../projecta",
      },
      {
        what: "workspace file in a subdirectory",
        workspaceDir: join(tmp, "ws"),
        cfg: config(root, { workspaceFile: "sub/ws.code-workspace" }),
        expected: "../../root/projecta",
      },
    ];

    for (const c of cases) {
      await Deno.mkdir(c.workspaceDir, { recursive: true });
      const tree = await scanRoot(root, 3, { workspaceDir: c.workspaceDir });
      const folders = deriveFolders(tree, selection, c.cfg);
      assertEquals(folders.map((f) => f.path), [c.expected], c.what);
      // The name stays the id — the thing the CLI and the fences round-trip on.
      assertEquals(folders.map((f) => f.name), ["projecta"], c.what);

      // And it reads straight back to the id it was written from.
      const src = applyWorkspace(WORKSPACE_TEMPLATE, folderLines(folders), "ws");
      const read = readSelection(null, src, tree, c.cfg);
      assertEquals([...read.selection], ["projecta"], c.what);
      assertEquals(read.warnings, [], c.what);
    }
  });
});

Deno.test("model: mount sources under home are written as ${localEnv:HOME}", async () => {
  await withTemp(async (home) => {
    const root = join(home, "src");
    await Deno.mkdir(root, { recursive: true });
    await makeExampleRoot(root);
    const previous = Deno.env.get("HOME");
    try {
      Deno.env.set("HOME", home);
      const tree = await scanRoot(root, 3, { workspaceDir: join(home, "ws") });
      const cfg = config(root);
      const selection = new Set(["projecta"]);

      // The emitted line is substituted...
      assertEquals(mountLines(deriveMounts(tree, selection, cfg)), [
        '"type=bind,source=${localEnv:HOME}/src/projecta,target=/workspaces/projecta"',
      ]);
      // ...while the derived mount keeps the real path, so warnings and `list` stay usable.
      assertEquals(deriveMounts(tree, selection, cfg)[0].source, join(root, "projecta"));

      // Skills mounts get the same treatment, and read back to the plain skill name.
      const skills = [{ name: "alpha", path: join(home, ".claude", "skills", "alpha") }];
      const lines = skillMountLines(cfg, skills);
      assertEquals(lines, [
        '"type=bind,source=${localEnv:HOME}/.claude/skills/alpha,target=/home/vscode/.claude/skills/alpha"',
      ]);
      assertEquals([...readSkills(applyDevcontainer("{}\n", [], lines, "dc.json"))], ["alpha"]);

      // A path outside home stays absolute.
      assertEquals(mountSourceFor("/opt/elsewhere/projecta"), "/opt/elsewhere/projecta");
      // Home itself, with and without a trailing slash on HOME.
      assertEquals(mountSourceFor(home), "${localEnv:HOME}");
      Deno.env.set("HOME", home + "/");
      assertEquals(mountSourceFor(join(home, "src")), "${localEnv:HOME}/src");
      // A path that merely starts with the same characters is not "under" home.
      assertEquals(mountSourceFor(home + "-other/x"), home + "-other/x");
    } finally {
      if (previous === undefined) Deno.env.delete("HOME");
      else Deno.env.set("HOME", previous);
    }
  });
});

Deno.test("model: with HOME unset, mount sources stay absolute", async () => {
  const previous = Deno.env.get("HOME");
  try {
    Deno.env.delete("HOME");
    assertEquals(mountSourceFor("/home/x/src/projecta"), "/home/x/src/projecta");
    Deno.env.set("HOME", "");
    assertEquals(mountSourceFor("/home/x/src/projecta"), "/home/x/src/projecta");
  } finally {
    if (previous === undefined) Deno.env.delete("HOME");
    else Deno.env.set("HOME", previous);
  }
});

Deno.test("model: with no folders fence, the projects fence is the selection", async () => {
  await withTemp(async (root) => {
    await makeExampleRoot(root);
    const tree = await scanRoot(root, 3, { workspaceDir: root });
    const cfg = config(root);
    const selection = new Set(["projectb.worktrees/some-other"]);
    const dev = [
      "{",
      '  "mounts": [',
      "    // >>> devc-tui:projects (managed - do not edit)",
      ...mountLines(deriveMounts(tree, selection, cfg)).map((l) => `    ${l}`),
      "    // <<< devc-tui:projects",
      "  ]",
      "}",
    ].join("\n");
    // Every project entry counts as explicit, including the auto-added primary — that is
    // the documented fallback, and it keeps a devcontainer-only setup from losing mounts.
    const read = readSelection(dev, null, tree, cfg);
    assertEquals([...read.selection].sort(), ["projectb", "projectb.worktrees/some-other"]);
  });
});

Deno.test("model: skills selection comes back from the skills fence", async () => {
  await withTemp(async (root) => {
    await makeExampleRoot(root);
    const tree = await scanRoot(root, 3, { workspaceDir: root });
    const cfg = config(root, { skillsRoot: "/host/skills" });
    const dev = [
      "{",
      '  "mounts": [',
      "    // >>> devc-tui:skills (managed - do not edit)",
      '    "type=bind,source=/host/skills/alpha,target=/home/vscode/.claude/skills/alpha",',
      '    "type=bind,source=/host/skills/beta,target=/home/vscode/.claude/skills/beta"',
      "    // <<< devc-tui:skills",
      "  ]",
      "}",
    ].join("\n");
    assertEquals([...readSelection(dev, null, tree, cfg).skills].sort(), ["alpha", "beta"]);
  });
});

Deno.test("model: workspace dir inside root is flagged and never selected", async () => {
  await withTemp(async (root) => {
    await makeExampleRoot(root);
    const workspaceDir = join(root, "projecta");
    const tree = await scanRoot(root, 3, { workspaceDir });
    const index = nodeIndex(tree);

    const node = index.get("projecta")!;
    assertEquals(node.isWorkspace, true);
    assertEquals(node.selectable, false);
    // Its worktree is unaffected.
    assertEquals(index.get("projecta.worktrees/some-feature")!.selectable, true);

    // With the default containerRoot the primary's target *is* the workspace mount, so the
    // closure's auto mount is dropped as a collision — the worktree's relative gitdir
    // resolves against the devcontainer's own /workspaces/projecta mount anyway.
    const selection = new Set(["projecta.worktrees/some-feature"]);
    const derived = derive(tree, selection, config(root));
    assertEquals(derived.mounts.map((m) => m.id), ["projecta.worktrees/some-feature"]);
    assertEquals(derived.folders.map((f) => f.name), ["projecta.worktrees/some-feature"]);
    assertEquals(derived.warnings.length, 1);
    assert(derived.warnings[0].includes("collides with the workspace mount"));

    // Move containerRoot elsewhere and the primary must be mounted explicitly, since
    // nothing else puts it at the right offset from the worktree.
    const moved = derive(tree, selection, config(root, { containerRoot: "/mnt/src" }));
    assertEquals(moved.mounts.map((m) => [m.id, m.auto]), [
      ["projecta", true],
      ["projecta.worktrees/some-feature", false],
    ]);
    assertEquals(moved.folders.map((f) => f.name), ["projecta.worktrees/some-feature"]);
    assertEquals(moved.warnings, []);
    assertEquals(
      relative("/mnt/src/projecta.worktrees/some-feature", "/mnt/src/projecta"),
      "../../projecta",
    );
  });
});

Deno.test("model: workspace dir outside root leaves every project selectable", async () => {
  await withTemp(async (root) => {
    await makeExampleRoot(root);
    await withTemp(async (elsewhere) => {
      const tree = await scanRoot(root, 3, { workspaceDir: elsewhere });
      assertEquals([...nodeIndex(tree).values()].filter((n) => n.isWorkspace), []);
      for (const node of nodeIndex(tree).values()) assertEquals(node.selectable, true);

      const selection = new Set(["projecta", "projectb"]);
      const derived = derive(tree, selection, config(root));
      assertEquals(derived.mounts.map((m) => m.id), ["projecta", "projectb"]);
      assertEquals(derived.folders.map((f) => f.name), ["projecta", "projectb"]);
      assertEquals(derived.warnings, []);
    });
  });
});

Deno.test("model: a scanned project colliding with the workspace mount is skipped", async () => {
  await withTemp(async (root) => {
    await makeExampleRoot(root);
    await withTemp(async (elsewhere) => {
      // Workspace dir *outside* root but sharing a basename with a scanned project.
      const workspaceDir = join(elsewhere, "projecta");
      await Deno.mkdir(workspaceDir, { recursive: true });
      const tree = await scanRoot(root, 3, { workspaceDir });
      assertEquals(nodeIndex(tree).get("projecta")!.isWorkspace, false);

      const selection = new Set(["projecta", "projectb"]);
      const derived = derive(tree, selection, config(root));
      assertEquals(derived.mounts.map((m) => m.id), ["projectb"]);
      assertEquals(derived.folders.map((f) => f.name), ["projectb"]);
      assertEquals(derived.warnings.length, 1);
      assert(
        derived.warnings[0].includes(
          'target /workspaces/projecta collides with the workspace mount; set "containerRoot" to something other than /workspaces',
        ),
        derived.warnings[0],
      );

      // A different containerRoot removes the collision entirely.
      const moved = derive(tree, selection, config(root, { containerRoot: "/mnt/src" }));
      assertEquals(moved.mounts.map((m) => m.target), ["/mnt/src/projecta", "/mnt/src/projectb"]);
      assertEquals(moved.warnings, []);
    });
  });
});
