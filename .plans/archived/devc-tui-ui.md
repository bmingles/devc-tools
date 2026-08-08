# devc-tui interactive UI — checkbox project tree

## Context

[devc-tui-core](devc-tui-core.md) delivers the scan, selection model,
fenced-block file surgery, and a headless CLI. This plan adds the interactive
terminal UI that the tool is named for: a scrollable folder tree with checkboxes
for projects, worktrees, and agent skill folders, writing through the **same**
`apply` path as the CLI. **No new file-writing logic is introduced here** — the
UI only produces a selection set and calls into `model.ts` / `devcontainer.ts` /
`workspace.ts`.

As in the core plan: devc-tui runs on the **host**, in whatever arbitrary repo
the user `cd`s into. This repo is never the target, and no test may touch it —
every test builds its own `Deno.makeTempDir()` workspace.

Stack: zero dependencies beyond `jsr:@std/path` — raw mode + ANSI, matching
devc-bridge's minimal-dependency style. A checkbox tree needs nothing heavier,
and owning the renderer is what makes the tri-state/scroll/filter UX below
precise.

The UI is split into a **pure core** (`visibleRows`, `reduce`, `render` — no IO,
no terminal) and a thin **shell** (`app.ts` — raw mode, alt screen, input
decoding). Everything interesting is therefore testable with `deno test` inside
this devcontainer; only the visual polish needs a human.

## Design

### Screen layout

80×24 example. ASCII-only — no box-drawing or ambiguous-width glyphs, so column
math is always byte-accurate.

```
 devc-tui  ~/src -> /workspaces            7 mounts  4 folders  2 skills   *unsaved
                                                                                  |
 PROJECTS                                                                         |
   v [x] projecta                                                                 #
       [ ] some-feature                                                           #
   v [~] projectb                              (required by worktree)             |
       [x] some-other                                                             |
       [ ] yet-another                      ! absolute gitdir                     |
   > [-] org                                                                      |
   x [ ] orphan (missing primary)                                                 |
                                                                                  |
 SKILLS  ~/.claude/skills -> /home/vscode/.claude/skills                          |
       [x] deephaven-docs                                                         |
       [ ] marp-writing                                                           |

 wrote .devcontainer/devcontainer.json, myapp.code-workspace
 up/down move  space toggle  right/left fold  / filter  a all  n none  w write  q quit
```

- **Header** (row 1): tool name, `root -> containerRoot`, live counts of derived
  project mounts / workspace folders / enabled skills, and `*unsaved` when the
  in-memory selection differs from what is on disk.
- **Body**: one scrolling list containing both sections. Section headers
  (`PROJECTS`, `SKILLS`) are rows but are not focusable.
- **Message line** (row `rows-1`): last action result, error, or the active
  filter/confirm prompt. Empty otherwise.
- **Keys line** (row `rows`): static, dimmed. Switches to the context-specific
  set while in filter or confirm mode.
- **Scrollbar**: the last column shows `|` for the track and `#` for the thumb,
  only when the body overflows.

### Row markers

| Marker                       | Meaning                                                                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `[ ]`                        | not selected                                                                                                                    |
| `[x]`                        | explicitly selected                                                                                                             |
| `[~]`                        | not explicitly selected, but mounted because a selected worktree needs its primary repo                                         |
| `[-]`                        | group node: some but not all selectable descendants are selected                                                                |
| `x` in the fold column       | not selectable (orphan worktree, or the node for the current workspace dir)                                                     |
| `v` / `>` in the fold column | expanded / collapsed group or project with worktrees                                                                            |
| `! absolute gitdir`          | worktree whose `.git` holds an absolute `gitdir:` — commits will break once mounted; run `git worktree repair --relative-paths` |
| `(required by worktree)`     | shown on an `[~]` primary                                                                                                       |
| `(workspace)`                | the current workspace dir's own node; already mounted by the devcontainer, never emitted                                        |

The cursor row is rendered in reverse video. When color is enabled, `[x]` is
green, `[~]` is yellow, warnings are red, and hints are dim; `NO_COLOR` or
`--no-color` drops all of it and the layout is unchanged.

### Keybindings

| Key                       | Action                                                |
| ------------------------- | ----------------------------------------------------- |
| `up` / `k`, `down` / `j`  | move cursor (skips section headers)                   |
| `PgUp` / `PgDn`           | move one body-height                                  |
| `Home` / `g`, `End` / `G` | first / last focusable row                            |
| `space` or `Enter`        | toggle the row under the cursor                       |
| `right` / `l`             | expand; on a leaf, no-op                              |
| `left` / `h`              | collapse; on a leaf or collapsed node, jump to parent |
| `Tab`                     | jump to the next section header's first row           |
| `/`                       | enter filter mode                                     |
| `a`                       | select every selectable row currently visible         |
| `n`                       | deselect every selectable row currently visible       |
| `r`                       | rescan the root, preserving the selection by id       |
| `w`                       | write both files                                      |
| `?`                       | toggle the help overlay                               |
| `q`                       | quit; if unsaved, opens the save confirm              |
| `Ctrl-C`                  | quit immediately, writing nothing                     |

Toggle semantics:

- **Project / worktree / skill** — flip explicit selection.
- **Group** — if every selectable descendant is selected, deselect them all;
  otherwise select them all.
- **`[~]` primary** — `space` makes it explicit (`[x]`). `space` again returns
  it to `[~]`, not `[ ]`, while a selected worktree still requires it; the
  message line explains why once.

**Filter mode**: `/` opens a prompt on the message line. Typing filters rows by
case-insensitive substring on the node id; ancestors of matches stay visible,
and matching nodes are auto-expanded. `Enter` keeps the filter active and
returns to navigation; `Esc` clears the filter. `a` / `n` while a filter is
active act on the filtered set only — this is the intended bulk-select path.

**Confirm mode**: `w` when a target file must be created, and `q` while unsaved,
both open a `y/n` (or `y/n/c` for quit) prompt on the message line. Any other
key cancels.

### Terminal shell — `tui/term.ts`, `tui/keys.ts`, `tui/app.ts`

- Refuse to start when `!Deno.stdin.isTerminal()`: exit 2 with
  `devc-tui: not a terminal; use "devc-tui list" / "devc-tui select ..." instead`.
- Enter: `Deno.stdin.setRaw(true)`, alt screen `\x1b[?1049h`, hide cursor
  `\x1b[?25l`. Leave (in a `finally`, and from `SIGINT`/`SIGTERM` handlers):
  show cursor `\x1b[?25h`, `\x1b[?1049l`, `setRaw(false)`. A thrown error must
  still restore the terminal before its message is printed.
- Size from `Deno.consoleSize()` on every paint;
  `Deno.addSignalListener("SIGWINCH", …)` triggers a repaint. Below 40 columns
  or 10 rows, paint only `terminal too small (need 40x10)`.
- Paint: build exactly `rows` lines, each truncated to `columns`, and write
  `\x1b[H` + lines joined by `\x1b[K\r\n` + trailing `\x1b[K`. Full repaint per
  keystroke — the frame is a few KB, flicker is not a concern at this size.
- Input: iterate `Deno.stdin.readable`, feed bytes into a decoder that **buffers
  across chunks** (an escape sequence can be split). Decodes `\x1b[A/B/C/D`
  arrows, `\x1b[5~`/`\x1b[6~`, `\x1b[H`/`\x1b[F`/`\x1b[1~`/`\x1b[4~`, `\r`/`\n`,
  `\x7f`, `\t`, `\x03`, and printable ASCII. Gotcha: a lone `\x1b` is ambiguous
  with the start of a sequence — resolve it as `Escape` only when the chunk is
  exhausted and no continuation byte follows.

`runApp` takes its IO injected —
`{ input: ReadableStream<Uint8Array>, output:
WritableStream<Uint8Array>, size: () => {columns, rows}, raw?: boolean }`
— so an integration test can pipe a scripted key sequence and assert on both the
emitted frames and the files written, with no TTY involved.

### Pure core — `tui/state.ts`, `tui/render.ts`

- `UiState` — scan tree, explicit selection set, expanded-node set, cursor id,
  scroll offset, mode (`nav` | `filter` | `confirm` | `help`), filter text,
  pending message, dirty flag, baseline selection (for the dirty check).
- `visibleRows(state): Row[]` — flattens tree + skills into display rows
  honoring expansion, filter, and section headers. Pure.
- `reduce(state, key): { state, effect? }` — pure; the only effects are `write`,
  `rescan`, and `quit`, which `app.ts` performs.
- `render(state, size): string[]` — pure; returns exactly `size.rows` lines.

Scrolling is recomputed inside `reduce` with a 2-row margin so the cursor is
never on the first or last body row unless at the list's end.

### Wiring

`main.ts` with no subcommand launches the TUI (replacing the current
usage-and-exit-2). All existing subcommands keep working unchanged. On `w`, the
UI calls the same `applySelection()` used by `devc-tui apply`, then refreshes
the baseline selection and prints the changed paths on the message line.

## Checklist

- [x] `devc-tui/tui/state.ts` — `UiState`, `initialState()`, `visibleRows()`,
      `reduce()`, toggle semantics (leaf / group / `[~]` primary), scroll-offset
      recomputation, filter and confirm modes.
- [x] `devc-tui/tui/render.ts` — `render(state, size)` → `string[]`; header,
      sections, rows, markers, warnings, scrollbar, message line, keys line,
      help overlay, too-small fallback; `NO_COLOR` / `--no-color` honored.
- [x] `devc-tui/tui/keys.ts` — chunk-buffering byte→`Key` decoder covering the
      sequences listed above, including the lone-`\x1b` disambiguation.
- [x] `devc-tui/tui/term.ts` — raw mode, alt screen, cursor hide/show, size +
      `SIGWINCH`, paint helper, guaranteed restore on throw and on
      `SIGINT`/`SIGTERM`.
- [x] `devc-tui/tui/app.ts` — `runApp(deps)` with injectable IO; input loop,
      effect handling (`write` → `applySelection()`, `rescan` → re-scan
      preserving selection by id, `quit`), non-TTY refusal.
- [x] `devc-tui/cli.ts` / `devc-tui/main.ts` — export `applySelection()` for
      reuse; no-args now launches the TUI; usage text lists the TUI as the
      default.
- [x] `devc-tui/tests/tui_state_test.ts`, `tests/tui_render_test.ts`,
      `tests/tui_keys_test.ts`, `tests/tui_app_test.ts` — new.
- [x] `devc-tui/README.md` — add a keybindings table and a screen-layout sample.

## Validation

- [x] `deno check devc-tui/tui/*.ts` clean; `deno task test` all green.
- [x] **keys.** Decoder tests: each arrow, `PgUp`/`PgDn`, `Home`/`End`, `Enter`,
      `Tab`, backspace, `Ctrl-C`, and printable chars. An escape sequence
      delivered **split across two chunks** (`\x1b[` then `A`) decodes as one
      `up`. A lone `\x1b` with no continuation decodes as `Escape`.
- [x] **state, navigation.** From the fixture tree of
      [devc-tui-core](devc-tui-core.md#validation): `down`×N never lands on a
      section header; `End` lands on the last focusable row; `left` on a leaf
      moves to its parent; `right` on a collapsed node expands it.
- [x] **state, toggle.** `space` on `projectb.worktrees/some-other` selects it
      and makes `projectb` report `[~]`; `space` on `projectb` makes it `[x]`;
      `space` again returns it to `[~]` (not `[ ]`) and sets the explanatory
      message.
- [x] **state, group toggle.** `space` on the `org` group selects all its
      selectable descendants; again deselects all; with one descendant selected
      the group renders `[-]`.
- [x] **state, filter.** `/` + `some` shows only matching worktrees plus their
      ancestors, auto-expanded; `a` selects exactly the filtered matches and
      nothing else; `Esc` clears the filter and the selection is unchanged.
- [x] **state, dirty.** Dirty is false at start, true after a toggle, false
      again after a `write` effect, and false after toggling back to the
      baseline selection.
- [x] **render.** `render()` returns exactly `size.rows` lines, none exceeding
      `size.columns` (measured with ANSI stripped), for 80×24, 120×40, and
      40×10. At 39 columns it returns the too-small message. The scrollbar thumb
      appears only when rows exceed the body height, and the cursor row is the
      only reverse-video row.
- [x] **render, no-color.** With `NO_COLOR=1` the output contains no `\x1b[`
      sequences other than the ones the paint helper adds, and line content
      matches the colored variant with ANSI stripped.
- [x] **app, scripted end-to-end** (no TTY): `runApp` over a temp workspace dir
      with injected input `down down space w q`, and assert that the
      devcontainer and workspace files end up **byte-identical** to running
      `devc-tui select <that id>` from the CLI — proving the UI and CLI share
      one write path.
- [x] **app, abort.** Injected `space` then `Ctrl-C` leaves both target files
      unmodified.
- [x] **app, non-TTY.** Launching the TUI with a non-terminal stdin exits 2 with
      the documented message.
- [ ] (user, host) Real terminal: tree renders correctly,
      arrows/space/`/`/`w`/`q` behave, resizing repaints cleanly, and the
      terminal is fully restored after `q`, after `Ctrl-C`, and after an induced
      exception (cursor visible, normal screen, echo on).

## Relevant Files

- `devc-tui/tui/state.ts` — new: `UiState`, `visibleRows`, `reduce`
- `devc-tui/tui/render.ts` — new: pure frame renderer
- `devc-tui/tui/keys.ts` — new: byte→key decoder
- `devc-tui/tui/term.ts` — new: raw mode, alt screen, size, paint, restore
- `devc-tui/tui/app.ts` — new: `runApp(deps)`, input loop, effects
- `devc-tui/main.ts` — no-args launches the TUI; usage text update
- `devc-tui/cli.ts` — export `applySelection()` for the UI to reuse
- `devc-tui/tests/tui_state_test.ts`, `tests/tui_render_test.ts`,
  `tests/tui_keys_test.ts`, `tests/tui_app_test.ts` — new
- `devc-tui/README.md` — keybindings + layout sample
- `.plans/PLAN.md` — status index entry
