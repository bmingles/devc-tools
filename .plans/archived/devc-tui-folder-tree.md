# devc-tui — make the tree read like a folder tree

The interactive tree currently diverges from the filesystem in three ways that
read as bugs:

1. `<base>.worktrees/*` is spliced in as a child of the `<base>` project, and
   the `<base>.worktrees` directory itself is never drawn (`scan.ts:103-118`).
2. The fold column carries a selectability meaning — `x` means "not selectable",
   next to `v`/`>` which mean expanded/collapsed (`tui/render.ts:152-157`,
   `tui/state.ts:252-255`).
3. Every node starts expanded (`tui/state.ts:112-117`).

This plan makes the tree mirror the scanned directory layout, starts collapsed,
and confines the fold column to folding.

**Display-only.** Ids stay paths relative to `root`, so mounts, folders, fence
round-trips and the CLI's `<id>` arguments are unchanged. Worktree closure (a
selected worktree drags in its primary's mount, shown `[~]`) is unchanged — it
is load-bearing for relative gitdirs.

## Decisions

- **Worktrees stay where they live.** `<base>.worktrees` becomes an ordinary
  group node, sibling to `<base>`, named for the real directory. Its worktrees
  are its children.
- **No checkbox means not selectable.** Rows the user cannot check print three
  blanks where the checkbox goes. The reason is already carried by the
  `(workspace)` note or a `! warning`.
- **Collapsed, then opened to reveal the selection.** Start with everything
  folded, then expand exactly the ancestors of already-selected ids so what is
  currently mounted is on the first frame.
- **`Fold` loses `"blocked"`.** The union becomes `none | expanded | collapsed`.

## Checklist

### scan.ts

- [x] `<base>.worktrees` always emits a group node — id `<base>.worktrees` (path
      relative to root), name `<base>.worktrees` (the real directory name, no
      `(missing primary)` suffix), `kind: "group"`, `selectable: false` — at the
      same depth as `<base>`.
- [x] Its worktree children keep their real ids (`<base>.worktrees/<name>`) and
      set `primaryId` to the sibling primary's id when that primary exists.
- [x] When no sibling `<base>` project exists: each worktree keeps
      `selectable: false` and `MISSING_PRIMARY_WARNING`, and the group node
      carries `MISSING_PRIMARY_WARNING` too.
- [x] Project nodes no longer receive worktree children — `Node.children` on a
      project is always empty.
- [x] `depth` is filesystem nesting for every node: a worktree group sits at its
      parent's depth, its worktrees one deeper. The separate `displayDepth`
      parameter collapses into the existing depth tracking.
- [x] A `.worktrees` directory with no subdirectories is still skipped entirely.
- [x] Worktree groups remain exempt from the `maxDepth` prune (they sit beside a
      primary that is already in range); plain groups keep the existing prune.
- [x] Sort order is unchanged: all nodes at a level by name, so `iris` precedes
      `iris.worktrees`.
- [x] Update the file header comment — it currently documents the re-parenting.

### tui/state.ts

- [x] `Fold` becomes `"none" | "expanded" | "collapsed"`; the doc comment loses
      `x`.
- [x] `foldFor` returns `expanded`/`collapsed` when the node has children, else
      `none`.
- [x] `markerFor` returns `"none"` when the row cannot be checked: a group with
      no selectable descendants, or a non-group with `selectable === false`. A
      node in `derived.auto` still shows `"auto"` even when not selectable,
      because it really is mounted.
- [x] Skill rows with warnings get `marker: "none"` and `fold: "none"`.
- [x] `initialState` starts with `expanded` empty, then adds every ancestor of
      an id in `init.selection`.
- [x] `rescanned` keeps the user's expansion set, restricted to nodes that still
      have children. It no longer auto-expands nodes it has not seen before;
      `hadNode` goes away.

### tui/render.ts

- [x] `FOLDS` drops `blocked`: `{ none: " ", expanded: "v", collapsed: ">" }`.

### README.md

- [x] Redraw the interactive-tree example with the folder-tree shape, a
      collapsed group, and the checkbox-less rows.
- [x] Marker table: drop the `x` row; state that a blank checkbox column means
      not selectable and that `v`/`>` are only ever fold state.
- [x] "Layout it expects": `<base>.worktrees` is shown as its own folder next to
      `<base>`.
- [x] Keep the worktree-closure paragraph (`[~]`, primary auto-mounted, not a
      workspace folder) — that behavior is unchanged.
- [x] Note that the tree opens collapsed except along the path to the current
      selection.

## Validation

- [x] `cd devc-tui && deno task check` passes.
- [x] `cd devc-tui && deno task test` passes.
- [ ] ~~`deno fmt --check` passes.~~ **Dropped, pre-existing.** There is no
      `fmt` config in `deno.json`, so `deno fmt` defaults to 80 columns while
      the codebase is written at ~100. 26 of 32 files fail, including ones this
      change never touched (`jsonc_edit.ts`, `diff.ts`, `tui/keys.ts`). Making
      this pass means reformatting the whole tool — a separate decision, not
      part of this change.
- [x] scan: for a root with `projecta/.git` and
      `projecta.worktrees/some-feature`, the top-level node names are exactly
      `["projecta", "projecta.worktrees"]`; `projecta` has no children;
      `projecta.worktrees` has one child with id
      `projecta.worktrees/some-feature`, `primaryId === "projecta"`,
      `selectable === true`.
- [x] scan: with `orphan.worktrees/x` and no `orphan` project, the group is
      named `orphan.worktrees`, carries `MISSING_PRIMARY_WARNING`, and its child
      is not selectable.
- [x] scan: depths are `0` for `projecta` and `projecta.worktrees`, `1` for the
      worktree.
- [x] model: `derive` output for a selected worktree is unchanged — the worktree
      is a folder entry and its primary is a mount with `auto: true`.
- [x] state: `initialState` with an empty selection produces rows for top-level
      nodes only — no row has depth > 0.
- [x] state: `initialState` with `projecta.worktrees/some-feature` selected
      yields a visible row for that worktree (its parent group auto-expanded),
      while an unrelated sibling group stays collapsed.
- [x] state: no row anywhere in `visibleRows` has `fold === "blocked"` (the
      variant no longer exists); the workspace-dir node and an orphaned worktree
      both have `marker === "none"`.
- [x] state: pressing `right` on a collapsed group reveals its children; `left`
      folds it back.
- [x] render: with colour off, a frame containing a collapsed group and a
      non-selectable row contains no `x` in the fold column, and the
      non-selectable row shows three spaces where the checkbox goes.
- [x] TUI session test (`tests/tui_app_test.ts`) still ends with files
      byte-identical to the equivalent `devc-tui select` — expanding is now an
      explicit step in the scripted keys.
- [x] `devc-tui list` still prints every project and worktree with its full id.

## Relevant Files

| File                                | Change                                                            |
| ----------------------------------- | ----------------------------------------------------------------- |
| `devc-tui/scan.ts`                  | worktree groups become real nodes; unified depth; header comment  |
| `devc-tui/tui/state.ts`             | `Fold` union, `foldFor`, `markerFor`, `initialState`, `rescanned` |
| `devc-tui/tui/render.ts`            | `FOLDS` map                                                       |
| `devc-tui/README.md`                | tree example, marker table, layout section, collapse note         |
| `devc-tui/tests/scan_test.ts`       | new tree shape, depths, orphan group                              |
| `devc-tui/tests/model_test.ts`      | _no change needed — it addresses nodes by id, not position_       |
| `devc-tui/tests/cli_test.ts`        | _no change needed — `list` output is not asserted positionally_   |
| `devc-tui/tests/tui_state_test.ts`  | collapsed default, markers, folds, navigation                     |
| `devc-tui/tests/tui_render_test.ts` | fold glyphs, blank checkbox column                                |
| `devc-tui/tests/tui_app_test.ts`    | one fewer `down` to reach `projecta` in scripted sessions         |
| `.plans/PLAN.md`                    | register, then close out                                          |

`devc-tui/model.ts`, `devc-tui/cli.ts`, `devc-tui/jsonc_edit.ts` and the fence
contract are deliberately untouched.
