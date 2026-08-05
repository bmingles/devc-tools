// resolveWorktree + longestRootAncestor, driven by a fake FsProbe (no real git, no disk).

import { assert, assertEquals } from "jsr:@std/assert@^1";
import {
  type FsProbe,
  longestRootAncestor,
  resolvePickedMounts,
  resolveWorktree,
} from "../worktree.ts";

/** A fake filesystem: `files` maps a path to its text (and marks it a regular file). */
function probe(files: Record<string, string>): FsProbe {
  return {
    statIsFile: (p) => Promise.resolve(p in files),
    readText: (p) => Promise.resolve(files[p] ?? null),
  };
}

Deno.test("longestRootAncestor picks the longest matching root (or null)", () => {
  const roots = ["/home/me/code", "/home/me/code/team"];
  assertEquals(
    longestRootAncestor("/home/me/code/team/proj", roots),
    "/home/me/code/team",
  );
  assertEquals(
    longestRootAncestor("/home/me/code/solo", roots),
    "/home/me/code",
  );
  assertEquals(longestRootAncestor("/srv/elsewhere", roots), null);
});

Deno.test("plain repo (.git is a directory) is not a worktree", async () => {
  // No `<path>/.git` file entry → statIsFile is false.
  const wt = await resolveWorktree("/home/me/code/proj", "/home/me/code", probe({}));
  assertEquals(wt, { isWorktree: false });
});

Deno.test("submodule (.git → .../modules/...) is not a worktree", async () => {
  const wt = await resolveWorktree(
    "/home/me/code/super/sub",
    "/home/me/code",
    probe({
      "/home/me/code/super/sub/.git":
        "gitdir: ../../.git/modules/sub\n",
    }),
  );
  assertEquals(wt, { isWorktree: false });
});

Deno.test("relative worktree under the root is valid and mounts the primary .git", async () => {
  const wt = await resolveWorktree(
    "/home/me/code/myproject.worktrees/feature1",
    "/home/me/code",
    probe({
      "/home/me/code/myproject.worktrees/feature1/.git":
        "gitdir: ../../myproject/.git/worktrees/feature1\n",
    }),
  );
  assert(wt.isWorktree);
  assertEquals(wt.valid, true);
  assertEquals(wt.reason, undefined);
  assertEquals(wt.primaryGitDir, "/home/me/code/myproject/.git");
  assertEquals(wt.primaryRoot, "/home/me/code/myproject");
  assertEquals(wt.primaryGitTarget, "/workspaces/myproject/.git");
  // The root holds the primary, so it is the base both mounts mirror from.
  assertEquals(wt.mountBase, "/home/me/code");
});

Deno.test("absolute-path worktree is invalid (link would break in-container)", async () => {
  const wt = await resolveWorktree(
    "/home/me/code/myproject.worktrees/feature1",
    "/home/me/code",
    probe({
      "/home/me/code/myproject.worktrees/feature1/.git":
        "gitdir: /home/me/code/myproject/.git/worktrees/feature1\n",
    }),
  );
  assert(wt.isWorktree);
  assertEquals(wt.valid, false);
  assertEquals(wt.reason, "worktree uses absolute paths");
  assertEquals(wt.primaryGitTarget, undefined);
});

Deno.test("primary outside the configured root mirrors from their common ancestor", async () => {
  // Worktree is under the root, but the primary resolves above it — the root can't be the base.
  const wt = await resolveWorktree(
    "/home/me/code/feature1",
    "/home/me/code",
    probe({
      "/home/me/code/feature1/.git":
        "gitdir: ../../elsewhere/myproject/.git/worktrees/feature1\n",
    }),
  );
  assert(wt.isWorktree);
  assertEquals(wt.valid, true);
  assertEquals(wt.reason, undefined);
  assertEquals(wt.primaryRoot, "/home/me/elsewhere/myproject");
  assertEquals(wt.mountBase, "/home/me");
  assertEquals(wt.primaryGitTarget, "/workspaces/elsewhere/myproject/.git");
  // The offset survives: /workspaces/code/feature1 + ../../elsewhere/myproject/.git resolves to it.
});

Deno.test("worktree with no matching root mirrors from their common ancestor", async () => {
  const wt = await resolveWorktree(
    "/srv/repos/myproject.worktrees/feature1",
    null,
    probe({
      "/srv/repos/myproject.worktrees/feature1/.git":
        "gitdir: ../../myproject/.git/worktrees/feature1\n",
    }),
  );
  assert(wt.isWorktree);
  assertEquals(wt.valid, true);
  assertEquals(wt.mountBase, "/srv/repos");
  assertEquals(wt.primaryGitTarget, "/workspaces/myproject/.git");
});

Deno.test("worktree nested inside its primary repo puts the primary .git at the base", async () => {
  const wt = await resolveWorktree(
    "/srv/iris/wt/f1",
    null, // no configured root ⇒ the base is the primary repo itself
    probe({ "/srv/iris/wt/f1/.git": "gitdir: ../../.git/worktrees/f1\n" }),
  );
  assert(wt.isWorktree);
  assertEquals(wt.valid, true);
  assertEquals(wt.mountBase, "/srv/iris");
  assertEquals(wt.primaryGitTarget, "/workspaces/.git");
  // /workspaces/wt/f1 + ../../.git ⇒ /workspaces/.git.
});

// ── resolvePickedMounts (what the picker shows and the fence gets) ───────────────

const ROOTS = ["/home/me/code"];
const WT = (name: string) =>
  `/home/me/code/myproject.worktrees/${name}` as const;
const RELATIVE = {
  [WT("feature1") + "/.git"]:
    "gitdir: ../../myproject/.git/worktrees/feature1\n",
  [WT("feature2") + "/.git"]:
    "gitdir: ../../myproject/.git/worktrees/feature2\n",
};

Deno.test("resolvePickedMounts: a valid worktree drags in its primary .git", async () => {
  assertEquals(
    await resolvePickedMounts([WT("feature1")], ROOTS, probe(RELATIVE)),
    [{
      path: WT("feature1"),
      base: "/home/me/code",
      primary: {
        gitDir: "/home/me/code/myproject/.git",
        target: "/workspaces/myproject/.git",
      },
    }],
  );
});

Deno.test("resolvePickedMounts: two worktrees of one primary bring it in once", async () => {
  const mounts = await resolvePickedMounts(
    [WT("feature1"), WT("feature2")],
    ROOTS,
    probe(RELATIVE),
  );
  assertEquals(mounts.map((m) => m.path), [WT("feature1"), WT("feature2")]);
  assertEquals(mounts[0].primary?.target, "/workspaces/myproject/.git");
  assertEquals(mounts[1].primary, undefined, "the second shares the first's mount");
});

Deno.test("resolvePickedMounts: picking the primary working tree makes the .git mount moot", async () => {
  const mounts = await resolvePickedMounts(
    ["/home/me/code/myproject", WT("feature1")],
    ROOTS,
    probe(RELATIVE),
  );
  assertEquals(mounts.map((m) => m.primary), [undefined, undefined]);
  assertEquals(mounts.map((m) => m.base), ["/home/me/code", "/home/me/code"]);
});

Deno.test("resolvePickedMounts: an invalid worktree and a plain folder keep their root as base", async () => {
  const mounts = await resolvePickedMounts(
    [WT("feature1"), "/home/me/code/plain"],
    ROOTS,
    probe({
      [WT("feature1") + "/.git"]:
        "gitdir: /home/me/code/myproject/.git/worktrees/feature1\n", // absolute → unmountable
    }),
  );
  assertEquals(mounts, [
    { path: WT("feature1"), base: "/home/me/code" },
    { path: "/home/me/code/plain", base: "/home/me/code" },
  ]);
});

Deno.test("resolvePickedMounts: a worktree outside every root mirrors from the common ancestor", async () => {
  assertEquals(
    await resolvePickedMounts(["/srv/proj.worktrees/f1"], ROOTS, probe({
      "/srv/proj.worktrees/f1/.git": "gitdir: ../../proj/.git/worktrees/f1\n",
    })),
    [{
      path: "/srv/proj.worktrees/f1",
      base: "/srv",
      primary: { gitDir: "/srv/proj/.git", target: "/workspaces/proj/.git" },
    }],
  );
});

Deno.test("resolvePickedMounts: a plain folder outside every root has no base (basename fallback)", async () => {
  assertEquals(
    await resolvePickedMounts(["/srv/data"], ROOTS, probe({})),
    [{ path: "/srv/data", base: undefined }],
  );
});
