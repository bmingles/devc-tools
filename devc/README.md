# devc

`devc` is a thin orchestrator over [`@devcontainers/cli`](https://github.com/devcontainers/cli),
`docker`, and `git` for managing the dev container of a project directory. It ships a bundled
default `devcontainer.json` + `Dockerfile` embedded in the binary, so a project needs no
`.devcontainer/` of its own to get a working container.

Every command operates on the current working directory by default; an optional `[PATH]`
positional overrides it. The resolved path identifies the project and its container.

## Commands

```text
devc up      [PATH] [--json]                          Create/start the container; print its status
devc attach  [PATH] [--build] [--no-clear]            Start (creating if needed) and attach a login shell
devc claude  [PATH] [EXTRA_ARGS...]                   Start and run `claude` (+ forwarded args) in a login shell
devc exec    [PATH] [--cwd DIR] [--env K=V]... -- CMD Start and run CMD directly (no shell)
devc mounts  [PATH] [--json]                          List the container's mounts
devc stop    [PATH]                                   Stop the container
devc down    [PATH]                                   Stop and remove the container
devc status  [PATH]                                   Print `running` / `stopped` / `missing`
```

Notes:

- `up` prints `<containerId> running — workspace <remoteWorkspaceFolder>`, or the
  `ContainerInfo` JSON with `--json`.
- `attach --build` forces a rebuild (`--remove-existing-container`); `--no-clear` keeps the
  shell-init output on screen instead of clearing on the first prompt.
- `exec` runs the command after `--` directly (no shell) and exits with the command's own
  exit code; `devc`/`docker` infra failures exit 125. `--env` is repeatable and a value
  without `=` is an error (exit 125).
- `mounts` prints `type\tsource -> destination\trw|ro` rows, or the `ContainerMount[]` JSON
  with `--json`. With no container it prints `No container for <path>` (text) / `[]` (json).
- Lookup commands (`status`/`stop`/`down`/`mounts`) locate the container by its
  `devcontainer.local_folder` label and never start anything.

## How it works

- **Create / start** shells out to `devcontainer up --workspace-folder <PATH>`; the final
  line of its JSON output carries the `containerId`, `remoteUser`, and
  `remoteWorkspaceFolder`.
- The bundled default config is materialized to a cache dir and passed as
  `--config <dir>/devcontainer.json`. If the project has its own
  `.devcontainer/devcontainer.json` (or `.devcontainer.json`), that is used instead.
- **exec / attach** run via `docker exec` under `remoteUser` in `remoteWorkspaceFolder`.
  Because `docker exec` does not apply devcontainer `remoteEnv`, `devc` re-derives it from
  the materialized default config and passes `-e K=V` per entry.
- **Git worktrees**: `up` passes `--mount-git-worktree-common-dir` and the container-side
  workspace path is computed to match the CLI's own algorithm.
- After a successful `up`, the container is renamed to `devc-<basename>-<hash>` and its image
  is given a `<name>:latest` alias tag (both best-effort, never fatal).

`attach`/`claude` also propagate the host terminal identity (`TERM`, `TERM_PROGRAM`,
`TERM_PROGRAM_VERSION`, `$TMUX`) and tint the terminal for the duration of the attach so a
container shell reads as visually distinct from a local one.

## Development

```sh
deno task run    -- <command> [args]   # run from source
deno task test                         # unit tests
deno task check                        # type-check
deno task build                        # compile the `devc` binary (embeds default/)
```

The interactive `devc config` project wizard and global config (code/skills roots at
`~/.config/devc-tui/config.json`) land in later phases; only the container-lifecycle
commands above are implemented today.
