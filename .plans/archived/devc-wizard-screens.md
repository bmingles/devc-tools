# devc wizard screens — chrome revamp

Re-skin the folder-picker screens to the mockups in `.plans/design/wizard/` (`workspace-config.txt`,
`skills-config.txt`, `global-workspace-roots-config.txt`, `global-skills-root-config.txt`). These
mockups **supersede** the sidebar/step-table wizard described in `.plans/design/devc-design.md`
§"Wizard layout" and Steps 1–4, and supersede the current `? title` / `SELECTED` / `BROWSE`
chrome.

No change to the flow, the state machine, the keymap, or what gets written to disk — this is the
frame around the two lists, plus the labels each call site supplies.

## Target frame

```text
WORKSPACE CONFIG
(blank)
 Source Folders
(blank)
   ◎ ~/code/app                     this project (always mounted)
   ◉ ~/code/lib
(blank)
 Add Source Folders  ~/code/
  > type to filter folders
 ▸ ◯ _timespent/
   ◯ apps/
   … (browser fills the remaining rows)
────────────────────────────────────────────────────────────── (full width)
 space pick · → open · ← up · ↑ into selected · ⏎ done · esc cancel
```

Changes from today, each visible in the mockups:

1. **Screen banner** on line 1, column 0, uppercase, bold: `WORKSPACE CONFIG` / `GLOBAL CONFIG`.
   Replaces the ` ? <title>` question line.
2. **Section headings** in Title Case at indent 1, replacing the `SELECTED  n picked` /
   `BROWSE  <cwd>/` panel headers. The count meta is dropped; the browse heading keeps the
   current directory as dim meta (`Add Source Folders  ~/code/`).
3. **Blank-line separation** between banner / picks heading / picks rows / browse heading. The
   mid-frame divider between the two lists is **removed** — the only rule is the one above the
   footer legend.
4. **Filter line** becomes `  > <text>`, placeholder `  > type to filter folders` when empty
   (both dim), replacing `  filter: (type to narrow)`.
5. **Pinned marker** `◎` (was `◍`), keeping its dim note.
6. Empty picks list shows `  (none yet)`; when a pinned row is present it stands alone with no
   placeholder line (the mockups show no "nothing picked" text).

Per-screen labels (verbatim from the mockups):

| Screen | Banner | Picks heading | Browse heading |
| --- | --- | --- | --- |
| project source | `WORKSPACE CONFIG` | `Source Folders` | `Add Source Folders` |
| project skills | `WORKSPACE CONFIG` | `Skills` | `Add Skills` |
| global code roots | `GLOBAL CONFIG` | `Source Folder Roots` | `Add Roots` |
| global skills roots | `GLOBAL CONFIG` | `Skills Folder Roots` | `Add Roots` |

## Decisions

- `PickerOptions.title: string` is **replaced** by `labels: PickerLabels`
  (`{ screen, picks, browse }`) — the three strings are per-screen copy, not derivable. Same
  position in `initialState(cwd, color, preselected, roots, labels, pinned)`; `PickerState.title`
  becomes `PickerState.labels`.
- At the synthetic roots list (`atRoots`), the browse heading shows **no** meta — `Add Roots`
  alone, since there is no current directory.
- The footer legend, keymap, focus model, and pinned semantics are unchanged (`↑ into selected`
  still appears only when there is a pick to step into).
- Inline steps (the `Configuring …` lines, review block, `Apply?`, rebuild prompt) are **not**
  part of this change — the mockups only cover the full-screen picker.

## Checklist

- [x] `tui/folder_picker.ts`: add `PickerLabels`, swap `title` → `labels` in `PickerState`,
      `initialState`, and `PickerOptions`.
- [x] `tui/folder_picker.ts`: re-render the frame per "Target frame" (banner, headings, blank
      lines, no mid divider, `>` filter line, `(none yet)`).
- [x] `tui/folder_picker.ts`: pinned marker `◍` → `◎` in both the picks list and the tree.
- [x] `tui/folder_picker.ts`: update the module header comment (it documents the old two-panel
      `SELECTED`/`BROWSE` chrome).
- [x] `tui/config_flow.ts`: pass the four label sets from the table above.
- [x] `tests/folder_picker_test.ts`: update frame assertions to the new chrome; add a banner +
      section-heading assertion and a filter-placeholder assertion.
- [x] `devc/README.md`: update the `devc config` picker description (glyph + screen wording).
- [x] `.plans/design/devc-design.md`: replace §"Wizard layout" and the Step 1–4 descriptions
      (sidebar, mount tables, Add/Remove, per-row editing) with the picker-driven flow these
      mockups describe.

## Validation

- [x] `cd devc && deno task check` — passes.
- [x] `cd devc && deno task test` — all suites pass.
- [x] Frame snapshot matches the mockups: rendering the project source picker with one pinned
      folder + one pick produces, in order, `WORKSPACE CONFIG`, blank, ` Source Folders`, blank,
      `   ◎ …`, `   ◉ …`, blank, ` Add Source Folders  ~/code/`, `  > type to filter folders`,
      then the tree — with exactly one divider, immediately above the legend.
- [x] `grep -R "SELECTED\|BROWSE\|filter: (type to narrow)" devc/tui devc/tests devc/README.md`
      returns nothing.
- [x] `cd devc && deno task build` — the binary still compiles.

## Relevant Files

- `devc/tui/folder_picker.ts` — state labels + the whole `render` frame.
- `devc/tui/config_flow.ts` — the four `pickFolders` call sites supply the labels.
- `devc/tests/folder_picker_test.ts` — frame assertions and `initialState` call sites.
- `devc/README.md` — `devc config` section describing the picker.
- `.plans/design/devc-design.md` — superseded wizard-layout section.
- `.plans/PLAN.md` — status + phase row.
