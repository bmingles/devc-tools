// Small, dependency-free posix-path helpers shared across the container lifecycle path
// (`container.ts`) and the config-wizard worktree resolution (`worktree.ts`). They operate on
// "/"-separated strings only (no filesystem access), so both a real host path and a
// `git rev-parse` fragment can be resolved the same way.

/** The directory portion of `p` (posix). `.` when there is no slash; `/` at the root. */
export function dirnamePosix(p: string): string {
  const idx = p.lastIndexOf("/");
  if (idx < 0) return ".";
  if (idx === 0) return "/";
  return p.slice(0, idx);
}

/** The last path segment of `p` (posix), ignoring a single trailing slash. */
export function basenamePosix(p: string): string {
  const trimmed = p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p;
  const idx = trimmed.lastIndexOf("/");
  return idx < 0 ? trimmed : trimmed.slice(idx + 1);
}

/**
 * The deepest directory that is `a`, `b`, or an ancestor of both (posix). `/` when they share no
 * leading segment. Used to pick a base two mounts can mirror from when no configured root holds both.
 */
export function commonAncestorPosix(a: string, b: string): string {
  const as = a.split("/");
  const bs = b.split("/");
  const shared: string[] = [];
  for (let i = 0; i < Math.min(as.length, bs.length); i++) {
    if (as[i] !== bs[i]) break;
    shared.push(as[i]);
  }
  // A single empty segment is all that two disjoint absolute paths share — that is the root.
  return shared.join("/") || "/";
}

/**
 * `path`'s location relative to `base`, or null when `path` is not strictly under `base`. `base` of
 * `/` is handled: the naive `base + "/"` prefix would be `//` and never match.
 */
export function relativeUnderPosix(base: string, path: string): string | null {
  if (base === "") return null;
  const prefix = base.endsWith("/") ? base : base + "/";
  if (!path.startsWith(prefix)) return null;
  // `path === base` leaves nothing to mirror — and with a `/` base it leaves an empty segment that
  // would build a target ending in a bare slash.
  const rel = path.slice(prefix.length);
  return rel === "" ? null : rel;
}

/** True when `p` is an absolute posix path (or a `C:/`-style Windows drive path). */
export function isAbsolutePosix(p: string): boolean {
  return p.startsWith("/") || /^[a-zA-Z]:\//.test(p);
}

// Resolves `rel` (e.g. git rev-parse's `--show-cdup`/`--git-common-dir` output, or a
// worktree `.git` file's relative `gitdir:`, which may be relative) against `base`, both
// using "/" separators. `rel` may also already be absolute, in which case it's returned
// as-is (trailing slash trimmed).
export function resolvePosix(base: string, rel: string): string {
  if (rel === "" || rel === ".") return base;
  if (isAbsolutePosix(rel)) {
    return rel.length > 1 && rel.endsWith("/") ? rel.slice(0, -1) : rel;
  }

  const baseMatch = base.match(/^([a-zA-Z]:)?\//);
  const prefix = baseMatch ? baseMatch[0] : "";
  const segments = base.slice(prefix.length).split("/").filter(Boolean);

  for (const seg of rel.split("/").filter(Boolean)) {
    if (seg === "..") segments.pop();
    else if (seg !== ".") segments.push(seg);
  }

  return prefix + segments.join("/");
}
