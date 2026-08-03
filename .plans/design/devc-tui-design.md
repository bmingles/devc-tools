# devc-tui CLI Design

## Project directory semantics

All `devc` commands operate on the **current working directory** by default. The cwd is treated as the project directory, and the dev container associated with that project directory is the target of the command.

- If a command accepts an optional `PATH` argument, `PATH` overrides the cwd, but the semantics are the same: the resolved path identifies the project and its container.
- If the container for the project directory does not exist or is not running, commands that need a running container will create and/or start it automatically before doing their work.
- If the container is already running, commands simply use it.

## How it works

`devc-tui` is both a CLI and a TUI. The CLI surface area documented here is the primary interface, but some commands (starting with `config`) launch an interactive TUI wizard.

The tool ships with a **default `Dockerfile` + `devcontainer.json`** bundled inside the binary/installation. All container-related CLI commands (`up`, `attach`, `exec`, etc.) use this bundled configuration by default to create or start the project container.

When a user wants to customize the container for a particular project, they run `devc config`. This opens a TUI that edits a project-specific `.devcontainer/devcontainer.json` and `.devcontainer/Dockerfile`, which are then saved in the cwd project.

## Global user configuration

The first time any `devc` command is executed, the tool enters a one-time **global config mode** before running the requested command. This mode prompts the user for:

- **Code folder root** — the base directory where code projects live.
- **Skills folder root** — the base directory where agent skills live.

These values are saved to a global config file, e.g. `~/.config/devc-tui/config.json`. Once that file exists, the global config prompt no longer runs automatically before other commands. The user can re-run it later via `devc config` (global settings step) if they want to change the roots.

## First-run flow

1. User runs `devc <command>` for the first time.
2. If `~/.config/devc-tui/config.json` does not exist, the TUI global config prompt appears.
3. User enters their code root and skills root.
4. The global config file is saved.
5. The originally requested command continues.

## `config` (TUI)

The `config` command is the first TUI feature. It opens an interactive wizard for configuring the dev container of the current project.

```text
Usage: devc config [PATH]

Arguments:
  [PATH]  Path to the project (default: current directory)

Options:
  -h, --help  Print help
```

### In-memory configuration

When `config` starts, it loads a working copy of the container configuration into memory:

- If `PATH/.devcontainer/devcontainer.json` already exists, that file (and a sibling `Dockerfile` if present) is used as the base.
- Otherwise, the bundled default `devcontainer.json` + `Dockerfile` is used as the base.

### Wizard steps

The config TUI steps the user through container settings, for example:

- Edit devcontainer settings (features, environment variables, post-create commands, etc.).
- Add mounts for source code folders, using the global **code folder root** as the starting point.
- Add mounts for skills folders, using the global **skills folder root** as the starting point.
- Add any additional custom mounts or overrides.

### Applying the configuration

When the user confirms/"Apply" in the TUI:

1. The `.devcontainer/` directory is created under `PATH` if it does not already exist.
2. The in-memory `devcontainer.json` is written to `PATH/.devcontainer/devcontainer.json`.
3. The in-memory `Dockerfile` is written to `PATH/.devcontainer/Dockerfile`.

If the user cancels/quits without applying, no files are written.

## Top-level help

```text
$ devc --help
Usage: devc [OPTIONS] <COMMAND>

Options:
  -h, --help     Print help
  -V, --version  Print version

Commands:
  config   Configure the dev container for the current project (TUI)
  attach   Attach to the dev container for the current project
  claude   Launch Claude inside the dev container for the current project
  up       Start the dev container for the current project
  exec     Execute a command inside the dev container for the current project
  mounts   List container mounts for the current project
  stop     Stop the dev container for the current project
  down     Remove the dev container for the current project
  status   Show dev container status for the current project

Run "devc <COMMAND> --help" for more information on a command.
```

## `attach`

Attach to the dev container for the project in the current working directory.

- If the container is not running, `devc` creates/starts it first and then attaches.
- If the container is already running, it attaches immediately.

```text
Usage: devc attach [PATH] [OPTIONS]

Arguments:
  [PATH]  Path to the project (default: current directory)

Options:
      --build      Force a rebuild before attaching
      --no-clear   Do not clear the screen before starting the TUI
  -h, --help       Print help
```

## `claude`

Launch Claude inside the dev container for the project in the current working directory, creating/starting the container if necessary.

```text
Usage: devc claude [PATH] [EXTRA_ARGS...]

Arguments:
  [PATH]         Path to the project (default: current directory)
  [EXTRA_ARGS]   Additional arguments forwarded to Claude

Options:
  -h, --help     Print help
```

## `up`

Start the dev container for the project in the current working directory.

```text
Usage: devc up [PATH] [OPTIONS]

Arguments:
  [PATH]  Path to the project (default: current directory)

Options:
      --json   Output container status as JSON
  -h, --help   Print help
```

## `exec`

Execute a command inside the dev container for the project in the current working directory, creating/starting the container if necessary.

```text
Usage: devc exec [PATH] [OPTIONS] -- <CMD...>

Arguments:
  [PATH]          Path to the project (default: current directory)
  <CMD>...        Command (with arguments) to execute in the container

Options:
      --cwd <DIR>   Working directory inside the container
      --env K=V     Environment variable(s) to set (repeatable)
  -h, --help        Print help
```

## `mounts`

List container mounts for the project in the current working directory.

```text
Usage: devc mounts [PATH] [OPTIONS]

Arguments:
  [PATH]  Path to the project (default: current directory)

Options:
      --json   Output mounts as JSON
  -h, --help   Print help
```

## `stop`

Stop the dev container for the project in the current working directory.

```text
Usage: devc stop [PATH]

Arguments:
  [PATH]  Path to the project (default: current directory)

Options:
  -h, --help  Print help
```

## `down`

Remove the dev container for the project in the current working directory.

```text
Usage: devc down [PATH]

Arguments:
  [PATH]  Path to the project (default: current directory)

Options:
  -h, --help  Print help
```

## `status`

Show dev container status for the project in the current working directory.

```text
Usage: devc status [PATH]

Arguments:
  [PATH]  Path to the project (default: current directory)

Options:
  -h, --help  Print help
```
