// resolveWorktree + longestRootAncestor, driven by a fake FsProbe (no real git, no disk).

import { assert, assertEquals } from "jsr:@std/assert@^1";
import {
  type FsProbe,
  longestRootAncestor,
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

Deno.test("primary outside the configured root is invalid", async () => {
  // Worktree is under the root, but the primary resolves above it.
  const wt = await resolveWorktree(
    "/home/me/code/feature1",
    "/home/me/code",
    probe({
      "/home/me/code/feature1/.git":
        "gitdir: ../../elsewhere/myproject/.git/worktrees/feature1\n",
    }),
  );
  assert(wt.isWorktree);
  assertEquals(wt.valid, false);
  assertEquals(wt.reason, "primary repo is outside the configured roots");
  assertEquals(wt.primaryRoot, "/home/me/elsewhere/myproject");
});

Deno.test("worktree with no matching root is invalid", async () => {
  const wt = await resolveWorktree(
    "/srv/repos/myproject.worktrees/feature1",
    null,
    probe({
      "/srv/repos/myproject.worktrees/feature1/.git":
        "gitdir: ../../myproject/.git/worktrees/feature1\n",
    }),
  );
  assert(wt.isWorktree);
  assertEquals(wt.valid, false);
  assertEquals(wt.reason, "primary repo is outside the configured roots");
});
