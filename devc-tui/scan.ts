// Turn the configured root into a tree of group / project / worktree nodes.
//
// The tree mirrors the directory layout — every node sits where it does on disk, at its real
// depth. Layout the scan understands (the `.worktrees` convention):
//
//   <root>/projecta/.git                     → project  id "projecta"
//   <root>/projecta.worktrees                → group    id "projecta.worktrees"
//   <root>/projecta.worktrees/some-feature   → worktree  id "projecta.worktrees/some-feature"
//   <root>/org/tools/.git                    → project  id "org/tools", under group "org"
//
// A worktree group is *not* folded into its primary project: the two are siblings, exactly as
// they are on disk. The link between them survives as `primaryId`, which `model.ts` uses for
// the worktree closure. Ids are paths relative to root, and that is load-bearing: with
// Git ≥ 2.48 relative worktrees, the worktree's `.git` file says
// `gitdir: ../../projecta/.git/worktrees/feat`, so the container must reproduce the same
// host-relative offset between the two mounts.

import { basename, join, relative, resolve, SEPARATOR } from "jsr:@std/path@^1";

export type NodeKind = "group" | "project" | "worktree";

export interface Node {
  kind: NodeKind;
  /** Path relative to root (POSIX separators, no leading "./"). Stable; the CLI's handle. */
  id: string;
  /** Display label. */
  name: string;
  /** Absolute host path. Empty for the synthetic "missing primary" group. */
  path: string;
  /** Nesting depth for display (0 = directly under root). */
  depth: number;
  children: Node[];
  /** Whether the user may check this node. */
  selectable: boolean;
  /** True when this node *is* the workspace dir (already mounted; never selectable). */
  isWorkspace: boolean;
  /** Worktrees only: does `.git` point at a relative gitdir? */
  relativeGitdir?: boolean;
  /** Worktrees only: id of the primary repo whose mount they need. */
  primaryId?: string;
  warnings: string[];
}

export interface Tree {
  /** Absolute, resolved root. */
  root: string;
  /** Absolute, resolved workspace dir. */
  workspaceDir: string;
  /** Top-level nodes, in scan order. */
  nodes: Node[];
}

export const WORKTREE_SUFFIX = ".worktrees";

export const COMMA_WARNING =
  "path contains a comma or equals sign; cannot be expressed as a mount string";
export const MISSING_PRIMARY_WARNING = "primary repo not found";

/** Mount strings are comma/equals delimited, so such paths simply cannot be expressed. */
export function pathIsExpressible(path: string): boolean {
  return !path.includes(",") && !path.includes("=");
}

export interface ScanOptions {
  /** The repo being configured; flags its node `isWorkspace` when it falls inside root. */
  workspaceDir?: string;
}

/** Scan `root` down to `maxDepth` levels, breadth-first per directory. */
export async function scanRoot(
  root: string,
  maxDepth: number,
  opts: ScanOptions = {},
): Promise<Tree> {
  const absRoot = await realPathOr(resolve(root));
  const workspaceDir = await realPathOr(resolve(opts.workspaceDir ?? Deno.cwd()));
  const nodes = await scanDir(absRoot, absRoot, 1, maxDepth, workspaceDir);
  return { root: absRoot, workspaceDir, nodes };
}

/** `depth` counts levels descended below root, so nodes here display at `depth - 1`. */
async function scanDir(
  absRoot: string,
  dir: string,
  depth: number,
  maxDepth: number,
  workspaceDir: string,
): Promise<Node[]> {
  const displayDepth = depth - 1;
  const dirs = await readDirs(absRoot, dir);
  const projects = new Map<string, Node>();
  const worktreeGroups = new Map<string, string>(); // base name → abs path
  const plain: string[] = [];

  for (const name of dirs) {
    if (name.endsWith(WORKTREE_SUFFIX) && name.length > WORKTREE_SUFFIX.length) {
      worktreeGroups.set(name.slice(0, -WORKTREE_SUFFIX.length), join(dir, name));
      continue;
    }
    const abs = join(dir, name);
    if (await isRepo(abs)) {
      projects.set(name, makeNode("project", absRoot, abs, workspaceDir, displayDepth));
    } else {
      plain.push(name);
    }
  }

  // A worktree group is a group node of its own, sibling to the primary it belongs to. It is
  // exempt from the maxDepth prune: it sits beside a primary that is already in range.
  const worktreeNodes: Node[] = [];
  for (const [base, groupPath] of worktreeGroups) {
    const primary = projects.get(base);
    const worktrees = await readWorktrees(
      absRoot,
      groupPath,
      workspaceDir,
      primary === undefined ? undefined : primary.id,
      displayDepth + 1,
    );
    if (worktrees.length === 0) continue;
    // Without the primary's mount, git inside these worktrees would not resolve its gitdir.
    if (primary === undefined) {
      for (const w of worktrees) {
        w.selectable = false;
        w.warnings.push(MISSING_PRIMARY_WARNING);
      }
    }
    worktreeNodes.push({
      kind: "group",
      id: toId(absRoot, groupPath),
      name: `${base}${WORKTREE_SUFFIX}`,
      path: groupPath,
      depth: displayDepth,
      children: worktrees,
      selectable: false,
      isWorkspace: false,
      warnings: primary === undefined ? [MISSING_PRIMARY_WARNING] : [],
    });
  }

  // Everything else is a group node — kept only if a project or worktree lives beneath it.
  const groups: Node[] = [];
  for (const name of plain) {
    if (depth >= maxDepth) continue;
    const abs = join(dir, name);
    const children = await scanDir(absRoot, abs, depth + 1, maxDepth, workspaceDir);
    if (children.length === 0) continue;
    groups.push({
      kind: "group",
      id: toId(absRoot, abs),
      name,
      path: abs,
      depth: displayDepth,
      children,
      selectable: false,
      isWorkspace: false,
      warnings: [],
    });
  }

  return [...projects.values(), ...worktreeNodes, ...groups].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  );
}

async function readWorktrees(
  absRoot: string,
  groupPath: string,
  workspaceDir: string,
  primaryId: string | undefined,
  displayDepth: number,
): Promise<Node[]> {
  const out: Node[] = [];
  for (const name of await readDirs(absRoot, groupPath)) {
    const abs = join(groupPath, name);
    const node = makeNode("worktree", absRoot, abs, workspaceDir, displayDepth);
    node.relativeGitdir = await hasRelativeGitdir(abs);
    node.primaryId = primaryId;
    out.push(node);
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function makeNode(
  kind: NodeKind,
  absRoot: string,
  abs: string,
  workspaceDir: string,
  depth: number,
): Node {
  const node: Node = {
    kind,
    id: toId(absRoot, abs),
    name: basename(abs),
    path: abs,
    depth,
    children: [],
    selectable: true,
    isWorkspace: abs === workspaceDir,
    warnings: [],
  };
  if (node.isWorkspace) node.selectable = false;
  if (!pathIsExpressible(abs)) {
    node.selectable = false;
    node.warnings.push(COMMA_WARNING);
  }
  return node;
}

/** Immediate subdirectory names, dot-dirs and root-escaping symlinks skipped. */
async function readDirs(absRoot: string, dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries: AsyncIterable<Deno.DirEntry>;
  try {
    entries = Deno.readDir(dir);
  } catch {
    return out;
  }
  try {
    for await (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      if (entry.isDirectory) {
        out.push(entry.name);
        continue;
      }
      if (!entry.isSymlink) continue;
      const abs = join(dir, entry.name);
      const real = await Deno.realPath(abs).catch(() => null);
      if (real === null || !within(absRoot, real)) continue;
      const stat = await Deno.stat(abs).catch(() => null);
      if (stat?.isDirectory) out.push(entry.name);
    }
  } catch {
    // Unreadable mid-iteration — return what we have rather than failing the whole scan.
  }
  return out.sort();
}

function within(root: string, path: string): boolean {
  if (path === root) return true;
  const rel = relative(root, path);
  return rel !== "" && !rel.startsWith("..") && !rel.startsWith(SEPARATOR + "..");
}

/** A project is any dir holding `.git` — a directory (normal repo) or a file (worktree). */
async function isRepo(dir: string): Promise<boolean> {
  try {
    await Deno.lstat(join(dir, ".git"));
    return true;
  } catch {
    return false;
  }
}

/**
 * True when the worktree's `.git` file holds a *relative* gitdir, e.g.
 * `gitdir: ../../projecta/.git/worktrees/feat` (Git ≥ 2.48 `worktree.useRelativePaths`).
 * Unreadable or absolute ⇒ false.
 */
async function hasRelativeGitdir(dir: string): Promise<boolean> {
  try {
    const text = await Deno.readTextFile(join(dir, ".git"));
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(text);
    if (m === null) return false;
    return !m[1].startsWith("/");
  } catch {
    return false;
  }
}

function toId(absRoot: string, abs: string): string {
  return relative(absRoot, abs).split(SEPARATOR).join("/");
}

async function realPathOr(path: string): Promise<string> {
  return await Deno.realPath(path).catch(() => path);
}

// --- tree helpers ---------------------------------------------------------------

/** Pre-order flatten: parent before its children, in scan order. */
export function flatten(nodes: Node[]): Node[] {
  const out: Node[] = [];
  const walk = (list: Node[]) => {
    for (const n of list) {
      out.push(n);
      walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

/** All selectable-or-not project/worktree nodes, keyed by id, in scan order. */
export function nodeIndex(tree: Tree): Map<string, Node> {
  const map = new Map<string, Node>();
  for (const n of flatten(tree.nodes)) {
    if (n.kind !== "group") map.set(n.id, n);
  }
  return map;
}
