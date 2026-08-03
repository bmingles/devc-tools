import { assertEquals } from "jsr:@std/assert@^1";
import { computeContainerWorkspaceFolder } from "../container.ts";

async function withTempDir(fn: (tmp: string) => Promise<void>) {
  const tmp = await Deno.realPath(await Deno.makeTempDir());
  try {
    await fn(tmp);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  const { code, stderr } = await new Deno.Command("git", {
    args: ["-C", cwd, ...args],
    stdout: "null",
    stderr: "piped",
  }).output();
  if (code !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${new TextDecoder().decode(stderr)}`,
    );
  }
}

async function initRepo(dir: string): Promise<void> {
  await Deno.mkdir(dir, { recursive: true });
  await git(dir, "init", "-q");
  await git(dir, "config", "user.email", "test@example.com");
  await git(dir, "config", "user.name", "Test");
  await Deno.writeTextFile(`${dir}/.gitkeep`, "");
  await git(dir, "add", ".gitkeep");
  await git(dir, "commit", "-q", "-m", "init");
}

Deno.test("computeContainerWorkspaceFolder: plain non-git directory", async () => {
  await withTempDir(async (tmp) => {
    const dir = `${tmp}/some-folder`;
    await Deno.mkdir(dir, { recursive: true });
    assertEquals(
      await computeContainerWorkspaceFolder(dir),
      "/workspaces/some-folder",
    );
  });
});

Deno.test("computeContainerWorkspaceFolder: plain git repo (not a worktree)", async () => {
  await withTempDir(async (tmp) => {
    const dir = `${tmp}/my-repo`;
    await initRepo(dir);
    assertEquals(
      await computeContainerWorkspaceFolder(dir),
      "/workspaces/my-repo",
    );
  });
});

Deno.test("computeContainerWorkspaceFolder: git worktree with sibling .worktrees layout", async () => {
  await withTempDir(async (tmp) => {
    const main = `${tmp}/main`;
    await initRepo(main);

    const worktree = `${tmp}/main.worktrees/feature`;
    await git(main, "worktree", "add", worktree, "-b", "feature", "-q");

    assertEquals(
      await computeContainerWorkspaceFolder(worktree),
      "/workspaces/main.worktrees/feature",
    );
  });
});

Deno.test("computeContainerWorkspaceFolder: git worktree in a different relative layout", async () => {
  await withTempDir(async (tmp) => {
    const main = `${tmp}/projects/myrepo`;
    await initRepo(main);

    const worktree = `${tmp}/worktrees/myrepo-feature`;
    await Deno.mkdir(`${tmp}/worktrees`, { recursive: true });
    await git(main, "worktree", "add", worktree, "-b", "feature", "-q");

    assertEquals(
      await computeContainerWorkspaceFolder(worktree),
      "/workspaces/worktrees/myrepo-feature",
    );
  });
});
