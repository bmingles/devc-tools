# devc lifecycle core — port the container commands + bundled default

## Context

See `.plans/design/devc-design.md` (the source of truth). This phase replaces
the current fence-based `devc/` tool with the container-**lifecycle** half of
the design: `up`, `attach`, `claude`, `exec`, `mounts`, `stop`, `down`,
`status`. These are ported from the reference implementation at
`/workspaces/agent-tools/devc` (a one-time seed — it will not remain in this
repo; see design "Self-containment"). Everything the commands need must be
copied into `devc/` and be self-contained: no path to the reference may appear
in code, tests, config, or build.

`devc` is a thin orchestrator: `devcontainer up` (from `@devcontainers/cli`)
creates/starts; `docker` does everything else (label lookup, exec, attach, stop,
rm, inspect).

**Deliberately dropped from the reference during the port** (see design
"Implementation notes"):

- tmux and control-mode **attach** (`--tmux` / `--CC`): `devc attach`/`claude`
  only ever run a plain interactive login shell (or a `command` login shell for
  `claude`). Remove the tmux client shell branch and the `tmux`/`controlMode`
  fields from attach options. **Keep** the host-tmux detection used for terminal
  tint + window rename, and the host `$TMUX`/`TERM*` env forwarding on
  `docker exec` (extended-key support).
- The `.devc/devc.json` **overlay** mechanism (`findDevcConfigPath`,
  `loadExtraConfigArgs`, and the overlay-merge half of `loadResolvedRemoteEnv`):
  not carried over (design "No hidden abstraction"). `remoteEnv` is still read
  from the _materialized default_ config and injected on exec/attach, but there
  is no project overlay merge.
- The **global template override** dir (`~/.config/devc/templates` seeding in
  `materializeDefaultConfig`): not carried over (design "No global template
  overrides"). The embedded `default/` tree is copied straight to the cache dir.

The baseline setup shipped in `default/` is copied **verbatim** in this phase
(still `postCreateCommand`-based). Repackaging it as a devcontainer Feature is
the next phase (`devc-container-feature`).

### Contract (must match design exactly)

Command surface and flags per design's per-command sections. Notable details:

- Optional `[PATH]` positional on every command; defaults to cwd. Resolve via
  `resolveLocalFolder`.
- `up [PATH] [--json]`: on success prints
  `<containerId> running — workspace <remoteWorkspaceFolder>`; with `--json`
  prints the `ContainerInfo` JSON.
- `attach [PATH] [--build] [--no-clear]`: `--build` forces
  `--remove-existing-container`.
- `claude [PATH] [EXTRA_ARGS...]`: same as attach but runs `claude` (plus
  forwarded args) in a login shell; attach ends when it exits.
- `exec [PATH] [--cwd DIR] [--env K=V]... -- <CMD...>`: everything after `--` is
  the command, exec'd directly (no shell). `--env` repeatable; a value without
  `=` is an error (exit 125). Exits with the command's own exit code;
  devc/docker infra failure exits 125.
- `mounts [PATH] [--json]`: text rows `type\tsource -> destination\trw|ro`;
  `--json` prints the `ContainerMount[]`; no container →
  `No container for <path>` (text) / `[]` (json).
- `stop`/`down`/`status [PATH]`: `status` prints one of `running` / `stopped` /
  `missing`.

### Gotchas

- **`devcontainer up` output parsing:** it emits one JSON object per line; the
  **last** line is the outcome
  (`{ outcome, containerId, remoteUser, remoteWorkspaceFolder, ... }`). Parse
  the last line only; on empty/unparseable/`outcome!=="success"`, dump captured
  stdout (each record's `.text`, falling back to the raw line) to stderr and
  throw.
- **`resolveLocalFolder` must run before any naming/label match:** a bare `.`
  must become absolute or it yields an invalid image tag and fails the
  `devcontainer.local_folder` match.
- **remoteEnv on exec:** `docker exec` does _not_ apply devcontainer
  `remoteEnv`; devc re-derives it (`loadResolvedRemoteEnv` → read materialized
  config's `remoteEnv`, substitute `${containerWorkspaceFolder}` and
  `${localEnv:VAR}`) and passes `-e K=V` per entry. When the project has its
  **own** `.devcontainer/` config, remoteEnv is left `{}` (carried-over
  limitation).
- **worktrees:** `startContainer` passes `--mount-git-worktree-common-dir` when
  `isGitWorktree`, and `computeContainerWorkspaceFolder` must mirror the CLI's
  path algorithm (port verbatim).
- **embedded assets:** resolve `default/` via
  `new URL("../default/", import.meta.url)` so it works both under `deno run`
  and a `deno compile --include default` binary. Materialize to
  `~/.cache/devc/default/` and pass `--config <that>/devcontainer.json`.
- **config-dir constant:** add `CONFIG_DIR = <home>/.config/devc-tui` as a
  single exported const with a comment that it flips to `.config/devc` later.
  Not consumed yet this phase, but define it so later phases share one source of
  truth.

## Checklist

- [x] `devc/paths.ts` — port `normalizePath` verbatim.
- [x] `devc/args.ts` — `parseAttachArgs` supporting only `--build` (→`rebuild`)
      and `--no-clear`; drop `--tmux`/`--CC`. Positional `[PATH]` = first
      non-`--` arg.
- [x] `devc/container.ts` — port: `resolveLocalFolder`,
      `assertLocalFolderExists`, `findContainer`, `getContainerStatus`,
      `buildExecArgs`, `execInContainer`, `parseMounts`, `getContainerMounts`,
      `isGitWorktree`, `computeContainerWorkspaceFolder`,
      `containerNameForLocalFolder`, `dockerInspect`, `renameContainerIfNeeded`,
      `tagImageIfNeeded`, `dumpBuildOutput`, `startContainer`, `stopContainer`,
      `downContainer`, `sessionNameForWorkspaceFolder`, `hostIsTmux`,
      `applyAttachColors`, `attachToContainer`. Strip the tmux/controlMode
      attach branch and those two `AttachOptions` fields; keep tint, window
      rename, and `$TMUX`/`TERM*` exec-env forwarding.
- [x] `devc/default_config.ts` — `hasOwnDevcontainerConfig`;
      `materializeDefaultConfig(cacheDir?)` (embedded `default/` → cache dir, no
      template-override seeding); `substituteVars`;
      `loadResolvedRemoteEnv(configPath, containerWorkspaceFolder)` (read
      materialized config `remoteEnv`, substitute; no overlay merge);
      `CONFIG_DIR` const. Drop `findDevcConfigPath`, `loadExtraConfigArgs`, and
      all `.devc/devc.json` handling.
- [x] `devc/main.ts` — argv dispatch for
      `up`/`attach`/`claude`/`exec`/`mounts`/`stop`/`down`/ `status` +
      usage/`--help`. `fail(e)` → `devc: <msg>` to stderr, exit 1; exec infra
      failure exit 125. Derive attach session name from the git toplevel of the
      resolved path.
- [x] Copy `default/` verbatim into `devc/default/`: `Dockerfile`,
      `devcontainer.json`, `post-create.sh`, `bashrc-additions.sh`, `tmux.conf`.
- [x] `devc/deno.json` — tasks: `run`
      (`deno run --allow-run=docker,devcontainer,git,tmux,tty
      --allow-read --allow-write --allow-env main.ts`),
      `test`
      (`deno test --allow-run=git
      --allow-read --allow-write --allow-env`),
      `check`, `build`
      (`deno compile
      --allow-run=docker,devcontainer,git,tmux,tty --allow-read --allow-write --allow-env
      --include default --output devc main.ts`).
      Keep `imports` for `@std/path`, `@std/assert`.
- [x] Port unit tests to `devc/tests/`: `resolve_local_folder_test.ts`,
      `container_name_test.ts`, `container_workspace_folder_test.ts`,
      `exec_args_test.ts` (`buildExecArgs`), `mounts_test.ts` (`parseMounts`),
      `session_name_test.ts`, `assert_local_folder_test.ts`, `args_test.ts`
      (trimmed to the kept flags), `default_config_test.ts` (only kept
      functions: `hasOwnDevcontainerConfig`, `substituteVars`,
      `materializeDefaultConfig`, remoteEnv read).
- [x] Delete the obsolete fence-based tool: `devc/cli.ts`, `devc/config.ts`,
      `devc/scan.ts`, `devc/model.ts`, `devc/workspace.ts`,
      `devc/devcontainer.ts`, `devc/diff.ts`, `devc/skills.ts`,
      `devc/tui/app.ts`, `devc/tui/state.ts`, `devc/tui/render.ts`, and their
      tests (`cli_test.ts`, `config_test.ts`, `model_test.ts`, `scan_test.ts`,
      `tui_app_test.ts`, `tui_keys_test.ts`, `tui_render_test.ts`,
      `tui_state_test.ts`, `tests/fixtures/*`). **Keep** `devc/jsonc_edit.ts` (+
      `tests/jsonc_edit_test.ts`), `devc/tui/term.ts`, `devc/tui/keys.ts` (+
      `tests/helpers.ts`) for later phases.
- [x] Update `devc/README.md` to the new command surface (or stub it and note
      wizard/config land in later phases).

## Validation

- [x] `cd devc && deno task test` — all ported unit tests pass.
- [x] `cd devc && deno task check` — type-checks clean (update the `check` file
      list to the new modules).
- [x] `cd devc && deno task build` produces a `devc` binary that embeds
      `default/` (`./devc status /tmp` runs without a `default/` dir on disk
      beside it).
- [x] `deno run ... main.ts status .` prints `missing` in a dir with no
      container; exits 0.
- [ ] (user) In a real repo: `devc up` builds via the bundled default and prints
      the running line; `devc status` → `running`; `devc exec -- echo hi` prints
      `hi`; `devc mounts` lists mounts; `devc stop` → `stopped`; `devc down` →
      `missing`. `devc up` in a git worktree mounts the common dir (workspace
      path reflects the worktree layout).
- [x] `grep -rniE "agent-tools|/workspaces/agent-tools" devc/` returns nothing
      (no reference leak).
- [x] `grep -rn "\.devc/devc\.json\|loadExtraConfigArgs\|--tmux\|--CC" devc/`
      returns nothing.

## Relevant Files

- `devc/main.ts` — new: argv dispatch for the eight lifecycle commands + usage.
- `devc/container.ts` — new: ported docker/devcontainer orchestration
  (tmux-attach stripped).
- `devc/default_config.ts` — new: bundled-default materialization + remoteEnv
  (overlay stripped).
- `devc/paths.ts` — new: `normalizePath`.
- `devc/args.ts` — new: `parseAttachArgs` (kept flags only).
- `devc/default/{Dockerfile,devcontainer.json,post-create.sh,bashrc-additions.sh,tmux.conf}`
  — copied verbatim.
- `devc/deno.json` — task + permission updates.
- `devc/README.md` — command surface rewrite.
- `devc/tests/{resolve_local_folder,container_name,container_workspace_folder,exec_args,mounts,session_name,assert_local_folder,args,default_config}_test.ts`
  — ported unit tests.
- Deleted: `devc/{cli,config,scan,model,workspace,devcontainer,diff,skills}.ts`,
  `devc/tui/{app,state,render}.ts`, and the tests/fixtures listed above.
- Kept for later phases: `devc/jsonc_edit.ts`, `devc/tui/{term,keys}.ts`,
  `devc/tests/{jsonc_edit_test,helpers}.ts`.
