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

### Container engine

`devc` is a thin orchestrator over the [`@devcontainers/cli`](https://github.com/devcontainers/cli) and `docker`; it does not talk to the Docker daemon's build/run APIs directly.

- **Create / start** (`up`, and the auto-start inside `attach`/`claude`/`exec`): shells out to `devcontainer up --workspace-folder <PATH>`. The final line of its JSON output carries the `containerId`, `remoteUser`, and `remoteWorkspaceFolder` used by the rest of the command. Build/`postCreate` output is streamed through, and dumped on failure.
- **Identify**: a container is located by its `devcontainer.local_folder` label matching the resolved project path (via `docker ps`/`docker inspect`), so `status`, `stop`, `down`, and `mounts` never need to start anything.
- **exec / attach**: `docker exec` (`-i` for `exec`, `-it` for `attach`), running under `remoteUser` in `remoteWorkspaceFolder`.
- **Git worktrees**: when the project is a git worktree, `up` passes `--mount-git-worktree-common-dir` and the container-side workspace path is computed to match the CLI's own algorithm.
- **Cosmetic reconciliation** (best-effort, never fatal): after a successful `up`, the container is renamed to a deterministic `devc-<basename>-<hash>` and its image is given a `<name>:latest` alias tag.

### No hidden abstraction

A guiding principle: **the config `devc` produces is a standard, spec-compliant `.devcontainer/` that a developer can read, understand, and hand-edit without learning anything `devc`-specific.** There is no overlay file, no `.devc/` layer, and no launch-time merge step — `devc config` writes a plain `devcontainer.json` + `Dockerfile`, and from that point on the project is a normal dev container that any devcontainer-aware tool (VS Code, the CLI, CI) understands. `devc`'s own baseline behavior is carried by a devcontainer **Feature** (see below), which is itself a standard, inspectable mechanism.

**Managed mount blocks.** So that reconfiguring a project is surgical rather than destructive, the wizard marks the two mount groups it owns — extra source mounts and skills mounts — with comment fences inside the `mounts` array (`// devc:source … // /devc:source` and `// devc:skills … // /devc:skills`). These are ordinary JSONC comments: the devcontainer CLI ignores them and the file remains directly usable, so this is not a hidden abstraction — it is a bookmark. `devc config` only ever rewrites the contents of its two fences. Everything else — the infrastructure mounts written at first creation, the developer's own hand-edits, comments, formatting, and any keys `devc` knows nothing about — is preserved byte-for-byte and **never re-asserted**. In particular, infra mounts are written once when the file is first created; if the developer later edits or removes them, `devc` does not add them back.

### Configuration precedence

When a `devc` command needs container configuration, it resolves in this order:

1. `PATH/.devcontainer/devcontainer.json` (+ sibling `Dockerfile`) if present.
2. The bundled default `devcontainer.json` + `Dockerfile`.

This means once a user applies a project-specific config via `devc config`, subsequent commands automatically use it.

### Bundled default and the `devc` Feature

`devc`'s baseline container behavior — installing the Claude CLI, preparing the isolated `~/.claude` volume (ownership + the per-workspace `~/.claude.json` symlink), and the shell additions (prompt, terminal title, `nvm` auto-use, first-prompt clear) — is **not** baked into a top-level `postCreateCommand` or into the Dockerfile. It is packaged as a **custom devcontainer Feature**.

The reason: `postCreateCommand` is single-valued. If `devc` owned the top-level `postCreateCommand`, a developer who needs their own (e.g. `npm install`, a build step) would have to overwrite it and silently lose `devc`'s setup. Devcontainer **Features** each carry their own lifecycle hooks that run *in addition to* the top-level command, so packaging the baseline as a Feature lets it compose with — rather than be clobbered by — a project's own `postCreateCommand`.

Consequences for the generated config:

- The bundled default `devcontainer.json` references the `devc` Feature under `"features"`; the top-level `postCreateCommand` is left free for the developer.
- The bundled `Dockerfile` stays minimal (base image + anything genuinely image-level), so it remains a clean extension point rather than a place where `devc` behavior hides.

### Host `~/.claude` config: the seed directory

The user's Claude config reaches the container through **one read-only directory bind mount** of `~/.config/devc-tui/.claude` at `/usr/local/share/devc/claude-seed`, not through per-file bind mounts of `~/.claude/*`. The Feature's `post-create.sh` then symlinks every top-level *file* from the seed into the `~/.claude` volume, pruning links whose seed file has gone away.

Why a directory plus symlinks rather than per-file binds or a copy:

- **Per-file binds assume the files exist.** `mounts` takes Docker `--mount` semantics, where a missing bind source is a hard create-time error (unlike `-v`, which auto-creates a directory). A user lacking any one file could not create a container. A directory source can always be created ahead of time, and an empty one is valid.
- **Symlinks, not copies.** `~/.claude` is a persistent per-workspace volume, so a copy would be additive — a file deleted on the host would survive in the container forever, and recovering deletion would need a manifest of what was copied. Symlinks make deletion fall out of pruning, and preserve the live-edit and read-only semantics of the original binds along with host file modes.
- **Files only; directories ignored.** The `devc:skills` fence mounts per-skill binds under `~/.claude/skills/`, and Docker materializes that intermediate directory at create time — before `postCreate` runs. Linking or copying a seed `skills/` over it would silently nest, or fail on a busy mountpoint or a read-only bind. Ignoring directories removes the whole class of conflict; directory-shaped config is added later as its own fence, not by recursing here.

The one part of the baseline that **cannot** compose through the Feature is `initializeCommand`, which creates the mount source on machines without `devc`. The spec allows Features only the five container-side hooks (`onCreateCommand`, `updateContentCommand`, `postCreateCommand`, `postStartCommand`, `postAttachCommand`), and `initializeCommand` is the only host-side hook — the others run after mounts are established, structurally too late. So it sits top-level in the bundled default and inherits the single-valued clobbering problem described above; a project overriding it keeps the `mkdir -p` or drops the seed mount with it. `devc` also calls `ensureClaudeSeedDir` on every `up`, which owns what a shell one-liner cannot: the not-a-directory guard and the one-time migration off the old per-file layout.

> **Open decision (implementation):** how the `devc` Feature is distributed — published to an OCI registry (`ghcr.io/...`, referenced by ref) versus materialized into the project's `.devcontainer/` as a local feature (referenced by relative path, fully self-contained, no network). This does not change the design above; it is resolved during implementation.

## Global user configuration

The first time any `devc` command is executed, the tool enters a one-time **global config mode** before running the requested command. This mode prompts the user for:

- **Code folder roots** — one or more directories where code projects live.
- **Skills folder roots** — one or more directories where agent skills live.

These values are saved as lists in a global config file at `~/.config/devc-tui/config.json`. Once that file exists, the global config prompt no longer runs automatically before other commands. The user can re-run it later via `devc config` (global settings step) if they want to change the root lists.

Example global config:

```json
{
  "codeRoots": ["~/code", "~/work"],
  "skillsRoots": ["~/.agents/skills", "~/team-skills"]
}
```

**Namespace vs. config directory.** The tool's namespace is `devc` (binary name, container-name prefix, Feature id, etc.). The global config directory, however, is `~/.config/devc-tui/` **for now**, to avoid colliding with any pre-existing `~/.config/devc/` from other `devc` tooling while this implementation matures. This path lives behind a single code-level constant. Once this tool is robust enough to replace existing tooling, that constant flips to `~/.config/devc/`.

**No global template overrides for now.** The bundled default config is materialized directly (embedded assets → a cache dir passed to `devcontainer up --config`). There is no user-editable global template directory in this version; customization happens per-project via `devc config`.

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

Configure which agent skills folders are mounted into the container. Skills are **opt-in**: the bundled zero-config default mounts no skills, so a project gets skills only after they are configured here.

- A mount table lists each skills mount:
  - **Host path** — absolute path on the host.
  - **Container path** — defaults to `~/.claude/skills/<basename>` (where the in-container agent discovers skills).
  - **Read-only** toggle (default on, but editable).
- **Add** prompts the user to pick one of the configured **skills folder roots**, then opens a directory picker rooted at that selection.
- **Remove** deletes the selected mount.
- Duplicate container paths are rejected.
- **Remembered selection.** When the wizard applies, the resulting skills list is persisted as the user's *most recent* skills selection. A **new** project's Skills step is pre-seeded from that remembered list (entries whose host path no longer exists are dropped), so a user who mounts the same skills across projects does not re-pick them every time. Reconfiguring an existing project seeds from that project's own `devc:skills` fence instead. (Source mounts are not remembered — they are project-specific — so Step 2 starts empty for new projects.)

### Step 4: Review & apply

Presents a final summary before anything is written to disk:

- Path where files will be written: `PATH/.devcontainer/`
- Whether `devcontainer.json` and/or `Dockerfile` are new or being updated in place
- Full list of mounts
- Preview of the two managed fences (`devc:source`, `devc:skills`) — the only regions the wizard writes
- Note that on first creation the base infra mounts and the `Dockerfile` are copied as-is, and are not touched again on later runs

Actions: **Apply**, **Back**, **Cancel**.

When the user selects **Apply**:

1. Create `PATH/.devcontainer/` if it does not exist.
2. **First creation** (no existing `PATH/.devcontainer/devcontainer.json`): write the base `devcontainer.json` from the bundled default, with the two managed fences inserted into the `mounts` array and populated from the configured source/skills mounts. Write the base `Dockerfile` as-is.
3. **Update in place** (file already exists): rewrite only the `devc:source` and `devc:skills` fence contents; preserve everything else byte-for-byte (infra mounts, hand-edits, comments, unknown keys). Do not rewrite the `Dockerfile`.
4. Persist the applied skills list as the remembered selection (see Step 3).
5. Return to the shell with a success message.

If the user selects **Cancel** or quits, no files are written and the in-memory changes are discarded.

### Reconfiguring a project

Running `devc config` again on a project that already has a `.devcontainer/devcontainer.json` reads its `devc:source` / `devc:skills` fences to recover the current selection, lets the user edit it, and on Apply rewrites only those fences. Base infra mounts and any hand-edits outside the fences are preserved and never re-asserted (see "No hidden abstraction").

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

On attach, `devc` drops into an interactive login shell in the container. It does **not** offer tmux or terminal control-mode (`--tmux` / `--CC`) attach modes — these are intentionally out of scope (see Implementation notes). The attach retains the terminal-quality behaviors described in Implementation notes (terminal identity propagation, session-distinguishing tint).

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

## Implementation notes

These behaviors are part of the intended implementation even though most are invisible in normal use. They are carried over from prior art and kept deliberately.

**Kept — terminal quality on `attach`/`claude`:**

- **Terminal identity propagation.** `docker exec -t` hardcodes `TERM=xterm` and strips the host's terminal identity. `devc` forwards `TERM`, `TERM_PROGRAM`, and `TERM_PROGRAM_VERSION` (each only when set on the host) so key handling negotiated against the outer terminal (e.g. shift+enter) keeps working inside the container.
- **Session-distinguishing tint.** For the lifetime of an attach, the terminal is tinted so a container shell reads as visually distinct from a local one, and reset on detach.
- **First-prompt clear.** A plain attach clears the noisy shell-init output on the first prompt (suppressible with `--no-clear`).

**Kept — container lifecycle correctness:**

- **Git worktree mounting** (`--mount-git-worktree-common-dir`) with a matching container-side workspace path.
- **Deterministic container naming** (`devc-<basename>-<hash>`) and an image alias tag, reconciled best-effort after `up` and never fatal.

**Dropped:**

- **tmux and control-mode attach** (`--tmux`, `--CC`). The prior art supported attaching via an in-container tmux session and iTerm2/WezTerm control mode; `devc` only does a plain interactive login shell.

## Self-containment

`devc` is fully self-contained. At runtime it depends only on external CLIs it shells out to — `docker`, `devcontainer` (`@devcontainers/cli`), and `git` — plus its own embedded assets (the bundled default `devcontainer.json` / `Dockerfile` and the `devc` Feature). The embedded assets ship inside the binary (`deno compile --include`), so no part of the tool reaches outside the repository or the installed binary to find configuration or scripts it needs.
