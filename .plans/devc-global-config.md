# devc global config + TUI foundation

## Context

See `.plans/design/devc-design.md` → "Global user configuration" and "First-run flow". This phase
adds the global user config (`codeRoots` / `skillsRoots` lists) and the reusable **wizard TUI
shell** that both this phase's global-config editor and the next phase's project wizard build on.
It reuses the kept low-level primitives `devc/tui/term.ts` (raw mode / alt screen / paint) and
`devc/tui/keys.ts` (`KeyDecoder`). The old tree-selector state/render were deleted in
`devc-lifecycle-core`; the wizard state + layout here are new.

### Config contract

- **Path:** `${CONFIG_DIR}/config.json` where `CONFIG_DIR` is the single const defined in
  `devc-lifecycle-core` = `<home>/.config/devc-tui`. The namespace is `devc`; the `-tui` dir is a
  temporary measure (comment already on the const) until the tool replaces existing tooling, when
  it flips to `.config/devc`. Do not hardcode the path anywhere else — import the const.
- **Schema:** `{ "codeRoots": string[], "skillsRoots": string[] }`. Unknown keys preserved on
  rewrite. Missing/invalid file with no TTY → treat as empty lists (do not crash).
- **Path expansion (load-time):** each entry expands a leading `~` / `~/` (→ `$HOME`) and
  `$VAR` / `${VAR}` anywhere; an unset var is an error naming the key. (Reimplement the small
  `expandPath` helper — it was in the now-deleted old `config.ts`; spec: `~`/`~/` only when the
  first char, `$VAR`/`${VAR}` via `/\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g`,
  throw on unset.) Also a `displayPath` helper that collapses `$HOME` → `~` for messages.

### First-run flow

Before dispatching any command, if `config.json` does not exist **and stdin is a TTY**, run the
global-config TUI step, save the file, then continue to the requested command. If not a TTY,
skip silently (lifecycle commands do not need roots; the wizard errors clearly if roots are
needed and absent). `devc config` (re-)opens the editor even when the file exists — for this
phase, `devc config` with no project steps yet opens the **global config editor**; the next phase
turns `devc config [PATH]` into the full project wizard with global config as its first step.

### Wizard TUI shell (reusable)

A step-based interactive shell, driven by injected IO exactly like the deleted tree app (so it is
testable headlessly — see `devc/tests/helpers.ts`). Three regions per design "Wizard layout":
left sidebar (step list, current highlighted), main area (current step's controls), footer
(keybindings). Keys per design footer: `↑/↓` or `Tab/Shift+Tab` focus, `Enter` edit/confirm,
`Space` toggle, `Esc`/Back previous step, `A`/Apply (review step only), `Q`/Cancel quit.

The shell is generic over a list of steps; this phase ships exactly one step (**Global config**).
The state machine, render, and app loop are structured so the next phase adds steps without
touching the shell.

### Global config step

Two editable string-list controls: **Code roots** and **Skills roots**. Actions: **Add** (prompts
for a path via a single-line text input; `~`/`$VAR` accepted, stored raw/unexpanded), **Remove**
(deletes the focused entry), move focus between the two lists and their entries. On Apply/save,
write `config.json` (pretty JSON, unknown keys preserved, trailing newline).

### Gotchas

- **Non-TTY refusal:** the shell must refuse to run raw-mode against a non-TTY with a clear message
  (mirror the deleted app's `NOT_A_TERMINAL` guard) — but the *first-run* path checks TTY first and
  simply skips, so a scripted `devc up` never blocks.
- **Store raw, expand on read:** persist exactly what the user typed (`~/code`), expand only when a
  consumer needs a filesystem path. Round-tripping must not rewrite `~` to an absolute path.
- **term.ts contract:** the terminal is always restored (its `close()` runs from `finally` and
  signal handlers) — do not add exit paths that bypass it.

## Checklist

- [ ] `devc/config.ts` — new global config module: import `CONFIG_DIR`; `expandPath`,
      `displayPath`; `loadGlobalConfig()` → `{ codeRoots, skillsRoots, extra, path }` (raw +
      expanded accessors), `saveGlobalConfig()`, `globalConfigExists()`.
- [ ] `devc/tui/wizard_state.ts` — new: `WizardState`, step model, `reduce(state, key)` →
      `{ state, effect }` with effects `save` / `quit` / `none`; text-input sub-mode for Add.
- [ ] `devc/tui/wizard_render.ts` — new: sidebar/main/footer layout, `render(state, size)`; reuse
      `colorEnabled`/`stripAnsi`/`Size` helpers (re-add minimal versions if they lived only in the
      deleted `render.ts`).
- [ ] `devc/tui/wizard.ts` — new: app loop (own the `Terminal`, feed bytes to `KeyDecoder`, apply
      effects). Injected IO/input/output/size for tests; `raw` off in tests. Export a
      `startWizard(opts, io, deps)` entry.
- [ ] `devc/main.ts` — first-run hook: before command dispatch, if `!globalConfigExists()` and
      stdin is a TTY, run the global-config wizard then continue. Wire `config` subcommand to open
      the global-config editor. `config` added to usage/help.
- [ ] Tests: `devc/tests/global_config_test.ts` (load/save round-trip, unknown-key preservation,
      expansion + unset-var error), `devc/tests/wizard_state_test.ts` (add/remove/focus/save/quit
      via scripted keys), `devc/tests/wizard_render_test.ts` (frame snapshot for a small size).
- [ ] `devc/deno.json` — add the new tui/config files to the `check` task list.

## Validation

- [ ] `cd devc && deno task test` — global-config and wizard-state/render tests pass.
- [ ] `cd devc && deno task check` clean.
- [ ] Load/save round-trip: writing `{codeRoots:["~/code"],skillsRoots:[]}` then reading back
      yields the raw `~/code` (not expanded) and an expanded accessor returns `<HOME>/code`.
- [ ] Scripted `wizard_state` test: Add `~/code` to code roots, Add `~/.agents/skills` to skills
      roots, Apply → emits `save` with the expected lists; `Q` → emits `quit` with no save.
- [ ] Non-TTY: `echo | deno run ... main.ts up .` does **not** launch the wizard (first-run skipped).
- [ ] (user) In a fresh env (no `config.json`), a TTY `devc status` launches the global-config
      step; adding roots + Apply writes `~/.config/devc-tui/config.json`; the command then runs.

## Relevant Files

- `devc/config.ts` — new: global config load/save + path expansion helpers.
- `devc/tui/wizard.ts` — new: app loop / entry point.
- `devc/tui/wizard_state.ts` — new: step state machine + reduce.
- `devc/tui/wizard_render.ts` — new: sidebar/main/footer layout.
- `devc/tui/term.ts`, `devc/tui/keys.ts` — reused unchanged (kept from lifecycle phase).
- `devc/main.ts` — first-run hook + `config` subcommand wiring.
- `devc/tests/{global_config,wizard_state,wizard_render}_test.ts` — new tests.
- `devc/tests/helpers.ts` — reused for headless key scripting.
- `devc/deno.json` — `check` list update.
