// Selection → mounts and workspace folders, and the read-back that recovers the selection
// from the files (there is no state file, so the tool and the repo can never drift).
//
// Three rules carry all the subtlety:
//
// 1. **Worktree closure.** Selecting a worktree also mounts its primary repo, because the
//    worktree's `.git` file points into `<primary>/.git/worktrees/<name>`. The primary is
//    flagged `auto`: mounted, but not added to the workspace folders.
// 2. **Mount target = containerRoot + id.** Because ids are paths relative to root, the offset
//    between a worktree and its primary is identical on the host and in the container —
//    which is exactly what makes a *relative* gitdir resolve inside the container.
// 3. **Workspace folders are host paths.** The `.code-workspace` is opened by VS Code on the
//    host, so its `folders` entries are host paths, written relative to the file itself to
//    match the entries a user writes by hand (`"."`, `"../../elsewhere"`). Only `source=` in
//    a mount and these folder paths are host-side; every `target=` is container-side.

import { type Config, workspaceFileDir, WORKSPACE_MOUNT_ROOT } from "./config.ts";
import { basename, isAbsolute, join, relative, resolve, SEPARATOR } from "jsr:@std/path@^1";
import { COMMA_WARNING, flatten, type Node, nodeIndex, pathIsExpressible, type Tree } from "./scan.ts";
import { findArraySpan, findFence, parseFenceEntries, parseJsonc } from "./jsonc_edit.ts";

export interface Mount {
  id: string;
  source: string;
  target: string;
  /** True when this mount exists only to satisfy a selected worktree. */
  auto: boolean;
}

export interface Folder {
  path: string;
  name: string;
}

export interface Derived {
  mounts: Mount[];
  folders: Folder[];
  /** Ids that are mounted but not explicitly selected (display: `[~]`). */
  auto: Set<string>;
  warnings: string[];
}

/** Container path for a scanned id. */
export function targetFor(cfg: Config, id: string): string {
  return joinPosix(cfg.containerRoot, id);
}

/** Container path for a skill directory name. */
export function skillTargetFor(cfg: Config, name: string): string {
  return joinPosix(cfg.skillsContainerRoot, name);
}

/**
 * A node's host path as the workspace file should spell it: relative to the file's own
 * directory, POSIX separators. Absolute is the fallback for the case where no relative path
 * exists at all (different Windows drives, where `relative()` hands back an absolute path).
 */
export function folderPathFor(base: string, hostPath: string): string {
  const rel = relative(base, hostPath);
  if (rel === "" || isAbsolute(rel)) return hostPath;
  return rel.split(SEPARATOR).join("/");
}

/** The inverse of `folderPathFor`: a workspace folder entry back to an absolute host path. */
function hostPathForFolder(base: string, entry: string): string {
  return isAbsolute(entry) ? resolve(entry) : resolve(join(base, entry));
}

function joinPosix(a: string, b: string): string {
  return `${a.replace(/\/+$/, "")}/${b.replace(/^\/+/, "")}`;
}

export function mountString(source: string, target: string): string {
  return `type=bind,source=${source},target=${target}`;
}

/** The devcontainer.json variable the Dev Containers extension resolves on the host. */
export const LOCAL_HOME = "${localEnv:HOME}";

/**
 * A host path as a mount `source=` should spell it. Anything at or under the user's home is
 * written `${localEnv:HOME}/...`, which the Dev Containers extension expands on whichever
 * machine opens the file — so the devcontainer.json is not pinned to one user's home.
 *
 * Only the emitted line is substituted; `Mount.source` keeps the real path, so `list`,
 * `status` and every warning still name something you can `cd` to. With `HOME` unset or
 * empty, or a path outside it, this is the identity.
 */
export function mountSourceFor(hostPath: string): string {
  const home = Deno.env.get("HOME");
  if (home === undefined || home === "") return hostPath;
  const trimmed = home.replace(/\/+$/, "");
  if (trimmed === "") return hostPath;
  if (hostPath === trimmed) return LOCAL_HOME;
  return hostPath.startsWith(trimmed + "/")
    ? LOCAL_HOME + hostPath.slice(trimmed.length)
    : hostPath;
}

/** The path the devcontainer already mounts the workspace dir at, by convention. */
export function workspaceMountTarget(tree: Tree): string {
  return joinPosix(WORKSPACE_MOUNT_ROOT, basename(tree.workspaceDir));
}

function collisionWarning(target: string): string {
  return `target ${target} collides with the workspace mount; ` +
    `set "containerRoot" to something other than ${WORKSPACE_MOUNT_ROOT}`;
}

/**
 * Everything derived from one selection set, in scan order (so repeated `apply` runs are
 * byte-identical).
 *
 * Skips, each with a warning: paths that cannot be expressed as a mount string, and targets
 * that would collide with the devcontainer's own workspace mount. The workspace node itself
 * is never a *folder* (it is the workspace root, already present as `.`) but it may still be
 * mounted by the worktree closure when `containerRoot` puts it somewhere else.
 */
export function derive(tree: Tree, selection: Set<string>, cfg: Config): Derived {
  const index = nodeIndex(tree);
  const selected = new Set([...selection].filter((id) => index.has(id)));

  // Worktree closure: a selected worktree drags in its primary's mount.
  const mountIds = new Set(selected);
  for (const id of selected) {
    const node = index.get(id);
    if (node?.kind === "worktree" && node.primaryId !== undefined) mountIds.add(node.primaryId);
  }

  const selfTarget = workspaceMountTarget(tree);
  const warnings: string[] = [];
  const warn = (msg: string) => {
    if (!warnings.includes(msg)) warnings.push(msg);
  };

  const mounts: Mount[] = [];
  const folders: Folder[] = [];
  const auto = new Set<string>();
  const folderBase = workspaceFileDir(cfg, tree.workspaceDir);

  for (const node of flatten(tree.nodes)) {
    if (node.kind === "group") continue;
    const wantMount = mountIds.has(node.id);
    const wantFolder = selected.has(node.id) && !node.isWorkspace;
    if (!wantMount && !wantFolder) continue;

    if (!pathIsExpressible(node.path)) {
      warn(`${node.id}: ${COMMA_WARNING}`);
      continue;
    }
    const target = targetFor(cfg, node.id);
    if (target === selfTarget) {
      warn(`${node.id}: ${collisionWarning(target)}`);
      continue;
    }
    if (wantMount) {
      const isAuto = !selected.has(node.id);
      mounts.push({ id: node.id, source: node.path, target, auto: isAuto });
      if (isAuto) auto.add(node.id);
    }
    if (wantFolder) folders.push({ path: folderPathFor(folderBase, node.path), name: node.id });
  }

  return { mounts, folders, auto, warnings };
}

/** Mount entries for the `devc:projects` fence. */
export function deriveMounts(tree: Tree, selection: Set<string>, cfg: Config): Mount[] {
  return derive(tree, selection, cfg).mounts;
}

/** Folder entries for the `devc:folders` fence. */
export function deriveFolders(tree: Tree, selection: Set<string>, cfg: Config): Folder[] {
  return derive(tree, selection, cfg).folders;
}

/** JSONC lines for the `mounts` fences. */
export function mountLines(mounts: Mount[]): string[] {
  return mounts.map((m) => JSON.stringify(mountString(mountSourceFor(m.source), m.target)));
}

/** JSONC lines for the `devc:skills` fence. */
export function skillMountLines(
  cfg: Config,
  skills: Array<{ name: string; path: string }>,
): string[] {
  return skills.map((s) =>
    JSON.stringify(mountString(mountSourceFor(s.path), skillTargetFor(cfg, s.name)))
  );
}

/** JSONC lines for the `devc:folders` fence. */
export function folderLines(folders: Folder[]): string[] {
  return folders.map((f) =>
    `{ "path": ${JSON.stringify(f.path)}, "name": ${JSON.stringify(f.name)} }`
  );
}

// --- read-back ------------------------------------------------------------------

export interface ReadSelection {
  selection: Set<string>;
  skills: Set<string>;
  warnings: string[];
}

/**
 * Recover the explicit selection from the files.
 *
 * The `devc:folders` fence is the source of truth, since it holds exactly the explicit
 * picks. When the workspace file (or its fence) is absent but the devcontainer's
 * `devc:projects` fence is not, every project entry there is treated as explicit —
 * otherwise a first run against a devcontainer-only setup would silently drop mounts.
 */
export function readSelection(
  devcontainerSrc: string | null,
  workspaceSrc: string | null,
  tree: Tree,
  cfg: Config,
): ReadSelection {
  const index = nodeIndex(tree);
  const warnings: string[] = [];
  const selection = new Set<string>();

  const folderPaths = workspaceSrc === null ? [] : fenceEntries(workspaceSrc, "folders", "folders")
    .map(folderPath)
    .filter((p): p is string => p !== null);
  const projectTargets = devcontainerSrc === null
    ? []
    : fenceEntries(devcontainerSrc, "mounts", "projects")
      .map(mountTarget)
      .filter((t): t is string => t !== null);

  // The two fences speak different languages: folder entries are host paths relative to the
  // workspace file, mount targets are container paths under `containerRoot`.
  const fromFolders = workspaceSrc !== null && hasFence(workspaceSrc, "folders", "folders");
  const folderBase = workspaceFileDir(cfg, tree.workspaceDir);
  for (const path of fromFolders ? folderPaths : projectTargets) {
    const id = fromFolders ? idForHostPath(tree.root, folderBase, path) : idForTarget(cfg, path);
    if (id === null || !index.has(id)) {
      warnings.push(`dropping unknown entry ${path} (no matching project under root)`);
      continue;
    }
    const node = index.get(id) as Node;
    if (node.isWorkspace) continue; // the workspace dir is never an explicit pick
    selection.add(id);
  }

  const skills = new Set<string>();
  if (devcontainerSrc !== null) {
    for (const entry of fenceEntries(devcontainerSrc, "mounts", "skills")) {
      const source = mountSource(entry);
      if (source !== null) skills.add(basename(source));
    }
  }
  return { selection, skills, warnings };
}

/** Skill names currently mounted, independent of the project selection. */
export function readSkills(devcontainerSrc: string | null): Set<string> {
  const out = new Set<string>();
  if (devcontainerSrc === null) return out;
  for (const entry of fenceEntries(devcontainerSrc, "mounts", "skills")) {
    const source = mountSource(entry);
    if (source !== null) out.add(basename(source));
  }
  return out;
}

function hasFence(src: string, key: string, id: string): boolean {
  const span = findArraySpan(src, key);
  if (span === null) return false;
  return findFence(src, span, id) !== null;
}

/** Raw element texts inside one fence; `[]` when the array or fence is absent. */
export function fenceEntries(src: string, key: string, id: string): string[] {
  const span = findArraySpan(src, key);
  if (span === null) return [];
  return parseFenceEntries(src, span, id);
}

function folderPath(entry: string): string | null {
  try {
    const value = parseJsonc(entry);
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const p = (value as Record<string, unknown>).path;
      if (typeof p === "string") return p;
    }
  } catch { /* fall through */ }
  return null;
}

function mountField(entry: string, field: string): string | null {
  let text: string;
  try {
    const value = parseJsonc(entry);
    if (typeof value === "string") text = value;
    else if (typeof value === "object" && value !== null) {
      const v = (value as Record<string, unknown>)[field];
      return typeof v === "string" ? v : null;
    } else return null;
  } catch {
    return null;
  }
  for (const part of text.split(",")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === field) return part.slice(eq + 1);
  }
  return null;
}

function mountTarget(entry: string): string | null {
  return mountField(entry, "target");
}

function mountSource(entry: string): string | null {
  return mountField(entry, "source");
}

/**
 * Map a workspace folder entry back to a scanned id, or null when it does not land under
 * `root` — which is how a hand-added folder elsewhere on the host is left alone rather than
 * mistaken for a managed one.
 */
export function idForHostPath(root: string, base: string, entry: string): string | null {
  const abs = hostPathForFolder(base, entry);
  const rel = relative(resolve(root), abs);
  if (rel === "" || rel === ".." || rel.startsWith(".." + SEPARATOR) || isAbsolute(rel)) {
    return null;
  }
  return rel.split(SEPARATOR).join("/");
}

/** Map a container target back to a scanned id, or null when it is outside containerRoot. */
export function idForTarget(cfg: Config, target: string): string | null {
  const prefix = cfg.containerRoot.replace(/\/+$/, "") + "/";
  if (!target.startsWith(prefix)) return null;
  const id = target.slice(prefix.length).replace(/\/+$/, "");
  return id === "" ? null : id;
}
