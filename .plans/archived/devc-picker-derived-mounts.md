# devc picker derived mounts — show the auto-added primary `.git` in the picks list

## Problem

`devc config` auto-adds a bind mount of a picked worktree's **primary repo `.git`** when the
worktree uses relative paths and the primary lives under the same code root. Today that mount is
computed in `buildSourceRows` *after* the source picker closes, so the first time the user sees it
is the Review block on the confirmation page. From inside the picker it looks like ticking a
worktree mounts one folder, and then a second mount appears out of nowhere.

## Goal

The implied primary `.git` mount appears in the picker's `Source Folders` list as soon as its
worktree is picked (including for worktrees pre-ticked from an existing config), marked as a given
rather than a choice. It cannot be unticked while a worktree requiring it is picked; unpicking the
last such worktree removes it.

## Decisions

- **Marker and inertness reuse the pinned row's convention.** The pinned project folder is already
  a `◎` row that the picks cursor skips (`selCursor` indexes `selected` only, and `selected` never
  contains the pin). Derived rows get the same treatment: `◎`, a trailing note, and no cursor. This
  *is* the "can't be unchecked" requirement — there is no keystroke that can target the row — and it
  needs no refuse-with-a-message path.
- **Derived rows are listed under the pick that requires them**, not grouped at the end, so the
  cause is adjacent to the effect. This is why `DerivedEntry` carries an `owner`.
- **The picker stays generic.** It knows nothing about worktrees: a new `PickerOptions.derive`
  callback maps the current picks to `DerivedEntry[]`, and `config_flow` supplies the worktree
  implementation. Same split as the existing `annotate` callback.
- **`derive` runs in the loop, not the reducer** (the reducer stays pure and sync). The loop calls it
  once before the first paint and again after any key that changed `state.selected` — at most one
  probe pass per toggle keystroke, a stat + read per pick.
- **One source of truth for which primaries get mounted.** A new `impliedPrimaryMounts` in
  `worktree.ts` is used by *both* `buildSourceRows` (what gets written) and the picker's `derive`
  (what gets shown), so the picker cannot disagree with the review block or the fence.
- **A derived path is absorbed if it is also a pick.** `devc` writes derived mounts into the same
  fence as picked ones, so reopening a config preselects the primary `.git` it wrote last time and
  then derives it again — the list showed the path twice, once removable and once not.
  `setDerived` drops any pick a derived entry covers (clamping `selCursor`, and dropping focus out of
  the picks pane if it empties), so it collapses to the single inert row. The absorbed pick's fate is
  then tied to its worktree: unpicking the worktree drops the mount rather than leaving the old row
  behind. The fence is unaffected — `buildSourceRows` emitted that target from
  `impliedPrimaryMounts` anyway, and the pick was being dropped as a duplicate target (with a
  spurious "already in use" warning) before it ever reached the config.
- **The tree view marks derived paths too.** `◎` + the note, and `toggle` refuses them, exactly like
  the pin — otherwise `space` on `.git/` in the browser silently re-adds a pick that `setDerived`
  absorbs right back.
- **The tree view is otherwise unchanged.** A primary repo's *working tree* stays a normal `◯` entry:
  only its `.git` is implied, and picking the whole working tree is a different, legitimate mount
  that supersedes the `.git` one (existing behavior).
- **Out of scope:** the pinned project folder is not fed to `impliedPrimaryMounts`, so a project that
  is itself a worktree still gets no primary `.git` mount. That is pre-existing behavior and a
  separate change (it would alter what is written, not just what is shown).

## Contract

- `worktree.ts` exports:
  - `interface ImpliedPrimaryMount { owner: string; gitDir: string; target: string }`
  - `impliedPrimaryMounts(paths: string[], codeRoots: string[], fs: FsProbe): Promise<ImpliedPrimaryMount[]>`
    — one entry per distinct `target`; `owner` is the first path in `paths` that requires it. Skips
    non-worktrees, invalid worktrees, and primaries whose working tree is itself in `paths`.
- `tui/folder_picker.ts` exports:
  - `interface DerivedEntry { path: string; owner: string; note: string }`
  - `setDerived(state: PickerState, derived: DerivedEntry[]): PickerState`
  - `PickerState.derived: DerivedEntry[]` (starts `[]`)
  - `PickerOptions.derive?: (selected: string[]) => Promise<DerivedEntry[]>`
- Rendered row for a derived entry, directly below its owner pick, same indentation as a pick row:
  `   ◎ <path>  <note>`
- The note `config_flow` supplies: `required by worktree <basename-of-owner>`.
- `selected` (the picker's return value) never contains a derived path — the mount reaches the
  config through `buildSourceRows`, exactly as it does today. **The written fence contents do not
  change at all**; this is a display change plus a shared-helper refactor.

## Checklist

- [x] `impliedPrimaryMounts` + `ImpliedPrimaryMount` in `devc/worktree.ts`
- [x] `buildSourceRows` in `devc/tui/config_flow.ts` rebuilt on `impliedPrimaryMounts`, preserving
      current row order (each source row followed by the primaries it drags in) and dup handling
- [x] `DerivedEntry`, `PickerState.derived`, `setDerived`, `PickerOptions.derive` in
      `devc/tui/folder_picker.ts`
- [x] Picker loop calls `derive` before the first paint and after every selection change
- [x] `render` interleaves derived rows under their owner; the picks window (`cap`/`shown`/`… and N
      more`) counts them, and centering follows the row holding the cursor
- [x] `config_flow` passes `derive` to the source picker (worktree-backed, with the note above)
- [x] Tests: `impliedPrimaryMounts` (shared primary, primary picked, invalid worktree)
- [x] Tests: picker render + inertness (derived row shown under its owner, cursor skips it, removing
      the owner is what removes it)
- [x] Tests: the flow shows the derived row for a worktree pre-ticked from an existing config
- [x] `.plans/design/devc-design.md` Step 2 documents the derived row
- [x] `.plans/design/wizard/workspace-config.txt` mockup shows a derived row

## Validation

- [x] `deno test -A devc/` — all suites pass
- [x] `deno check devc/main.ts` clean
- [x] `deno fmt --check devc/` clean (or the touched files match their existing style)
- [x] A picked valid worktree adds exactly one `◎ .../.git  required by worktree <name>` row under
      it in `Source Folders`
- [x] Two worktrees of one primary show that row **once**, under the first of them
- [x] Picking the primary's working tree as well removes the derived row (the whole tree is mounted)
- [x] An absolute-path (invalid) worktree adds no derived row and still shows `⚠ primary not mounted`
- [x] The picks cursor (`tab`, then `↑`/`↓`) lands only on `◉` rows; `space`/`⌫` on the list never
      removes a `◎` row
- [x] Unticking the worktree in the browser removes its derived row from the picks
- [x] A worktree pre-ticked from an existing `devc:source` fence shows its derived row on the first
      frame, before any keypress
- [x] The applied `devc:source` fence is byte-identical to what the same picks produced before this
      change
- [x] A fence carrying *both* a worktree and its primary `.git` collapses to one `◎` row, still
      writes both mounts, and no longer reports a skipped duplicate target
- [x] `space` on a derived path in the browser is a no-op, and the browser marks it `◎` with its note

## Relevant Files

- `devc/worktree.ts` — new `impliedPrimaryMounts` helper
- `devc/tui/folder_picker.ts` — derived entries: state, option, reducer-adjacent plumbing, render
- `devc/tui/config_flow.ts` — supply `derive`; `buildSourceRows` on the shared helper
- `devc/tests/worktree_test.ts` — `impliedPrimaryMounts` cases
- `devc/tests/folder_picker_test.ts` — derived-row render + inertness
- `devc/tests/config_flow_test.ts` — preselected-worktree derived row; existing worktree fence tests
  must stay green unchanged
- `.plans/design/devc-design.md` — Step 2 wording
- `.plans/design/wizard/workspace-config.txt` — screen mockup
