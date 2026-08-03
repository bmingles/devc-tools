# devc CLI Design

## Project directory semantics

All `devc` commands operate on the **current working directory** by default. The cwd is treated as the project directory, and the dev container associated with that project directory is the target of the command.

- If a command accepts an optional `PATH` argument, `PATH` overrides the cwd, but the semantics are the same: the resolved path identifies the project and its container.
- If the container for the project directory does not exist or is not running, commands that need a running container will create and/or start it automatically before doing their work.
- If the container is already running, commands simply use it.

## How it works

`devc` is both a CLI and a TUI. The CLI surface area documented here is the primary interface, but some commands (starting with `config`) launch an interactive TUI wizard.

The tool ships with a **default `Dockerfile` + `devcontainer.json`** bundled inside the binary/installation. All container-related CLI commands (`up`, `attach`, `exec`, etc.) use this bundled configuration by default to create or start the project container.

When a user wants to customize the container for a particular project, they run `devc config`. This opens a TUI that edits a project-specific `.devcontainer/devcontainer.json` and `.devcontainer/Dockerfile`, which are then saved in the cwd project.

### Configuration precedence

When a `devc` command needs container configuration, it resolves in this order:

1. `PATH/.devcontainer/devcontainer.json` (+ sibling `Dockerfile`) if present.
2. The bundled default `devcontainer.json` + `Dockerfile`.

This means once a user applies a project-specific config via `devc config`, subsequent commands automatically use it.

## Global user configuration

The first time any `devc` command is executed, the tool enters a one-time **global config mode** before running the requested command. This mode prompts the user for:

- **Code folder roots** — one or more directories where code projects live.
- **Skills folder roots** — one or more directories where agent skills live.

These values are saved as lists in a global config file, e.g. `~/.config/devc-tui/config.json`. Once that file exists, the global config prompt no longer runs automatically before other commands. The user can re-run it later via `devc config` (global settings step) if they want to change the root lists.

Example global config:

```json
{
  "codeRoots": ["~/code", "~/work"],
  "skillsRoots": ["~/.agents/skills", "~/team-skills"]
}
```

## First-run flow

1. User runs `devc <command>` for the first time.
2. If `~/.config/devc-tui/config.json` does not exist, the TUI global config prompt appears.
3. User adds one or more code roots and one or more skills roots.
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

### Wizard layout

The TUI is divided into three regions:

- **Left sidebar** — list of wizard steps; the current step is highlighted.
- **Main area** — controls for the current step (tables, pickers, previews).
- **Footer** — available keybindings, e.g.:
  - `↑` / `↓` or `Tab` / `Shift+Tab` — move focus.
  - `Enter` — edit a field or confirm a selection.
  - `Space` — toggle checkboxes.
  - `Esc` or the **Back** button — return to the previous step.
  - `A` or the **Apply** button — write files (only active on the review step).
  - `Q` or **Cancel** — quit without writing files.

### Starting the wizard

When the user runs `devc config [PATH]`:

1. Resolve the project directory (`PATH` or cwd).
2. If `~/.config/devc-tui/config.json` is missing, run the **Global config** step first and persist the code/skills root lists.
3. Load the base container configuration into memory:
   - If `PATH/.devcontainer/devcontainer.json` exists, load it (and a sibling `Dockerfile` if present).
   - Otherwise, start from the bundled default `devcontainer.json` + `Dockerfile`.
4. Proceed to the **Project overview** step.

### Step 1: Project overview

Displays a summary of the project being configured:

- Project path
- Base config source: `Bundled default` vs `Existing .devcontainer/`
- Whether mounts will be created for the first time or edited in place

Actions: **Next**, **Cancel**.

### Step 2: Source code mounts

The current project directory is always mounted as the devcontainer workspace. This step lets the user add **extra source code folders** that should also be available inside the container.

- A mount table lists each extra source mount:
  - **Host path** — absolute path on the host.
  - **Container path** — absolute path inside the container. Defaults to `/workspaces/<basename>`.
  - **Read-only** toggle (default off for source code).
- **Add** prompts the user to pick one of the configured **code folder roots**, then opens a directory picker rooted at that selection.
- **Remove** deletes the selected mount.
- Duplicate container paths are rejected.

### Step 3: Skills mounts

Configure which agent skills folders are mounted into the container.

- A mount table lists each skills mount:
  - **Host path** — absolute path on the host.
  - **Container path** — defaults to `~/.agents/skills/<basename>`.
  - **Read-only** toggle (default on, but editable).
- **Add** prompts the user to pick one of the configured **skills folder roots**, then opens a directory picker rooted at that selection.
- **Remove** deletes the selected mount.
- Duplicate container paths are rejected.

### Step 4: Review & apply

Presents a final summary before anything is written to disk:

- Path where files will be written: `PATH/.devcontainer/`
- Whether `devcontainer.json` and/or `Dockerfile` are new or overwriting existing files
- Full list of mounts
- Preview of the `devcontainer.json` **mounts** section (the only part the wizard changes)
- Note that the bundled/existing `Dockerfile` is copied as-is

Actions: **Apply**, **Back**, **Cancel**.

When the user selects **Apply**:

1. Create `PATH/.devcontainer/` if it does not exist.
2. Serialize the in-memory `devcontainer.json` (with the configured mounts) to `PATH/.devcontainer/devcontainer.json`.
3. Write the unchanged base `Dockerfile` to `PATH/.devcontainer/Dockerfile`.
4. Return to the shell with a success message.

If the user selects **Cancel** or quits, no files are written and the in-memory changes are discarded.

### Reconfiguring a project

Running `devc config` again on a project that already has a `.devcontainer/devcontainer.json` loads that file as the base and lets the user edit the mounts. Applying overwrites the existing files with the new configuration.

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
