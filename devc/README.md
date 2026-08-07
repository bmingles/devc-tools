# devc

`devc` is a thin orchestrator over [`@devcontainers/cli`](https://github.com/devcontainers/cli),
`docker`, and `git` for managing the dev container of a project directory. It ships a bundled
default `devcontainer.json` + `Dockerfile` embedded in the binary, so a project needs no
`.devcontainer/` of its own to get a working container.

Every command operates on the current working directory by default; an optional `[PATH]`
positional overrides it. The resolved path identifies the project and its container.

## Commands

```text
devc init    [PATH]                                   Scaffold the default `.devcontainer/` into the project
devc config  [PATH]                                   Configure the project's dev container (TUI)
devc up      [PATH] [--json]                          Create/start the container; print its status
devc build   [PATH] [--no-cache] [--json]             Recreate the container from scratch
devc attach  [PATH] [--build] [--no-clear]            Start (creating if needed) and attach a login shell
devc claude  [PATH] [EXTRA_ARGS...]                   Start and run `claude` (+ forwarded args) in a login shell
devc exec    [PATH] [--cwd DIR] [--env K=V]... -- CMD Start and run CMD directly (no shell)
devc mounts  [PATH] [--json]                          List the container's mounts
devc stop    [PATH]                                   Stop the container
devc down    [PATH]                                   Stop and remove the container
devc status  [PATH]                                   Print `running` / `stopped` / `missing`
```

Run `devc --help` for the full command list, `devc <COMMAND> --help` for a command's options, and
`devc --version` to print the version.

Notes:

- `init` writes the bundled default into the project's `.devcontainer/` — `devcontainer.json`
  verbatim (comments kept, no mount fences) plus `Dockerfile`, `post-create.sh`,
  `initialize-command.sh` and `scripts/`, with the shell scripts executable. It is the same
  scaffolding `config` does on first creation, without the TUI: use it when you want the baseline
  on disk to hand-edit. Non-interactive — it never prompts, never builds, and never triggers the
  first-run roots wizard. It writes only into a **missing or completely empty** `.devcontainer/`:
  any existing content — a file, a subdirectory, a dotfile — makes it write nothing and exit 1,
  naming what it found. So does an existing config in either location
  (`.devcontainer/devcontainer.json` or a root `.devcontainer.json`), with a message pointing at
  `devc config`. The strict rule means what `init` leaves behind is exactly the bundle: it cannot
  silently overwrite a hand-written `Dockerfile` or `scripts/*.sh`, and cannot strand unrelated
  files that the bundle does not replace.
- `up` prints `<containerId> running — workspace <remoteWorkspaceFolder>`, or the
  `ContainerInfo` JSON with `--json`.
- `build` recreates the container (`up --remove-existing-container`) without attaching, and
  prints the same line as `up`. Mounts are bound when the container is *created*, so this — not
  an image-only build — is what makes a `devcontainer.json` change take effect. `--no-cache`
  also rebuilds the image without the Docker layer cache.
- `attach --build` forces the same rebuild before attaching; `--no-clear` keeps the
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
  `remoteEnv` is not stored on the container — it is applied by the *client* per connection
  (VS Code to its terminals, `devcontainer exec` to its child), so `docker exec` never sees
  it. `devc` therefore re-derives it from whichever config is in play — the project's own
  `devcontainer.json` in project mode, the materialized default in the zero-config path — and
  passes `-e K=V` per entry. Values resolve `${containerWorkspaceFolder}`,
  `${localWorkspaceFolder}`, `${localWorkspaceFolderBasename}` and `${localEnv:VAR}`; other
  variables can't be resolved host-side and pass through literally. A config that can't be
  parsed logs a warning and yields no `remoteEnv` rather than failing the command.
- **Git worktrees**: `up` passes `--mount-git-worktree-common-dir` and the container-side
  workspace path is computed to match the CLI's own algorithm.
- After a successful `up`, the container is renamed to `devc-<basename>-<hash>` and its image
  is given a `<name>:latest` alias tag (both best-effort, never fatal).

`attach`/`claude` also propagate the host terminal identity (`TERM`, `TERM_PROGRAM`,
`TERM_PROGRAM_VERSION`, `$TMUX`) and tint the terminal for the duration of the attach so a
container shell reads as visually distinct from a local one.

## Claude config: `~/.config/devc/.claude`

Anything you want the in-container agent to see goes in `~/.config/devc/.claude`. The
directory is bind-mounted read-only at `/usr/local/share/devc/claude-seed`, and on every
container create `scripts/agents-setup.sh` (run by `post-create.sh`) symlinks each entry into the container's `~/.claude`:

```text
~/.config/devc/.claude/CLAUDE.md      →  /home/vscode/.claude/CLAUDE.md
~/.config/devc/.claude/settings.json  →  /home/vscode/.claude/settings.json
~/.config/devc/.claude/statusline.sh  →  /home/vscode/.claude/statusline.sh
```

- **Top-level files only.** Directories are ignored — the `devc:skills` fence owns
  `~/.claude/skills/`, and per-skill mounts are configured through `devc config` instead.
- **Read-only, and live.** Edits on the host show up immediately; no rebuild, no recreate. File
  modes carry over, so `statusline.sh` keeps its exec bit.
- **Deletions are honored.** Remove a file here and its link disappears on the next container
  create.
- **Missing is fine.** `devc` creates the directory if absent; an empty one is valid. Files that
  aren't there simply aren't linked.
- The container's own `~/.claude` stays a per-workspace volume, so `projects/`, `todos/`, and
  credentials persist per project and are never touched by this.

Migrating from an older `devc`: the first time the directory is created, `devc` copies
`~/.claude/CLAUDE.md`, `~/.claude/settings.devc.json` (→ `settings.json`), and
`~/.claude/statusline.sh` into it, leaving the originals in place. Projects whose
`.devcontainer/devcontainer.json` was written by an earlier `devc` still carry three per-file
binds — `devc` writes infra mounts once at creation and never re-asserts them, so replace them
by hand with:

```jsonc
"initializeCommand": "mkdir -p \"$HOME/.config/devc/.claude\"",
// …and in "mounts", replacing the three ~/.claude/* bind lines:
"type=bind,source=${localEnv:HOME}/.config/devc/.claude,target=/usr/local/share/devc/claude-seed,consistency=cached,readonly",
```

The `initializeCommand` is what creates the mount source on a machine without `devc` installed
(a bind mount with a missing source is a hard error, not an auto-created directory). It has to
be top-level — it is the only host-side lifecycle hook — so a project that needs its own
`initializeCommand` should either keep the `mkdir -p` in it or drop the `claude-seed` mount
alongside it.

## Shell setup: `shell/` folders

Every interactive container shell sources two optional layers of `*.sh`, after devc's own
additions (prompt, terminal title, `nvm` auto-use) and before the `devc attach` first-prompt
clear:

```text
~/.config/devc/shell/*.sh          your preferences, every project   (host, read-only mount)
<project>/.devcontainer/shell/*.sh this project's settings           (workspace)
```

```sh
# ~/.config/devc/shell/10-prefs.sh
alias ll='ls -alF'
export EDITOR=vim

# .devcontainer/shell/10-project.sh
alias t='deno task test'
export DATABASE_URL=postgres://localhost/dev
```

- **User first, then project**, so a project's committed settings win on conflict — the same
  `system → global → local` order git uses. A project that *assigns* rather than appends to a
  shared variable (`PS1`, `PATH`) will therefore override your personal one.
- **Order within a layer** is glob (name) order. Prefix with `10-`, `20-`, … to control it.
- **Optional.** Missing or empty directories do nothing. Neither is created or written by
  `devc config`, and neither is ever overwritten, so both are yours — commit the project one or
  `.gitignore` it. Only `*.sh` is sourced; a `README.md` alongside is ignored.
- **Live.** Both layers are *sourced* from `~/.bashrc`, not appended into it — edits apply to the
  next new shell, with no rebuild and no recreate. Deleting a file stops it being read. The user
  layer is a read-only bind mount, so host edits are picked up the same way.
- **Both modes.** The project layer works in the zero-config path too: a project can have only
  `.devcontainer/shell/` and no `devcontainer.json` and still get it, since it is found through
  the workspace mount at `$PROJECT_PATH`.
- **Interactive shells only.** The project layer additionally needs `PROJECT_PATH` — the
  workspace root devc sets as `remoteEnv` and re-passes on `exec`/`attach`; a raw
  `docker exec … bash` without it deliberately sources nothing. The user layer is at a fixed
  container path and does not depend on it.
- Avoid setting `PROMPT_COMMAND` outright (append to it instead) — replacing it drops the
  first-prompt clear that `devc attach` installs after these layers run.

`~/.config/devc/shell` is created by `initialize-command.sh`, because a bind mount errors on a
missing source rather than creating it. Projects whose `.devcontainer/devcontainer.json` was
written by an earlier `devc` predate the mount — `devc` writes infra mounts once at creation and
never re-asserts them — so add it by hand to pick up the user layer:

```jsonc
"type=bind,source=${localEnv:HOME}/.config/devc/shell,target=/usr/local/share/devc/shell,consistency=cached,readonly",
```

## Development

```sh
deno task run    -- <command> [args]   # run from source
deno task test                         # unit tests
deno task check                        # type-check
deno task build                        # compile the `devc` binary (embeds default/)

# Two pieces of the baseline are bash inside default/scripts/, so they are covered by shell
# harnesses rather than `deno task test`. Each extracts a fenced block from the real script and
# runs it against temp dirs, so the tests cannot drift from the implementation:
bash tests/seed_link_test.sh default/scripts/agents-setup.sh       # devc:seed-link
bash tests/shell_dirs_test.sh default/scripts/bashrc-additions.sh  # devc:shell-dirs
```

### `devc config`

`devc config [PATH]` is a picker-driven flow for the project's `.devcontainer/`. You *select*
folders — no typing paths:

- **Source folders** and **skills folders** are each chosen with a multi-select, type-to-filter
  picker: `↑/↓` move, `→` open a folder, `←` (or backspace on an empty filter) go up, `space`
  ticks/unticks (selection persists across folders), `⏎` confirms, `esc` cancels. Type any
  characters to filter the current folder.
- Each picker screen (see `.plans/design/wizard/` for the reference frames) is a banner naming
  the screen — `WORKSPACE CONFIG` or `GLOBAL CONFIG` — over two labelled lists: what is picked
  so far (`Source Folders`, `Skills`, `Source Folder Roots`, `Skills Folder Roots`) and the
  browser you add from (`Add Source Folders`, `Add Skills`, `Add Roots`), with the key legend
  under a rule at the foot.
- The **project folder is pinned** in the source picker (`◎` — a `◉` you cannot untick —
  labelled "this project (always mounted)"): the dev container binds it on its own, so it heads
  the picked list and picking nothing still mounts it. It also appears in the review, above the
  `devc:source` rows.
- Markers: `◯` not picked · `◉` picked · `◎` mounted regardless (the project folder, or a mount
  another pick drags in — such as a picked worktree's primary repo `.git`).
- Your configured roots are **shortcuts, not boundaries**: the picker opens on the list of roots,
  but `←` walks above a root like any other folder, and at the filesystem root it wraps back to the
  shortcut list — so you can mount a folder from anywhere on the machine. The roots themselves
  aren't selectable; tick one from its parent folder.
- A **review** summary then a single `Apply?` confirm writes the two managed mount blocks
  (`devc:source`, `devc:skills`); everything else in the file is left untouched.
- Afterwards, `devc config` compares what it wrote to what was already on disk and only then
  offers a rebuild, since mounts take effect at container-create time:
  - **Changed**, container exists → `Rebuild now? [Y/n]`, which runs the same recreate as
    `devc build`.
  - **Changed**, no container yet → `Build it now? [Y/n]`.
  - **Unchanged** → `No config changes — no rebuild needed.` and no prompt. Ticking a folder off
    and back on ends at the same bytes, so it counts as no change and the file is not even
    rewritten. Declining a rebuild prints a reminder to run `devc build` later.

**Roots** (where the pickers are scoped) live in `~/.config/devc/config.json`, stored folded
to `~/…`. On first run — or any time roots are missing — `devc config` collects them first with
a free-navigation picker. Run **`devc config --global`** to reconfigure them at any time.
