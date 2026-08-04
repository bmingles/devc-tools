// Worktree resolution for the `devc config` wizard.
//
// When a picked source folder is a git *worktree*, its `.git` file points at the primary
// repo's git dir (`<primary>/.git/worktrees/<name>`). For git to work inside the container the
// primary git dir must be mounted at the mirror location — but that only holds when:
//   1. the worktree uses a *relative* `gitdir:` (so the link survives the host→container path
//      change), and
//   2. the primary repo lives under the same configured code root as the worktree (so the two
//      mirrored `/workspaces/...` offsets match).
// Both facts are readable straight from the worktree's `.git` file, so this stays pure given an
// injected `FsProbe` (no `git` subprocess) — fast enough to run per-entry in the picker and
// identical to the decision the mount builder makes.

import { dirnamePosix, isAbsolutePosix, resolvePosix } from "./posix.ts";

/** Minimal filesystem access the resolver needs, injected so tests can drive it headlessly. */
export interface FsProbe {
  /** True when `path` exists and is a regular file (a worktree's `.git` is a file). */
  statIsFile(path: string): Promise<boolean>;
  /** The file's text, or null when missing/unreadable. */
  readText(path: string): Promise<string | null>;
}

/** The real Deno-backed probe used outside tests. */
export const realFsProbe: FsProbe = {
  async statIsFile(path) {
    try {
      return (await Deno.stat(path)).isFile;
    } catch {
      return false;
    }
  },
  async readText(path) {
    try {
      return await Deno.readTextFile(path);
    } catch {
      return null;
    }
  },
};

/** The outcome of probing a picked folder for worktree-ness. */
export type WorktreeInfo =
  | { isWorktree: false }
  | {
    isWorktree: true;
    /** Whether the primary `.git` can be safely mounted (relative paths + primary under root). */
    valid: boolean;
    /** Human-readable reason when `!valid`, for the picker flag. */
    reason?: string;
    /** Absolute host path of the primary repo's git dir (e.g. `.../myproject/.git`). */
    primaryGitDir?: string;
    /** Absolute host path of the primary repo's working tree (e.g. `.../myproject`). */
    primaryRoot?: string;
    /** Container target for the primary `.git` mount (only set when `valid`). */
    primaryGitTarget?: string;
  };

/**
 * The longest root in `roots` that is `absPath` itself or an ancestor of it, or null when none
 * apply. Longest wins so nested roots (`~/code` and `~/code/team`) resolve to the most specific.
 */
export function longestRootAncestor(
  absPath: string,
  roots: string[],
): string | null {
  let best: string | null = null;
  for (const r of roots) {
    if (absPath === r || absPath.startsWith(r + "/")) {
      if (best === null || r.length > best.length) best = r;
    }
  }
  return best;
}

/**
 * Probe `pickedAbs` for worktree-ness and, if it is one, whether its primary `.git` can be
 * mounted given the code `root` it falls under (from `longestRootAncestor`). Pure given `fs`.
 */
export async function resolveWorktree(
  pickedAbs: string,
  root: string | null,
  fs: FsProbe,
): Promise<WorktreeInfo> {
  const gitFile = pickedAbs + "/.git";
  // A plain repo has a `.git` *directory*; a non-repo has neither. Only a worktree (or
  // submodule) has a `.git` *file*.
  if (!(await fs.statIsFile(gitFile))) return { isWorktree: false };

  const text = await fs.readText(gitFile);
  const m = text?.match(/^gitdir:\s*(.+?)\s*$/m);
  if (!m) return { isWorktree: false };
  const raw = m[1];

  const gitdirAbs = isAbsolutePosix(raw) ? raw : resolvePosix(pickedAbs, raw);
  // A worktree's git dir ends `.../worktrees/<name>`; a submodule's is `.../modules/<name>`.
  if (!/\/worktrees\/[^/]+\/?$/.test(gitdirAbs)) return { isWorktree: false };

  const primaryGitDir = gitdirAbs.slice(0, gitdirAbs.indexOf("/worktrees/"));
  const primaryRoot = dirnamePosix(primaryGitDir);

  const relative = !isAbsolutePosix(raw);
  const underRoot = root !== null &&
    (primaryRoot === root || primaryRoot.startsWith(root + "/"));
  const valid = relative && underRoot;
  const reason = !relative
    ? "worktree uses absolute paths"
    : !underRoot
    ? "primary repo is outside the configured roots"
    : undefined;
  const primaryGitTarget = valid
    ? `/workspaces/${primaryRoot.slice(root!.length + 1)}/.git`
    : undefined;

  return {
    isWorktree: true,
    valid,
    reason,
    primaryGitDir,
    primaryRoot,
    primaryGitTarget,
  };
}
