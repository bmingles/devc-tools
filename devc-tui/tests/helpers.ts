// Test scaffolding. Every test builds its own throwaway root / workspace dir / skills dir
// under Deno.makeTempDir() — nothing here reads or writes anything inside this repo.

import { join } from "jsr:@std/path@^1";
import type { Io } from "../cli.ts";

/** Read a hand-written JSONC fixture. */
export async function fixture(name: string): Promise<string> {
  return await Deno.readTextFile(new URL(`./fixtures/${name}`, import.meta.url));
}

/** Run `fn` with a fresh temp dir, removing it afterwards no matter what. */
export async function withTemp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await Deno.makeTempDir({ prefix: "devc-tui-test-" });
  try {
    return await fn(await Deno.realPath(dir));
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

/**
 * The example layout from the plan:
 *
 *   projecta/.git                      primary repo
 *   projecta.worktrees/some-feature    worktree, relative gitdir
 *   projectb/.git                      primary repo
 *   projectb.worktrees/some-other      worktree, relative gitdir
 *   projectb.worktrees/yet-another     worktree, ABSOLUTE gitdir
 *   org/tools/.git                     project at depth 2, under group "org"
 *   noise/                             empty dir — must be pruned
 */
export async function makeExampleRoot(root: string): Promise<void> {
  await repo(join(root, "projecta"));
  await worktree(join(root, "projecta.worktrees", "some-feature"), "../../projecta/.git/worktrees/some-feature");
  await repo(join(root, "projectb"));
  await worktree(join(root, "projectb.worktrees", "some-other"), "../../projectb/.git/worktrees/some-other");
  await worktree(join(root, "projectb.worktrees", "yet-another"), "/abs/projectb/.git/worktrees/yet-another");
  await repo(join(root, "org", "tools"));
  await Deno.mkdir(join(root, "noise"), { recursive: true });
}

/** A primary repo: a directory with a `.git` **directory**. */
export async function repo(path: string): Promise<void> {
  await Deno.mkdir(join(path, ".git"), { recursive: true });
}

/** A worktree: a directory with a `.git` **file** holding a gitdir pointer. */
export async function worktree(path: string, gitdir: string): Promise<void> {
  await Deno.mkdir(path, { recursive: true });
  await Deno.writeTextFile(join(path, ".git"), `gitdir: ${gitdir}\n`);
}

/** Write a devc-tui config file and return its path. */
export async function writeConfig(
  dir: string,
  cfg: Record<string, unknown>,
): Promise<string> {
  const path = join(dir, "config.json");
  await Deno.writeTextFile(path, JSON.stringify(cfg, null, 2) + "\n");
  return path;
}

export interface Capture {
  io: Io;
  out: string[];
  err: string[];
  stdout(): string;
  stderr(): string;
}

/** Collect stdout/stderr instead of printing, so CLI tests can assert on them. */
export function capture(): Capture {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { out: (t) => out.push(t), err: (t) => err.push(t) },
    out,
    err,
    stdout: () => out.join("\n"),
    stderr: () => err.join("\n"),
  };
}
