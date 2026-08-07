# devc `init` command — scaffold the bundled default into a project

Add a top-level `devc init [PATH]` that writes the bundled default `.devcontainer/` into a
project verbatim — the same files `devc config` writes on first creation, minus the wizard and
minus the two managed mount fences.

## Why

`devc config` is the only way to get a project-local `.devcontainer/` today, and it requires
sitting through the picker flow (and a configured set of global roots) even when the user wants
nothing more than the baseline on disk to hand-edit. `init` is the non-interactive path to the
same starting point: scaffold, then edit by hand or run `devc config` later to add mounts.

## Contract

`devc init [PATH]` — `PATH` defaults to the current directory, resolved with
`resolveLocalFolder` like every other command.

Writes into `<PATH>/.devcontainer/`:

| File | Source |
| ---- | ------ |
| `devcontainer.json` | `loadBundledDevcontainerJson()` **verbatim** — comments preserved, **no** `devc:source` / `devc:skills` fences |
| `Dockerfile`, `post-create.sh`, `initialize-command.sh`, `scripts/*` | `copyBundledAssets()` |

`post-create.sh`, `initialize-command.sh`, and every `scripts/*.sh` get mode `0755`.

No fences: a later `devc config` inserts them into a fence-less config (already covered by the
existing `applyFences inserts fences into a config that lacks them` test), so `init` has no
reason to write empty ones.

**Refuses to clobber.** If the project already has a devcontainer config — `findOwnDevcontainerConfig`
returns non-null, i.e. either `.devcontainer/devcontainer.json` or `.devcontainer.json` — print to
stderr and exit 1 without writing anything:

```text
devc: <resolved config path> already exists — use `devc config` to change mounts, or delete it to re-init
```

Checking `.devcontainer.json` too (not just `.devcontainer/devcontainer.json`) matters: creating
the directory form alongside an existing root form would leave two configs and make which one
applies ambiguous.

**Non-interactive.** Never prompts, never opens a picker, never runs the global-config wizard,
never builds. Dispatch must therefore sit **before** the first-run global-config hook in
`main.ts` (the same position `config` occupies), or a user with no `~/.config/devc/config.json`
would get the roots wizard on a command that has no use for roots.

Success output (paths relative to `.devcontainer/`, in write order):

```text
Wrote .devcontainer/ for <resolved PATH>
  devcontainer.json
  Dockerfile
  post-create.sh
  initialize-command.sh
  scripts/
Next: `devc up` to create the container, or `devc config` to add source/skills mounts.
```

Help: summary `Scaffold the default dev container config into the project`, listed **first** in
`COMMANDS` (before `config`). Per-command block:

```text
Usage: devc init [PATH]

Arguments:
  [PATH]  Path to the project (default: current directory)

Options:
  -h, --help  Print help
```

## Implementation notes

- **Extract, don't duplicate.** The copy-assets-then-chmod sequence currently inlined in
  `applySelection`'s `created` branch (`wizard_apply.ts`) moves to an exported
  `installBundledAssets(devcontainerDir): Promise<string[]>` in `default_config.ts` — which
  already owns `copyBundledAssets` and `loadBundledDevcontainerJson`. `applySelection` calls it
  instead of its inline block; `init` calls it too. Returns the written paths so both callers
  report the same list.
- `init.ts` is a new module exporting `initProject(projectDir): Promise<InitResult>` with
  `{ configPath, written }`, throwing on the already-exists case so `main.ts`'s existing `fail()`
  helper prints and exits 1. Keeping it out of `wizard_apply.ts` avoids implying a wizard is
  involved.
- Add `init.ts` to the `check` task's file list in `deno.json` — that list is explicit, so a new
  module is otherwise never type-checked.
- `KNOWN_COMMANDS` in `main.ts` derives from `COMMANDS`, so adding the help entry wires the
  unknown-command guard and `devc init --help` automatically. `tests/help_test.ts` asserts
  `COMMANDS.length === 10` and must become 11 (and `help.ts`'s "The ten subcommands" comment).

## Checklist

- [x] `installBundledAssets(devcontainerDir)` in `default_config.ts`, returning written paths
- [x] `applySelection` uses it in place of its inline copy+chmod block (behavior unchanged)
- [x] `devc/init.ts` with `initProject(projectDir)`: refuse-if-exists, write config, install assets
- [x] `help.ts`: `init` entry first in `COMMANDS` + `COMMAND_HELP.init`; "ten" → "eleven"
- [x] `main.ts`: `init` dispatch arm, placed before the first-run global-config hook
- [x] `deno.json`: `init.ts` added to the `check` task
- [x] `tests/help_test.ts`: command count 10 → 11
- [x] `tests/init_test.ts`: writes all files, exec bits set, no fences, refuses when a config
      exists (both `.devcontainer/devcontainer.json` and root `.devcontainer.json`), and the
      written config is byte-identical to the bundled default
- [x] `devc/README.md`: `init` in the command table + a note on what it writes
- [x] `.plans/design/devc-design.md`: `init` in the top-level help block and its own section

## Validation

- [x] `deno task check` passes
- [x] `deno task test` passes (all existing tests plus the new `init_test.ts`)
- [x] `deno task build` succeeds and the binary embeds `default/`
- [x] `./devc --help` lists `init` first in `Commands:`
- [x] `./devc init --help` prints the block above
- [x] `./devc init <tmp>` on an empty dir writes `.devcontainer/` with
      `devcontainer.json`, `Dockerfile`, `post-create.sh`, `initialize-command.sh`, `scripts/`
- [x] the written `devcontainer.json` is byte-identical to `devc/default/devcontainer.json` and
      contains no `devc:source` / `devc:skills` fence
- [x] `post-create.sh`, `initialize-command.sh`, and `scripts/*.sh` are mode `0755`
- [x] re-running `./devc init <tmp>` exits 1 with the already-exists message and does not modify
      the existing `devcontainer.json` (compare bytes before/after)
- [x] `./devc init <dir-with-root-.devcontainer.json>` also exits 1
- [x] `HOME=<empty tmp> ./devc init <tmp2>` succeeds without prompting (no global config present,
      proving the first-run wizard is not reached)

## Relevant Files

- `devc/init.ts` — new; `initProject`
- `devc/default_config.ts` — new `installBundledAssets`
- `devc/wizard_apply.ts` — `applySelection` uses `installBundledAssets`
- `devc/main.ts` — dispatch arm before the first-run global-config hook
- `devc/help.ts` — `COMMANDS` entry, `COMMAND_HELP.init`, "ten" → "eleven"
- `devc/deno.json` — `init.ts` in the `check` task
- `devc/tests/init_test.ts` — new
- `devc/tests/help_test.ts` — command count
- `devc/README.md` — command table + `init` notes
- `.plans/design/devc-design.md` — top-level help block + `init` section
- `.plans/PLAN.md` — registration
