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

A guiding principle: **the config `devc` produces is a standard, spec-compliant `.devcontainer/` that a developer can read, understand, and hand-edit without learning anything `devc`-specific.** `devc config` writes a plain `devcontainer.json` + `Dockerfile`, and from that point on the project is a normal dev container that any devcontainer-aware tool (VS Code, the CLI, CI) understands. **Whatever lands in `.devcontainer/` runs without `devc` installed at all.** That invariant is unconditional: `devc` never writes a `devc`-specific key into that folder, and the launch-time overlay never mutates it. `devc`'s own baseline behavior is carried by the bundled `Dockerfile` (build-time) plus a top-level `postCreateCommand` running `post-create.sh` (create-time) — both standard, inspectable devcontainer mechanisms with no `devc`-specific indirection.

The optional `devc.json` overlay sits outside that contract rather than weakening it, and serves two shapes. **Committed**, it declares that the repo has adopted `devc` as a tool it depends on, much as it might depend on a Makefile or a task runner. **Gitignored**, it is a purely local override — an individual dev adding bind mounts for their own machine, in a repo that need not know `devc` exists and whose `.devcontainer/` no one else sees changed.

Either way a checkout without `devc` still builds and runs from the standard config, merely without the overlay's extra mounts, features and env. Nothing is broken, only un-augmented.

**Managed mount blocks.** So that reconfiguring a project is surgical rather than destructive, the wizard marks the two mount groups it owns — extra source mounts and skills mounts — with comment fences inside the `mounts` array (`// devc:source … // /devc:source` and `// devc:skills … // /devc:skills`). These are ordinary JSONC comments: the devcontainer CLI ignores them and the file remains directly usable, so this is not a hidden abstraction — it is a bookmark. `devc config` only ever rewrites the contents of its two fences. Everything else — the infrastructure mounts written at first creation, the developer's own hand-edits, comments, formatting, and any keys `devc` knows nothing about — is preserved byte-for-byte and **never re-asserted**. In particular, infra mounts are written once when the file is first created; if the developer later edits or removes them, `devc` does not add them back.

### Configuration precedence

Two layers resolve independently.

**Base config** — exactly one `devcontainer.json` is handed to `devcontainer up`. First hit wins; these do not merge, because a base config carries `build`/`image`.

1. `PATH/.devcontainer/devcontainer.json`
2. `PATH/.devcontainer.json`
3. The materialized default — the bundled `devcontainer.json` + `Dockerfile`, with any same-named file from `~/.config/devc/templates/` overriding it per file.

Once a user applies a project-specific config via `devc config`, subsequent commands automatically use it (case 1).

**Overlay** — an optional `devc.json` contributing `mounts`, `additionalFeatures` and `remoteEnv` on top of whichever base won, in project mode as well as the zero-config path. Merged lowest to highest:

1. `~/.config/devc/devc.jsonc`, else `~/.config/devc/devc.json`
2. `PATH/.devc/devc.jsonc`, `.devc/devc.json`, `.devcontainer/devc.jsonc`, `.devcontainer/devc.json` — first hit only, the rest are not consulted

`mounts` append, `remoteEnv` overrides per key, `additionalFeatures` merges per feature id.

Both project locations are first-class and behave identically. `.devcontainer/devc.json` often suits a gitignored local override — one file to ignore, beside the config it overlays — and `.devc/` suits a repo that prefers `devc`'s files grouped in one place.

### Bundled default: baseline via Dockerfile + a top-level `postCreateCommand`

`devc`'s baseline container behavior is split by *when* it can run:

- **Build-time**, baked into cached image layers by the bundled **`Dockerfile`**: installing the Claude CLI and appending the shell additions (prompt, terminal title, `nvm` auto-use, first-prompt clear) from `scripts/bashrc-additions.sh`.
- **Create-time**, run by a **top-level `postCreateCommand`** pointing at `post-create.sh`: the volume-dependent steps that cannot run at build time because volumes are not mounted until the container is created — ownership of the isolated `~/.claude` volume, the per-workspace `~/.claude.json` symlink, the `~/.claude` seed symlinks (see below), and `nvm install` from the project's `.nvmrc`.

The `.devcontainer/` layout follows one rule: the **lifecycle entry scripts live at the root** (`post-create.sh`, `initialize-command.sh` — each the target of a hook named in `devcontainer.json`), and **`scripts/` holds the setup steps and sub-dependencies**. `post-create.sh` itself contains no logic — it only resolves `scripts/` relative to itself (`dirname "$0"`) and calls each step in order (`agents-setup.sh` for Claude/agent config, `node-setup.sh` for nvm); `scripts/bashrc-additions.sh` is a build-time piece the Dockerfile `cat`s into `~/.bashrc`. A developer extends the baseline by editing a step or dropping a new script in `scripts/` and adding a line to `post-create.sh` — the pattern is self-evident from reading the two files, so there is **no** special "user hook" file.

**Shell customization is a third tier — shell-start time.** The last thing `bashrc-additions.sh` does before the attach first-prompt block (the `devc:shell-dirs` fence) is source every `*.sh` from two optional directories: `/usr/local/share/devc/shell` (the host's `~/.config/devc/shell`, bind-mounted read-only — user preferences, every project) then `$PROJECT_PATH/.devcontainer/shell` (this project's settings). User-then-project so a project's committed settings win, matching git's `system → global → local`.

Sourcing rather than appending is what makes it the cheapest tier: edits land on the next new shell (no rebuild, no recreate), deletion is honored by the `-d`/`-f` guards alone, and **nothing in `devc` creates or writes either directory** — so neither is at risk from `copyBundledAssets`, which writes every other bundled asset unconditionally and would clobber user content. Directories rather than single files for two reasons: a single-file bind mount is a hard error when the source is absent, which would defeat "optional" for the user layer; and a directory lets both layers compose from several files (`10-`, `20-` prefixes) instead of forcing one blob. The user layer's mount source is created by `initialize-command.sh`, the one host-side hook, so a clone comes up cleanly on a machine without `devc` installed.

Placement is load-bearing. The block sits *after* everything devc sets, so a layer can override `PS1`, `cd()`, or `precmd`, and *before* the `DEVC_ATTACH` block, which snapshots `PROMPT_COMMAND` and would be clobbered by a file that assigns to it. The project layer resolves through the workspace mount, so it works in the zero-config path with no `devcontainer.json` present; the user layer is at a fixed container path and needs no `PROJECT_PATH` at all. There is no `$PWD` fallback for `PROJECT_PATH`: a shell opened outside `devc` should not source whichever repo it happens to start in.

**Edits apply on recreate, not rebuild.** `post-create.sh` and its `scripts/` are referenced by the copies *in the project's own `.devcontainer/`* (`postCreateCommand: bash "${containerWorkspaceFolder}/.devcontainer/post-create.sh"`), so editing them takes effect on the next container **create** with no image rebuild. Only genuinely build-time bits (the Claude CLI install, the `~/.bashrc` additions) need a rebuild. This is the payoff of `post-create.sh` finding its steps relative to itself: the same file works whether it is the in-project copy or the image-baked one.

There is **no** devcontainer Feature. An earlier design packaged the create-time baseline as a local Feature so it would compose additively with a project's own `postCreateCommand`; that was dropped because a local Feature cannot resolve when `devc up` loads the bundled config out-of-tree via `--config` (`@devcontainers/cli` validates a local Feature against the workspace root, not the config's own directory), which forced a divergence between the zero-config and `devc config` paths. Removing the Feature collapses both onto **one `.devcontainer/` shape** — the same `devcontainer.json`, `Dockerfile`, `post-create.sh`, `initialize-command.sh`, and `scripts/` in both. Additive composition with a developer's own setup is preserved simply by their editing `post-create.sh` (the project copy is theirs; `devc config` only ever rewrites the two mount fences, never the scripts).

`installsAfter: [node]` ordering is not lost either: a **top-level** `postCreateCommand` runs *after all features finish installing*, so `nvm install` still sees the node feature's `nvm` — the ordering guarantee is at least as strong as a feature hook's.

The **zero-config path** is where the mechanism hides its seams. There, `devc up` loads the config out-of-tree and the workspace is the user's project (no `.devcontainer/`), so the two in-project script references cannot resolve. `materializeDefaultConfig` rewrites exactly two paths in the cached copy: `postCreateCommand` → the image-baked `/usr/local/share/devc/post-create.sh` (the Dockerfile `COPY`s the scripts in for this case; in `devc config` mode those baked copies simply go unused), and `initializeCommand` → the host-side `initialize-command.sh` in the cache dir. These are the only transforms, and they exist so the *project* config can stay clean and edit-friendly while the hidden cache copy still runs. Docker cannot conditionally skip a `COPY`, and the Dockerfile needs `scripts/bashrc-additions.sh` at build time in both modes, so the scripts are always baked — a build flag to skip baking in project mode would add machinery without removing the bytes from a layer, and the baked copies are invisible and inert there anyway.

Consequences for the generated config:

- The bundled default `devcontainer.json` carries the top-level `postCreateCommand` directly (referencing the in-project script); the ghcr feature list (deno/go/node/python) is unchanged.
- The bundled `Dockerfile` holds the build-time baseline and `COPY`s `post-create.sh` + `scripts/` into the image; it remains a clean, inspectable extension point rather than a place where `devc` behavior hides behind indirection.

### Host `~/.claude` config: the seed directory

The user's Claude config reaches the container through **one read-only directory bind mount** of `~/.config/devc/.claude` at `/usr/local/share/devc/claude-seed`, not through per-file bind mounts of `~/.claude/*`. `scripts/agents-setup.sh` (run by `post-create.sh`) then symlinks every top-level *file* from the seed into the `~/.claude` volume, pruning links whose seed file has gone away.

Why a directory plus symlinks rather than per-file binds or a copy:

- **Per-file binds assume the files exist.** `mounts` takes Docker `--mount` semantics, where a missing bind source is a hard create-time error (unlike `-v`, which auto-creates a directory). A user lacking any one file could not create a container. A directory source can always be created ahead of time, and an empty one is valid.
- **Symlinks, not copies.** `~/.claude` is a persistent per-workspace volume, so a copy would be additive — a file deleted on the host would survive in the container forever, and recovering deletion would need a manifest of what was copied. Symlinks make deletion fall out of pruning, and preserve the live-edit and read-only semantics of the original binds along with host file modes.
- **Files only; directories ignored.** The `devc:skills` fence mounts per-skill binds under `~/.claude/skills/`, and Docker materializes that intermediate directory at create time — before `postCreate` runs. Linking or copying a seed `skills/` over it would silently nest, or fail on a busy mountpoint or a read-only bind. Ignoring directories removes the whole class of conflict; directory-shaped config is added later as its own fence, not by recursing here.

The part of the baseline that has to run **before** mounts are established is `initializeCommand`, which runs `initialize-command.sh` to create the seed mount source on machines without `devc` (`--mount type=bind` errors on a missing source). It is the only host-side lifecycle hook — the container-side hooks all run after mounts are established, structurally too late — so it sits top-level in the bundled default and, like `postCreateCommand`, is single-valued; a project overriding it keeps the call or drops the seed mount with it. Because it runs on the *host*, the config references the script via `${localWorkspaceFolder}/.devcontainer/initialize-command.sh` — correct for a project whose own `.devcontainer/` holds it; in the zero-config path, where the workspace is the user's project (no `.devcontainer/`), `materializeDefaultConfig` rewrites that one host path to the cache copy. This is the *only* transform applied to the materialized config. `devc` also calls `ensureClaudeSeedDir` on every `up`, which owns what a shell one-liner cannot: the not-a-directory guard and the one-time migration off the old per-file layout — so in the `devc`-driven path the hook is belt-and-suspenders.

## Global user configuration

The first time any `devc` command is executed, the tool enters a one-time **global config mode** before running the requested command. This mode prompts the user for:

- **Code folder roots** — one or more directories where code projects live.
- **Skills folder roots** — one or more directories where agent skills live.

These values are saved as lists in a global config file at `~/.config/devc/config.json`. Once that file exists, the global config prompt no longer runs automatically before other commands. The user can re-run it later via `devc config` (global settings step) if they want to change the root lists.

Example global config:

```json
{
  "codeRoots": ["~/code", "~/work"],
  "skillsRoots": ["~/.agents/skills", "~/team-skills"]
}
```

**Namespace.** One namespace throughout: `devc` — binary name, container-name prefix, image path under `/usr/local/share/devc`, and the global config directory `~/.config/devc/` (a single code-level constant, `CONFIG_DIR`). An earlier revision parked the config directory at `~/.config/devc-tui/` to avoid colliding with other `devc` tooling; that is gone, and any doc still saying `devc-tui` predates the move.

**No global template overrides for now.** The bundled default config is materialized directly (embedded assets → a cache dir passed to `devcontainer up --config`). There is no user-editable global template directory in this version; customization happens per-project via `devc config`.

## First-run flow

1. User runs `devc <command>` for the first time.
2. If `~/.config/devc/config.json` does not exist, the TUI global config prompt appears.
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

The flow is **picker-driven and sequential**, not a sidebar wizard: the folder-selection steps
each take the full screen, and the surrounding steps (overview, review, confirm, rebuild prompt)
are ordinary inline prompts on the normal screen, the way a shell tool scrolls. The reference
frames live in `.plans/design/wizard/` and are authoritative for the picker screens.

A picker screen is:

- **Banner** — line 1, uppercase: `WORKSPACE CONFIG` (project steps) or `GLOBAL CONFIG` (roots).
- **Picked list** — a Title Case heading (`Source Folders`, `Skills`, `Source Folder Roots`,
  `Skills Folder Roots`) over the absolute paths ticked so far.
- **Browser** — an `Add …` heading (`Add Source Folders`, `Add Skills`, `Add Roots`) carrying the
  current directory, a `>` filter line, then the subfolders of that directory.
- **Footer** — one full-width rule and a key legend for whichever list holds the cursor.

The two lists are separated by whitespace, not rules or boxes, and neither is styled by focus —
the `▸` row cursor alone says which one the keys drive.

Markers: `◯` not picked · `◉` picked · `◎` mounted regardless of the selection (the project
folder — see Step 2). Keys:

- `↑` / `↓` — move; `↑` off the top of the browser steps into the picked list, `↓` off its
  bottom returns (`Tab` toggles too).
- `→` open a folder · `←` (or backspace on an empty filter) go up · type to filter.
- `Space` — tick/untick in the browser; remove in the picked list.
- `Enter` — done with this step · `Esc` — cancel the flow.

### Starting the wizard

When the user runs `devc config [PATH]`:

1. Resolve the project directory (`PATH` or cwd).
2. If `~/.config/devc/config.json` is missing, run the **Global config** step first and persist the code/skills root lists.
3. Load the base container configuration into memory:
   - If `PATH/.devcontainer/devcontainer.json` exists, load it (and a sibling `Dockerfile` if present).
   - Otherwise, start from the bundled default `devcontainer.json` + `Dockerfile`.
4. Proceed to the **Project overview** step.

### Step 1: Project overview

Two inline lines before the first picker: the config path being written, and whether this run is
creating a new config or updating the existing one.

### Step 2: Source code mounts

The current project directory is always mounted as the devcontainer workspace. This step lets the user add **extra source code folders** that should also be available inside the container.

- Screen `WORKSPACE CONFIG` / `Source Folders` / `Add Source Folders`, opening on the configured
  **code folder roots**. The roots are shortcuts, not boundaries: `←` walks above a root like any
  other folder, and at the filesystem root it wraps back to the shortcut list, so any folder on the
  machine can be mounted. The roots themselves are not selectable — tick one from its parent.
- The **project folder is pinned** at the head of the picked list with `◎` and the note "this
  project (always mounted)", and is inert in the browser — the container binds it either way, so
  ticking it would only add a second bind on the same target. It is not written to the fence.
- Container paths are derived, not edited: `/workspaces/<basename>`, keeping the folder's
  sub-path under the code root it falls under (so `~/code/a/b` → `/workspaces/a/b`). Source
  mounts are read-write. Duplicate container paths are skipped with a note.
- A picked **git worktree** additionally contributes a mount of its primary repo's `.git`. Both
  container targets mirror from one shared base — the configured code root when it holds the primary,
  otherwise the worktree/primary **common ancestor** (what the devcontainer CLI does for a worktree
  opened as the project folder) — so the worktree's relative `gitdir:` link still resolves inside the
  container. A worktree whose `gitdir:` is *absolute* cannot work whatever is mounted, and is flagged
  inline in the browser instead.
- That primary `.git` mount is **shown in the picked list the moment its worktree is ticked** (and
  on the first frame for a worktree pre-ticked from the fence), indented under the worktree that
  requires it, marked `◎` with the note "required by worktree `<name>`". Like the pinned project
  folder it is inert — the picks cursor steps over it, so it cannot be unticked while a worktree
  needing it is picked; unpicking the last such worktree removes it. Two worktrees of one primary
  show the row once, under the first of them, and picking the primary's whole working tree removes
  it (that mount already covers the `.git`). Because the wizard writes that mount into the same
  fence it reads, reopening a config preselects it *and* re-derives it — the pick is **absorbed**
  into the derived row, so the path is listed once, and it is inert in the browser as well.

### Step 3: Skills mounts

Configure which agent skills folders are mounted into the container. Skills are **opt-in**: the bundled zero-config default mounts no skills, so a project gets skills only after they are configured here.

- Screen `WORKSPACE CONFIG` / `Skills` / `Add Skills`, opening on the configured **skills folder
  roots** — shortcuts, with the same free navigation as Step 2.
- Container paths are derived, not edited: `~/.claude/skills/<basename>`, mounted read-only.
  Duplicate container paths are skipped with a note.
- **Remembered selection.** When the wizard applies, the resulting skills list is persisted as the user's *most recent* skills selection. A **new** project's Skills step is pre-seeded from that remembered list (entries whose host path no longer exists are dropped), so a user who mounts the same skills across projects does not re-pick them every time. Reconfiguring an existing project seeds from that project's own `devc:skills` fence instead. (Source mounts are not remembered — they are project-specific — so Step 2 starts empty for new projects.)

### Step 4: Review & apply

An inline summary printed before anything is written to disk: the serialized contents of the two
managed fences (`devc:source`, `devc:skills`) — the only regions the wizard writes — with the
implicitly mounted project folder listed above the source rows so an empty fence never reads as
"no source mounts". Then a single `Apply? [Y/n]` confirm; declining writes nothing.

When the user accepts:

1. Create `PATH/.devcontainer/` if it does not exist.
2. **First creation** (no existing `PATH/.devcontainer/devcontainer.json`): write the base `devcontainer.json` from the bundled default, with the two managed fences inserted into the `mounts` array and populated from the configured source/skills mounts. Write the base `Dockerfile` as-is.
3. **Update in place** (file already exists): rewrite only the `devc:source` and `devc:skills` fence contents; preserve everything else byte-for-byte (infra mounts, hand-edits, comments, unknown keys). Do not rewrite the `Dockerfile`.
4. Persist the applied skills list as the remembered selection (see Step 3).
5. Report whether the config actually changed, and offer a rebuild when it did (see below).
6. Return to the shell with a success message.

### Rebuild prompt

Mounts are bound at container-create time, so a config change is inert until the container is recreated. `config` therefore ends by comparing the bytes it would write against the bytes already on disk — an exact comparison that needs no separate model diffing — and reports one of three outcomes:

| Situation | Message | Prompt |
| --- | --- | --- |
| Text identical to what is on disk | `No config changes — no rebuild needed.` | none |
| Changed, container `running` / `stopped` | `Config changed — the dev container must be rebuilt for the new mounts to take effect.` | `Rebuild now? [Y/n]` |
| Changed, container `missing` | `No dev container exists for this project yet.` | `Build it now? [Y/n]` |

Accepting runs the same recreate as [`build`](#build) and prints its summary line; declining prints a reminder to run `devc build` later. A failed rebuild is reported but does not fail `devc config` — the config was still written.

The "no changes" case is the point of the comparison: a user who ticks a folder off and back on, or re-runs `config` and confirms the same selection, ends at byte-identical text. That is not a change, the file is not even rewritten (its mtime does not move), and no rebuild is offered. Only genuine edits prompt, so the prompt stays meaningful.

Global roots (`devc config --global`) never prompt — `codeRoots`/`skillsRoots` and the remembered skills list scope the pickers and do not affect the container.

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
  init     Scaffold the default dev container config into the project
  config   Configure the dev container for the current project (TUI)
  attach   Attach to the dev container for the current project
  claude   Launch Claude inside the dev container for the current project
  up       Start the dev container for the current project
  build    Rebuild the dev container for the current project
  exec     Execute a command inside the dev container for the current project
  mounts   List container mounts for the current project
  stop     Stop the dev container for the current project
  down     Remove the dev container for the current project
  status   Show dev container status for the current project

Run "devc <COMMAND> --help" for more information on a command.
```

## `init`

Write the bundled default `.devcontainer/` into the project and exit — the same scaffolding
[`config`](#config-tui) does on first creation, without the TUI and without the two managed mount
fences. It is the non-interactive way to get the baseline on disk to hand-edit, for a user who
wants the files rather than the picker.

```text
Usage: devc init [PATH]

Arguments:
  [PATH]  Path to the project (default: current directory)

Options:
  -h, --help  Print help
```

Writes `devcontainer.json` verbatim from the bundled default (comments preserved) plus
`Dockerfile`, `post-create.sh`, `initialize-command.sh` and `scripts/`, with the two entry scripts
and every `scripts/*.sh` made executable — one shared `installBundledAssets` does the asset half
for both `init` and `config`, so the two cannot drift. No fences are written: `config` inserts
them into a fence-less config when the user later picks mounts.

**Refuses to clobber — `.devcontainer/` must be missing or empty.** Two guards, each writing
nothing and exiting 1:

- An existing devcontainer config, in *either* location — `.devcontainer/devcontainer.json` or a
  root `.devcontainer.json`. Both count because creating the directory form beside an existing root
  form would leave two configs and make which one applies ambiguous. The message points at
  `devc config`, which is the tool for a project that already is a dev container.
- *Any* other content in `.devcontainer/` — a file, a subdirectory, a dotfile — reported with what
  was found.

The second guard is deliberately stricter than "don't overwrite what I provide".
`installBundledAssets` replaces exactly the bundle's own paths, so a laxer rule would silently
overwrite a hand-written `Dockerfile` or `scripts/*.sh` *and* leave everything the bundle does not
cover sitting there as stale debris — a `.devcontainer/` that is half old config, half new, with no
signal that it happened. Requiring an empty directory makes the postcondition exact: what `init`
leaves behind is the bundle and nothing else. An empty directory is accepted, since there is
nothing to lose and someone may simply have `mkdir`'d it.

**Non-interactive by construction.** `init` never prompts, never offers a rebuild, and is
dispatched *before* the first-run global-config hook, so a user with no `~/.config/devc/config.json`
is not sent through the roots wizard for a command that has no use for roots.

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

## `build`

Recreate the dev container for the project in the current working directory, without attaching.

Bind mounts are established when a container is **created**, so a `devcontainer.json` change only takes effect after a recreate — `build` is that operation (`devcontainer up --remove-existing-container`), not an image-only build. `--no-cache` additionally passes `--build-no-cache` for the case where the image itself must be rebuilt from scratch (a changed base image, a stale layer).

```text
Usage: devc build [PATH] [OPTIONS]

Arguments:
  [PATH]  Path to the project (default: current directory)

Options:
      --no-cache   Rebuild the image without the Docker layer cache
      --json       Output container status as JSON
  -h, --help       Print help
```

Output matches `up`: `<containerId> running — workspace <remoteWorkspaceFolder>`, or the `ContainerInfo` JSON with `--json`. `attach --build` performs the same recreate before attaching.

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

`devc` is fully self-contained. At runtime it depends only on external CLIs it shells out to — `docker`, `devcontainer` (`@devcontainers/cli`), and `git` — plus its own embedded assets (the bundled default `devcontainer.json`, `Dockerfile`, `post-create.sh`, `initialize-command.sh`, and `scripts/`). The embedded assets ship inside the binary (`deno compile --include`), so no part of the tool reaches outside the repository or the installed binary to find configuration or scripts it needs.
