# devc-tui CLI Design

## Project directory semantics

All `devc` commands operate on the **current working directory** by default. The cwd is treated as the project directory, and the dev container associated with that project directory is the target of the command.

- If a command accepts an optional `PATH` argument, `PATH` overrides the cwd, but the semantics are the same: the resolved path identifies the project and its container.
- If the container for the project directory does not exist or is not running, commands that need a running container will create and/or start it automatically before doing their work.
- If the container is already running, commands simply use it.

## Top-level help

```text
$ devc --help
Usage: devc [OPTIONS] <COMMAND>

Options:
  -h, --help     Print help
  -V, --version  Print version

Commands:
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
