// Scan tests. Each one builds its own throwaway root under Deno.makeTempDir().

import { assert, assertEquals } from "jsr:@std/assert@^1";
import { join } from "jsr:@std/path@^1";
import { flatten, MISSING_PRIMARY_WARNING, nodeIndex, scanRoot } from "../scan.ts";
import { makeExampleRoot, repo, withTemp, worktree } from "./helpers.ts";

Deno.test("scan: the example layout yields exactly the expected ids", async () => {
  await withTemp(async (root) => {
    await makeExampleRoot(root);
    const tree = await scanRoot(root, 3, { workspaceDir: root });
    const nodes = flatten(tree.nodes);

    assertEquals(nodes.map((n) => n.id), [
      "org",
      "org/tools",
      "projecta",
      "projecta.worktrees",
      "projecta.worktrees/some-feature",
      "projectb",
      "projectb.worktrees",
      "projectb.worktrees/some-other",
      "projectb.worktrees/yet-another",
    ]);

    // `noise/` is pruned: no project or worktree beneath it.
    assert(!nodes.some((n) => n.id === "noise"));

    // The tree mirrors the filesystem: a project is a leaf, and its worktree directory is a
    // sibling group — not a child. `primaryId` is what still ties the two together.
    const projecta = tree.nodes.find((n) => n.id === "projecta")!;
    assertEquals(projecta.kind, "project");
    assertEquals(projecta.children, []);

    const groupa = tree.nodes.find((n) => n.id === "projecta.worktrees")!;
    assertEquals(groupa.kind, "group");
    assertEquals(groupa.name, "projecta.worktrees");
    assertEquals(groupa.selectable, false);
    assertEquals(groupa.warnings, []);
    assertEquals(groupa.children.map((c) => c.id), ["projecta.worktrees/some-feature"]);
    assertEquals(groupa.children[0].kind, "worktree");
    assertEquals(groupa.children[0].primaryId, "projecta");
    assertEquals(groupa.children[0].selectable, true);

    // Depth is filesystem nesting: siblings on disk are siblings here.
    assertEquals(projecta.depth, 0);
    assertEquals(groupa.depth, 0);
    assertEquals(groupa.children[0].depth, 1);

    const groupb = tree.nodes.find((n) => n.id === "projectb.worktrees")!;
    assertEquals(groupb.children.map((c) => c.id), [
      "projectb.worktrees/some-other",
      "projectb.worktrees/yet-another",
    ]);

    // `org` is a non-selectable group holding a project at depth 2.
    const org = tree.nodes.find((n) => n.id === "org")!;
    assertEquals(org.kind, "group");
    assertEquals(org.selectable, false);
    assertEquals(org.children.map((c) => c.id), ["org/tools"]);
    assertEquals(org.children[0].kind, "project");
    assertEquals(org.children[0].selectable, true);

    // Ids index only selectable-kind nodes (groups are not addressable).
    assertEquals([...nodeIndex(tree).keys()].includes("org"), false);
  });
});

Deno.test("scan: maxDepth stops the descent", async () => {
  await withTemp(async (root) => {
    await makeExampleRoot(root);
    const shallow = await scanRoot(root, 1, { workspaceDir: root });
    assertEquals(flatten(shallow.nodes).map((n) => n.id).includes("org/tools"), false);
  });
});

Deno.test("scan: orphan worktrees are not selectable and say why", async () => {
  await withTemp(async (root) => {
    await repo(join(root, "projecta"));
    await worktree(join(root, "orphan.worktrees", "x"), "../../orphan/.git/worktrees/x");
    const tree = await scanRoot(root, 3, { workspaceDir: root });

    const group = tree.nodes.find((n) => n.id === "orphan.worktrees")!;
    assert(group !== undefined);
    assertEquals(group.kind, "group");
    assertEquals(group.name, "orphan.worktrees");
    assertEquals(group.selectable, false);
    assertEquals(group.warnings, [MISSING_PRIMARY_WARNING]);
    assertEquals(group.children.length, 1);

    const node = group.children[0];
    assertEquals(node.id, "orphan.worktrees/x");
    assertEquals(node.kind, "worktree");
    assertEquals(node.selectable, false);
    assertEquals(node.warnings, [MISSING_PRIMARY_WARNING]);
    assertEquals(node.primaryId, undefined);
  });
});

Deno.test("scan: relativeGitdir reflects the worktree's .git pointer", async () => {
  await withTemp(async (root) => {
    await repo(join(root, "projecta"));
    await worktree(join(root, "projecta.worktrees", "rel"), "../../projecta/.git/worktrees/rel");
    await worktree(join(root, "projecta.worktrees", "abs"), "/abs/projecta/.git/worktrees/abs");
    await Deno.mkdir(join(root, "projecta.worktrees", "none"), { recursive: true });

    const index = nodeIndex(await scanRoot(root, 3, { workspaceDir: root }));
    assertEquals(index.get("projecta.worktrees/rel")!.relativeGitdir, true);
    assertEquals(index.get("projecta.worktrees/abs")!.relativeGitdir, false);
    // No `.git` at all ⇒ false, and still listed (it is inside a .worktrees dir).
    assertEquals(index.get("projecta.worktrees/none")!.relativeGitdir, false);
  });
});

Deno.test("scan: dot-directories are skipped and the workspace node is flagged", async () => {
  await withTemp(async (root) => {
    await repo(join(root, "projecta"));
    await repo(join(root, ".hidden"));
    const tree = await scanRoot(root, 3, { workspaceDir: join(root, "projecta") });
    assertEquals(tree.nodes.map((n) => n.id), ["projecta"]);
    assertEquals(tree.nodes[0].isWorkspace, true);
    assertEquals(tree.nodes[0].selectable, false);
  });
});
