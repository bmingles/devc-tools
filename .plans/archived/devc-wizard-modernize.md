# devc config — modern sequential wizard

> **Closed 2026-08-05 (shipped).** Phases 1–6 are in `main`; the flow has since been iterated on
> twice (`devc-worktree-mounts`, `devc-wizard-screens`). The one item never formally ticked is
> the manual TTY walkthrough in Validation — it needs a human at a terminal, and the automated
> end-to-end harness covers apply correctness. For the picker's current screens, read
> `.plans/design/wizard/` and `.plans/archived/devc-wizard-screens.md`, not the sketch below.

Replace the full-screen sidebar wizard (mnemonic `N`/`B`/`A` keys) with a modern, discoverable
flow: inline sequential prompts on the normal screen, plus a full-screen **multi-select,
type-to-filter folder picker** for the folder-selection steps. Zero new dependencies — built on
the existing `tui/term.ts` + `tui/keys.ts`, keeping the pure `reduce`/`render` split so
everything stays headless-testable.

## Approach & decisions

- **Zero-dependency.** No cliffy. Confirm + single-line text input are small pure
  `reduce`/`render` prompt primitives on `term.ts`, matching the folder picker's pattern.
- **Folder picker = the folder-selection primitive.** Multi-select, type-to-filter, selection
  persists across directories. Keys: `↑↓` move, `→` open, `←`/backspace up, `space` tick,
  `⏎` done, `esc` cancel. Already prototyped in `tui/folder_picker.ts`; promote to production
  with injectable IO for tests.
- **Flow aesthetic:** inline scrolling prompts (npm-create style) for confirm/edit; the picker
  briefly takes the alternate screen, then returns to the inline flow.
- **Preserve the command contract.** `devc config [PATH]` still configures PATH (default cwd);
  the global-roots step is still prepended on first run when the global config is missing and
  stdin is a TTY; apply still prints `Created`/`Updated <configPath>` (+ Dockerfile/features
  lines when creating). All row → bind-spec serialization stays in `mounts.ts`; apply stays in
  `wizard_apply.ts`; base resolution + seeding logic is relocated (not rewritten) out of the old
  `wizard.ts`.
- **Orchestrator is a thin imperative shell** (like `main.ts`): it wires prompts to the pure
  seed/apply logic. The pure logic (picker, prompts, seeding, apply) is what carries tests.

### Wizard flow (project config)

1. **Overview** — print `Configuring <configPath> (creating|updating)`.
2. **Source folders** — folder picker rooted at the first expanded code root (fallback `$HOME`),
   existing `devc:source` rows pre-ticked. Returns host paths.
3. **Skills folders** — folder picker rooted at the first expanded skills root (fallback
   `$HOME`), existing/recent skills pre-ticked. Returns host paths.
4. **Build rows** — `rowForHostPath(kind, path)` per pick (folds `$HOME`, default target +
   readonly). On a duplicate target within a step, skip the colliding pick and note it (never
   throw at the user).
5. **Review** — print the serialized `devc:source` / `devc:skills` mounts, then a single
   `Apply? (Y/n)` confirm. (No per-row customize — targets/read-only use the defaults.)
6. **Apply** — `applySelection(projectDir, {source, skills})`; print the same messages as today.

Existing rows are **pre-ticked** in the pickers (expanded to absolute paths — handling both
`${localEnv:HOME}` and `~`/`$VAR`). This matters for correctness, not just convenience: apply
replaces the fences with exactly what the pickers return, so un-preserved rows would be wiped.

### Global-roots step (first run)

Picker-driven, **no free text**: pick code-folder root(s) with the folder picker, then skills
root(s). Each selected absolute path is stored folded to `~/…` via `displayPath()` (matching the
config's shell-style storage; `expandPath()` reverses it on read). Save via
`saveGlobalConfig(makeGlobalConfig(...))`. Runs before the project flow when `includeGlobalStep`.
(Power users can still hand-edit `$VAR`-based roots in `config.json`.)

## Checklist

### Phase 1 — Folder picker to production (additive)
- [x] Refactor `tui/folder_picker.ts`: remove the `import.meta.main` demo; expose
      `pickFolders(opts, deps)` with injected `input`/`output`/`size`/`readDir`/`raw` (mirrors
      `WizardDeps`), plus `preselected: string[]` to pre-tick rows and `start: string`.
- [x] Keep pure exports: `initialState`, `visible`, `setListing`, `reduce`, `render`.
- [x] Add `tests/folder_picker_test.ts`: scripted key sequences through `reduce` asserting
      filter narrowing, `→`/`←` navigation via `readDir` effect, `space` toggle persistence
      across dirs, `⏎`→done, `esc`→cancelled; plus a `render` frame assertion (color off).

### Phase 2 — Confirm primitive (additive)
- [x] `tui/prompts.ts`: pure `confirm` (yes/no, default-aware) as a `reduce`/`render` state
      machine, plus a thin `runConfirm(...)` loop with injectable IO. (No text-input — the flow
      is fully picker-driven; customize step dropped.)
- [x] `tests/prompts_test.ts`: scripted confirm sequences (y/n/enter-default/esc).

### Phase 3 — Project flow orchestrator + rewire (additive, then switch)
- [x] `tui/config_flow.ts`: relocate `seedRows` + base-text resolution from `wizard.ts`; run the
      flow above; expose `runProjectConfigWizard(projectDir, io, includeGlobalStep)` with the
      same signature `main.ts` calls today.
- [x] Duplicate-target handling via `assertNoDuplicateTarget` (skip + note).
- [x] Rewire `main.ts` `config` subcommand import to `tui/config_flow.ts` (signature unchanged).

### Phase 4 — Global-roots step + first-run hook
- [x] Add the picker-driven global-roots step to `tui/config_flow.ts` (pick code roots, then
      skills roots; store folded to `~/…` via `displayPath`); expose `runGlobalConfigWizard(io)`
      (same signature `main.ts` calls today).
- [x] Rewire `main.ts` first-run hook + `globalConfigExists` import to `tui/config_flow.ts`.

### Phase 5 — Remove old wizard + housekeeping
- [x] Delete `tui/wizard.ts`, `tui/wizard_state.ts`, `tui/wizard_render.ts`.
- [x] Delete `tests/wizard_state_test.ts`, `tests/wizard_project_state_test.ts`,
      `tests/wizard_render_test.ts`.
- [x] Update `deno.json` `check` file list (drop the three deleted files; add
      `tui/folder_picker.ts`, `tui/prompts.ts`, `tui/config_flow.ts`). `build` needed no change
      (it compiles from `main.ts`, no file list).
- [x] Update `devc/README.md` — replaced the stale "lands in later phases" note with a
      `devc config` section documenting the picker keys + flow.

### Phase 6 — Roots as boundaries + configurable roots (follow-up)
- [x] Picker two modes: free (roam filesystem, select any dir — for configuring roots) and
      bounded (`roots` option: roots are the top-level list, can't navigate above a root, roots
      themselves not selectable). `PickerState` gains `roots`/`atRoots`; `reduce`/`render`/
      `visible` branch on the view; `←` at a root returns to the roots list.
- [x] Project source/skills pickers run in bounded mode over the configured roots; the
      first-run global step and `--global` use free mode.
- [x] `devc config --global` reconfigures roots only, then exits (`main.ts` + `help.ts`).
- [x] No roots configured → `runProjectConfigWizard` runs the roots step first, then proceeds.
- [x] Bounded-mode picker tests (roots list, `→` open, `←` boundary, roots not selectable,
      selection persists) + `config_flow_test` updated to drive bounded pickers.

## Validation
- [x] `cd devc && deno task check` — passes with the new file set.
- [x] `cd devc && deno task test` — 105 pass; retained suites (`mounts_*`, `wizard_apply`,
      `global_config`, `default_config`) unchanged; new `folder_picker_test`, `prompts_test`,
      `config_flow_test` pass.
- [x] Headless flow test: `config_flow_test` injects a scripted key stream + fake `readDir` and
      asserts `apply` receives the expected `source`/`skills` rows (no TTY); also covers
      decline-confirm and Esc-cancel.
- [x] `cd devc && deno task build` — compiles the binary with the new file set.
- [x] End-to-end (real apply, headless): scratch harness ran `runProjectFlow` with the real
      `applySelection` (scratch `globalConfigPath`) → wrote both fences correctly
      (`/workspaces/app`+`/lib` rw, skills `review` ro), infra mounts untouched, Dockerfile +
      features copied. Stronger than the mocked-apply unit test.
- [x] Non-TTY: `echo | deno task run config /tmp/scratch` prints the not-a-terminal message,
      writes nothing, and exits without hanging.
- [ ] Manual (TTY, needs a human at a terminal): `deno task run config <dir>` → picker launches,
      multi-select + type-to-filter feel right, re-running shows existing rows pre-ticked; and
      first-run global step collects roots then continues. (Interactive raw-mode TTY can't be
      driven from the agent; apply correctness is covered by the end-to-end harness above.)

## Relevant Files
- `devc/tui/folder_picker.ts` — promote prototype → production (Phase 1).
- `devc/tui/prompts.ts` — new confirm + text-input primitives (Phase 2).
- `devc/tui/config_flow.ts` — new orchestrator; absorbs `seedRows` + base resolution (Phase 3-4).
- `devc/tui/term.ts`, `devc/tui/keys.ts` — reused unchanged.
- `devc/mounts.ts`, `devc/wizard_apply.ts`, `devc/config.ts`, `devc/jsonc_edit.ts`,
  `devc/default_config.ts` — reused unchanged (imported by the new flow).
- `devc/main.ts` — rewire `config` subcommand + first-run hook imports (Phase 3-4).
- `devc/tui/wizard.ts`, `devc/tui/wizard_state.ts`, `devc/tui/wizard_render.ts` — deleted (Phase 5).
- `devc/tests/folder_picker_test.ts`, `devc/tests/prompts_test.ts`,
  `devc/tests/config_flow_test.ts` — new.
- `devc/tests/wizard_state_test.ts`, `devc/tests/wizard_project_state_test.ts`,
  `devc/tests/wizard_render_test.ts` — deleted (Phase 5).
- `devc/deno.json` — update `check`/`build` file lists (Phase 5).
- `devc/README.md` — update keybinding docs if present (Phase 5).
