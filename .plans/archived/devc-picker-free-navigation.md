# devc picker free navigation — roots become shortcuts, not boundaries

## Problem

The `devc config` source and skills pickers are *bounded*: the configured roots are the synthetic top
level, `←` refuses to go above one, and only folders inside a root can be picked. The roots are a
useful shortcut, but plenty of folders worth mounting live outside them, and today they are simply
unreachable.

Lifting that constraint exposes a second problem. `resolveWorktree` currently calls a worktree
invalid — "primary repo is outside the configured roots" — whenever no configured root contains its
primary repo, and skips the primary `.git` mount. Out-of-root worktrees are exactly what free
navigation makes reachable, so without a fix the new capability hands you a worktree with broken git.

## Goal

Navigate anywhere and pick any folder, with the roots kept as the opening shortcut list; and a
worktree picked anywhere still gets its primary `.git` mounted at a mirroring location.

## Decisions

- **`←` walks to the real parent everywhere**, including at a configured root. At the filesystem root
  it wraps back to the shortcut list (when there is one), so the shortcuts stay reachable without a
  new key binding. At the shortcut list `←` is a no-op — nothing is above it.
- **Roots stay pure shortcuts: still not selectable, still no checkbox.** Ticking a whole root is now
  possible from its parent directory, which is where it reads as an ordinary folder.
- **Multi-root still opens on the shortcut list; a single root still opens inside it.** Unchanged. A
  single root now also gets a one-entry shortcut list if you walk up to `/` and press `←`; harmless,
  and cheaper than special-casing.
- **One mirror base per picked worktree, used by both of its mounts.** A worktree's relative `gitdir:`
  link only resolves in the container if the worktree and the primary `.git` keep their host offset,
  which means both container targets must mirror from the *same* base directory. Any common ancestor
  works, so: prefer the configured code root when it contains the primary (shallow, stable container
  paths, and identical to today's output), and fall back to the worktree/primary **common ancestor**
  otherwise — the same choice the devcontainer CLI makes for a worktree opened as the project folder.
- **`valid` now means only "relative `gitdir:`".** An absolute `gitdir:` cannot survive the
  host→container path change whatever we mount, so it stays the one disqualifier; the
  "primary repo is outside the configured roots" reason disappears entirely.
- **`impliedPrimaryMounts` is replaced by `resolvePickedMounts`**, which returns *both* the base each
  pick's target mirrors from and the primary it drags in. The base now has to travel with the derived
  mount — a worktree's own row target changes with it — so returning them separately would let the
  picker and the fence disagree, which is the drift the single helper exists to prevent.
- **Plain out-of-root folders keep the `/workspaces/<basename>` target.** Only worktrees get a
  mirrored base; deriving one for unrelated folders would produce surprising container paths.
- **Known edge, accepted:** when the primary working tree is *also* picked and no configured root
  contains both it and the worktree, the two rows are based differently and won't mirror. Not a
  regression — today that worktree is flagged invalid and gets no primary mount at all.

## Contract

- `posix.ts` gains:
  - `commonAncestorPosix(a, b)` — deepest directory that is `a`, `b`, or an ancestor of both; `/`
    when they share nothing.
  - `relativeUnderPosix(base, path)` — `path` relative to `base`, or null when not strictly under it.
    Must handle `base === "/"`, where a naive `base + "/"` prefix is `//`.
- `mounts.ts` `defaultTarget` uses `relativeUnderPosix`, so a base of `/` mirrors instead of silently
  falling back to the basename. No change for any other input.
- `worktree.ts`:
  - `WorktreeInfo` gains `mountBase?: string` (set only when `valid`).
  - `resolveWorktree`: `valid === !isAbsolutePosix(gitdir)`. `reason` is only ever
    `"worktree uses absolute paths"`. `primaryGitTarget` = `/workspaces/<primaryGitDir relative to
    mountBase>`.
  - `resolvePickedMounts(paths, codeRoots, fs): Promise<PickedMount[]>` where
    `PickedMount { path: string; base?: string; primary?: { gitDir: string; target: string } }` —
    one entry per input path in order. `base` is the worktree's `mountBase` for a mountable worktree,
    else `longestRootAncestor(path, codeRoots) ?? undefined`. `primary` is set only for a mountable
    worktree whose primary working tree is not itself picked and whose target no earlier pick already
    brought in. Replaces `impliedPrimaryMounts` / `ImpliedPrimaryMount`.
- `tui/folder_picker.ts`:
  - `roots` is documented as a shortcut list, not a boundary. Behavior:
    `←` (and empty-filter backspace) at any directory → its parent; at the filesystem root → the
    shortcut list when `roots` is non-empty, else no-op; at the shortcut list → no-op.
  - Roots remain unselectable and render without a checkbox.
  - Footer legend, browser focus: `← up` at a normal directory; `← roots` at the filesystem root when
    a shortcut list exists; neither at the shortcut list. Everything else in the legend is unchanged.
- Both the source and the skills picker get this, since both are the same picker.

## Checklist

- [x] `commonAncestorPosix` + `relativeUnderPosix` in `devc/posix.ts`
- [x] `defaultTarget` in `devc/mounts.ts` on `relativeUnderPosix`
- [x] `resolveWorktree` in `devc/worktree.ts`: `mountBase`, relative-only validity, mirrored
      `primaryGitTarget`; module header updated (it documents the two old conditions)
- [x] `resolvePickedMounts` replaces `impliedPrimaryMounts` in `devc/worktree.ts`
- [x] `buildSourceRows` and the picker's `derive` in `devc/tui/config_flow.ts` both on
      `resolvePickedMounts`, with the source row target using the returned `base`
- [x] `goUp` in `devc/tui/folder_picker.ts` walks up freely and wraps at `/`
- [x] Legend shows `← up` / `← roots` per position
- [x] `roots` docs (module header, `PickerState`, `PickerOptions`) no longer describe a boundary
- [x] Tests: `commonAncestorPosix` / `relativeUnderPosix` incl. the `/` base
- [x] Tests: `resolveWorktree` common-ancestor fallback (replacing the two "outside the roots"
      invalid cases) and the nested-worktree case
- [x] Tests: `resolvePickedMounts` (base per pick, dedup, primary-picked)
- [x] Tests: picker navigation above a root, the `/` wrap, shortcut-list no-op (replacing the three
      bounded-boundary tests)
- [x] Tests: end-to-end flow picking a worktree outside every root
- [x] `.plans/design/devc-design.md` Steps 2 + 3 drop the "cannot go above" wording
- [x] `devc/README.md` if it documents the constraint
- [x] Fix the browse heading reading `//` at the filesystem root (`asDir`) — pre-existing in the
      free-mode global wizard, newly reachable in the project pickers

## Validation

- [x] `deno test -A devc/` — all suites pass
- [x] `deno check devc/main.ts` clean
- [x] `←` at a configured root opens its parent directory, and folders there are selectable
- [x] `←` at `/` shows the shortcut list; `←` there again does nothing
- [x] Multi-root still opens on the shortcut list, single root still opens inside its root
- [x] Roots in the shortcut list still carry no checkbox and still ignore `space`
- [x] Legend reads `← up` inside a directory and `← roots` at `/`
- [x] A worktree + primary both under one configured root produce byte-identical rows to before
- [x] A worktree picked outside every root mounts its own folder *and* the primary `.git`, both
      mirrored from their common ancestor
- [x] A worktree nested inside its primary repo targets the primary `.git` at `/workspaces/.git`
- [x] An absolute-`gitdir:` worktree is still flagged `⚠ primary not mounted (worktree uses absolute
      paths)`
- [x] No `⚠ primary not mounted (primary repo is outside the configured roots)` remains reachable

## Relevant Files

- `devc/posix.ts` — two new path helpers
- `devc/mounts.ts` — `defaultTarget` via `relativeUnderPosix`
- `devc/worktree.ts` — `mountBase`, validity, `resolvePickedMounts`
- `devc/tui/folder_picker.ts` — `goUp`, legend, roots docs
- `devc/tui/config_flow.ts` — both callers on `resolvePickedMounts`
- `devc/tests/posix_test.ts` — helper cases (create if absent)
- `devc/tests/worktree_test.ts` — fallback + `resolvePickedMounts`
- `devc/tests/folder_picker_test.ts` — navigation
- `devc/tests/config_flow_test.ts` — out-of-root worktree flow
- `devc/tests/mounts_row_test.ts` — `defaultTarget` regression cover
- `.plans/design/devc-design.md` — Steps 2 + 3
- `devc/README.md` — if it states the constraint
