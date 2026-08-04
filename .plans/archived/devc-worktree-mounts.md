# devc worktree-aware bind mounts

Fix two `devc config` bind-mount gaps: (1) source targets kept only the folder basename, losing the sub-path under a configured code root; (2) git worktrees weren't self-contained in the container because their primary repo's `.git` wasn't mounted. The wizard now keeps the root-relative sub-path (`~/code/a/b` → `/workspaces/a/b`) and, for a picked worktree, also mounts the primary repo's `.git` at the mirror location — but only when the worktree uses relative paths and the primary lives under the same root. Unsafe worktrees are flagged live in the folder picker and skip the primary mount (the worktree folder is still mounted).

## Checklist

- [x] `devc/posix.ts`: extracted `dirnamePosix`/`basenamePosix`/`isAbsolutePosix`/`resolvePosix` from `container.ts`; `container.ts` imports them
- [x] `devc/worktree.ts`: `longestRootAncestor`, `FsProbe`/`realFsProbe`, `WorktreeInfo`, `resolveWorktree` (pure, reads the worktree `.git` file — no git subprocess)
- [x] `mounts.ts`: `defaultTarget`/`rowForHostPath` take an optional `root` and emit the root-relative source target (skills unchanged; basename fallback when no root matches)
- [x] `tui/folder_picker.ts`: `EntryFlag`, `PickerOptions.annotate`, `PickerState.flags`, `setFlags`, listing clears/loads flags, `render` draws the single-line `⚠` marker
- [x] `tui/config_flow.ts`: `buildSourceRows` (relative targets + valid primary `.git` mounts, both dedupes, primary-already-picked skip); annotate wired into the source picker only; `FlowDeps.fsProbe` injection
- [x] `deno.json` `check` task lists `posix.ts` + `worktree.ts`
- [x] Tests added: `tests/worktree_test.ts`; extended `mounts_row_test.ts`, `config_flow_test.ts`, `folder_picker_test.ts`

## Validation

- [x] `deno task check` passes
- [x] `deno task test` passes (126 tests, incl. all pre-existing suites)
- [x] `deno task build` compiles the `devc` binary
- [x] `resolveWorktree`: plain repo / submodule → not a worktree; relative-under-root → valid + `primaryGitTarget === /workspaces/myproject/.git`; absolute paths → invalid ("worktree uses absolute paths"); primary/no root outside → invalid ("primary repo is outside the configured roots")
- [x] `defaultTarget`/`rowForHostPath`: nested-under-root ⇒ `/workspaces/<rel>`; no-root ⇒ basename; skills always basename
- [x] config flow: valid worktree adds the `…/myproject/.git → /workspaces/myproject/.git` row; absolute worktree adds no primary row but still mounts the worktree; two worktrees of one primary ⇒ one primary row; picking the primary working tree too ⇒ no separate `.git` row
- [x] picker: an entry flagged `{worktree:true, valid:false}` renders the `⚠` marker + reason; valid/plain entries carry none

## Relevant Files

- `devc/posix.ts` — new: extracted posix path helpers
- `devc/worktree.ts` — new: worktree resolution + root matching
- `devc/container.ts` — imports posix helpers (local copies removed)
- `devc/mounts.ts` — `defaultTarget`/`rowForHostPath` gain optional `root`
- `devc/tui/folder_picker.ts` — annotation plumbing + `⚠` render
- `devc/tui/config_flow.ts` — `buildSourceRows`, annotate wiring, `FlowDeps.fsProbe`
- `devc/deno.json` — `check` task
- `devc/tests/worktree_test.ts` — new; `devc/tests/{mounts_row,config_flow,folder_picker}_test.ts` — extended
