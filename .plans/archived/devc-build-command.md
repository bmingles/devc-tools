# devc `build` command + change-aware rebuild prompt

Two related additions:

1. A top-level `devc build [PATH]` command that recreates the project's dev
   container from scratch (`devcontainer up --remove-existing-container`), with
   `--no-cache` to also drop the Docker layer cache.
2. `devc config` learns whether its apply actually **changed** the on-disk
   `devcontainer.json`. Only then does it tell the user a rebuild is needed and
   offer to run one. Toggling folders on and back off — any selection whose
   serialized result is byte-identical to what is already on disk — prints "no
   changes" and never prompts.

## Design decisions

- **"Rebuild" means recreate the container**, not build the image alone. Mounts
  (the only thing the wizard writes) are applied at container-create time, so
  `devcontainer up
  --remove-existing-container` is the operation that makes a
  config change take effect. `--no-cache` additionally passes `--build-no-cache`
  for the image-level case.
- **Change detection compares the config text**, not the selection.
  `applySelection` already computes the exact bytes it would write; comparing
  them to the bytes read from disk is exact and needs no separate model diffing.
  First creation always counts as changed.
- **When unchanged, do not write the file at all** — an apply that changes
  nothing leaves `devcontainer.json` byte-identical _and_ mtime-identical.
- **Global-roots changes never prompt.** `codeRoots`/`skillsRoots` and
  `recentSkills` do not affect the container, so `devc config --global` gains no
  prompt.
- **The rebuild prompt degrades cleanly.** `runProjectFlow` takes the
  container-status lookup and the rebuild action as injected deps. When they are
  absent (tests, non-Docker contexts) it prints the "rebuild needed" notice and
  skips the prompt rather than failing.

## Contract

### `devc build`

```text
Usage: devc build [PATH] [OPTIONS]

Arguments:
  [PATH]  Path to the project (default: current directory)

Options:
      --no-cache   Rebuild the image without the Docker layer cache
      --json       Output container status as JSON
  -h, --help       Print help
```

- Prints `Rebuilding dev container for <PATH>...` before starting.
- On success prints the same line as `up`:
  `<containerId> running — workspace <remoteWorkspaceFolder>`, or the
  `ContainerInfo` JSON with `--json`.
- Failure exits 1 with `devc: <message>` on stderr (the `fail()` path
  `attach`/`up` use).
- Appears in `devc --help` between `up` and `exec`, summary:
  `Rebuild the dev container for the current project`.

### `devc config` post-apply flow

After a successful apply, exactly one of these three outcomes:

| Situation                                 | Output                                                                                  | Prompt                |
| ----------------------------------------- | --------------------------------------------------------------------------------------- | --------------------- |
| Config text unchanged                     | `No config changes — no rebuild needed.`                                                | none                  |
| Changed, container `running` or `stopped` | `Config changed — the dev container must be rebuilt for the new mounts to take effect.` | `Rebuild now? [Y/n]`  |
| Changed, container `missing`              | `No dev container exists for this project yet.`                                         | `Build it now? [Y/n]` |

- Answering yes runs the same recreate as `devc build` and prints its summary
  line.
- Answering no prints `Skipped — run \`devc build\` when you're ready.`
- A failing rebuild prints `devc: <message>` via the flow's `err` and returns
  normally (the config was still written).

### API changes

- `ApplyResult` gains `changed: boolean` — `true` when the file was created or
  its text differs from what was on disk.
- `startContainer(localFolder, rebuild = false, opts: { noCache?: boolean } = {})`.
- New
  `rebuildContainer(localFolder, opts?: { noCache?: boolean }): Promise<ContainerInfo>`
  in `container.ts` — `startContainer(localFolder, true, opts)`.
- New
  `parseBuildArgs(args: string[]): { target?: string; noCache: boolean; json: boolean }`
  in `args.ts`.
- `FlowDeps` gains `containerStatus?: (dir: string) => Promise<ContainerStatus>`
  and `rebuild?: (dir: string) => Promise<string>` (resolves to the summary line
  to print; throws on failure).
- `FlowResult` becomes
  `{ applied: boolean; changed: boolean; rebuilt: boolean }`.

## Checklist

- [x] `help.ts`: add `build` to `COMMANDS` (after `up`) and a
      `COMMAND_HELP.build` block
- [x] `args.ts`: add `parseBuildArgs`
- [x] `container.ts`: `startContainer` `noCache` option (`--build-no-cache`) +
      `rebuildContainer`
- [x] `wizard_apply.ts`: `ApplyResult.changed`; skip the write when nothing
      changed
- [x] `tui/config_flow.ts`: `FlowDeps.containerStatus`/`rebuild`, `FlowResult`
      fields, the three-outcome post-apply block, and real deps wired in
      `realDeps()`
- [x] `main.ts`: `build` dispatch arm
- [x] `devc/README.md`: command list row + a `build` note + the config
      rebuild-prompt note
- [x] `.plans/design/devc-design.md`: `build` in the top-level help block, a new
      `## build` section, and the rebuild prompt in the `config` apply steps
- [x] Tests: `args_test.ts` (parseBuildArgs), `help_test.ts` (ten commands),
      `wizard_apply_test.ts` (`changed` true/false + no-write on unchanged),
      `config_flow_test.ts` (prompt on change / accept, decline, no prompt when
      unchanged, first-build wording, failed rebuild, missing deps, failed
      status lookup)

## Validation

- [x] `cd devc && deno task check` — clean
- [x] `cd devc && deno task test` — all tests pass (155)
- [x] `cd devc && deno fmt --check` — no file is newly unformatted relative to
      `HEAD` (the repo is not fmt-clean at baseline: 19 of 44 files differ from
      `deno fmt` defaults, and `deno lint` reports 21 pre-existing
      `no-import-prefix` findings for the `jsr:` specifiers used throughout —
      neither is a gate this repo currently passes)
- [x] `deno run --allow-all main.ts --help` lists `build` with its summary
- [x] `deno run --allow-all main.ts build --help` prints the usage block above
- [x] `deno run --allow-all main.ts nonexistent-cmd` still exits 1 with the
      unknown-command error

## Relevant Files

| Path                              | Change                                            |
| --------------------------------- | ------------------------------------------------- |
| `devc/help.ts`                    | `build` in `COMMANDS` + `COMMAND_HELP`            |
| `devc/args.ts`                    | `parseBuildArgs`                                  |
| `devc/container.ts`               | `noCache` option, `rebuildContainer`              |
| `devc/wizard_apply.ts`            | `ApplyResult.changed`, conditional write          |
| `devc/tui/config_flow.ts`         | rebuild prompt, new deps, `FlowResult`            |
| `devc/main.ts`                    | `build` dispatch arm                              |
| `devc/README.md`                  | command list + notes                              |
| `devc/tests/args_test.ts`         | `parseBuildArgs` cases                            |
| `devc/tests/help_test.ts`         | command count / `build` block                     |
| `devc/tests/wizard_apply_test.ts` | `changed` semantics                               |
| `devc/tests/config_flow_test.ts`  | post-apply prompt cases                           |
| `.plans/design/devc-design.md`    | `build` section + help block + config apply steps |
| `.plans/PLAN.md`                  | status entry + phase row                          |
