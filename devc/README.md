# devc

`devc` is a thin orchestrator over
[`@devcontainers/cli`](https://github.com/devcontainers/cli), `docker`, and
`git` for managing the dev container of a project directory. It ships a bundled
default `devcontainer.json` + `Dockerfile` embedded in the binary, so a project
needs no `.devcontainer/` of its own to get a working container.

Every command operates on the current working directory by default; an optional
`[PATH]` positional overrides it. The resolved path identifies the project and
its container.

## Install

```sh
curl -fsSL https://github.com/bmingles/devc-tools/releases/latest/download/install.sh | sh
```

That drops a prebuilt `devc` into `~/.local/bin` (macOS and Linux, Intel and
ARM) — **Deno is not needed to use it**, only to develop it. See the
[repo README](../README.md#install) for the env knobs and the `PATH` note.

**`docker` is the only thing `devc` needs on your `PATH`.** The
[`devcontainer` CLI](https://github.com/devcontainers/cli) is embedded in the
binary — see [The embedded devcontainer CLI](#the-embedded-devcontainer-cli).

To build it from a clone instead, see [Development](#development).

## Commands

```text
devc init    [PATH]                                   Scaffold the default `.devcontainer/` into the project
devc config  [PATH]                                   Configure the project's source/skills mounts (TUI)
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

Run `devc --help` for the full command list, `devc <COMMAND> --help` for a
command's options, and `devc --version` to print the version.

Notes:

- `init` writes the bundled default into the project's `.devcontainer/` —
  `devcontainer.json` verbatim (comments kept, no mount fences) plus
  `Dockerfile`, `post-create.sh`, `initialize-command.sh` and `scripts/`, with
  the shell scripts executable. It is the same scaffolding `config` does on
  first creation, without the TUI: use it when you want the baseline on disk to
  hand-edit. Non-interactive — it never prompts, never builds, and never
  triggers the first-run roots wizard. It writes only into a **missing or
  completely empty** `.devcontainer/`: any existing content — a file, a
  subdirectory, a dotfile — makes it write nothing and exit 1, naming what it
  found. So does an existing config in either location
  (`.devcontainer/devcontainer.json` or a root `.devcontainer.json`), with a
  message pointing at `devc config`. The strict rule means what `init` leaves
  behind is exactly the bundle: it cannot silently overwrite a hand-written
  `Dockerfile` or `scripts/*.sh`, and cannot strand unrelated files that the
  bundle does not replace.
- `up` prints `<containerId> running — workspace <remoteWorkspaceFolder>`, or
  the `ContainerInfo` JSON with `--json`.
- `build` recreates the container (`up --remove-existing-container`) without
  attaching, and prints the same line as `up`. Mounts are bound when the
  container is _created_, so this — not an image-only build — is what makes a
  `devcontainer.json` change take effect. `--no-cache` also rebuilds the image
  without the Docker layer cache.
- `attach --build` forces the same rebuild before attaching; `--no-clear` keeps
  the shell-init output on screen instead of clearing on the first prompt.
  `attach`/`claude` exit with the attached shell/command's own exit code (e.g.
  130 on a signal-driven detach); `devc`/`docker` infra failures exit 125.
- `exec` runs the command after `--` directly (no shell) and exits with the
  command's own exit code; `devc`/`docker` infra failures exit 125. `--env` is
  repeatable and a value without `=` is an error (exit 125).
- `mounts` prints `type\tsource -> destination\trw|ro` rows, or the
  `ContainerMount[]` JSON with `--json`. With no container it prints
  `No container for <path>` (text) / `[]` (json).
- Lookup commands (`status`/`stop`/`down`/`mounts`) locate the container by its
  `devcontainer.local_folder` label and never start anything.

## How it works

- **Create / start** shells out to `devcontainer up --workspace-folder <PATH>`;
  the final line of its JSON output carries the `containerId`, `remoteUser`, and
  `remoteWorkspaceFolder`.
- The bundled default config is materialized to a cache dir and passed as
  `--config <dir>/devcontainer.json`. If the project has its own
  `.devcontainer/devcontainer.json` (or `.devcontainer.json`), that is used
  instead. Exactly one of them is handed to `devcontainer up` — they do not
  merge, since a base config carries `build`/`image`.
- That cache dir is **content-addressed**: `~/.cache/devc/default-<key>/`, where
  the key is a hash of the bundled config tree, your
  [`templates/`](#default-overrides-configdevctemplates) overlay, and whether
  this project opts into [devc-bridge](#devc-bridge-the-opt-in-feature). Same
  inputs, same directory, and nothing is rewritten — a repeat `up` costs a hash
  and a `stat`. Different inputs get their own directory, so two `devc` versions
  (or a `devc` and a program embedding the same library) cannot rewrite each
  other's config out from under it. A first write for a given key is staged in a
  sibling `.tmp-…/` and renamed into place, so a concurrent `devcontainer up`
  reading that config never sees a half-written tree.
- An optional [`devc.json` overlay](#optional-overlay-devcjson) contributes
  extra `mounts`, `additionalFeatures` and `remoteEnv` on top of whichever base
  config won, in both modes. It is translated to `devcontainer up` CLI flags and
  never written into the project's config. This is also where `devc config`
  writes the source/skills mounts it manages, so that flow never touches
  `.devcontainer/` either.
- **exec / attach** run via `docker exec` under `remoteUser` in
  `remoteWorkspaceFolder`. `remoteEnv` is not stored on the container — it is
  applied by the _client_ per connection (VS Code to its terminals,
  `devcontainer exec` to its child), so `docker exec` never sees it. `devc`
  therefore re-derives it from whichever config is in play — the project's own
  `devcontainer.json` in project mode, the materialized default in the
  zero-config path — with the overlay's `remoteEnv` layered on top (base < user
  `devc.json` < project `devc.json`), and passes `-e K=V` per entry. Values
  resolve `${containerWorkspaceFolder}`, `${localWorkspaceFolder}`,
  `${localWorkspaceFolderBasename}` and `${localEnv:VAR}`; other variables can't
  be resolved host-side and pass through literally. A config that can't be
  parsed logs a warning and yields no `remoteEnv` rather than failing the
  command.
- **Git worktrees**: `up` passes `--mount-git-worktree-common-dir` and the
  container-side workspace path is computed to match the CLI's own algorithm.
- After a successful `up`, the container is renamed to `devc-<basename>-<hash>`
  and its image is given a `<name>:latest` alias tag (both best-effort, never
  fatal).

`attach`/`claude` also propagate the host terminal identity (`TERM`,
`TERM_PROGRAM`, `TERM_PROGRAM_VERSION`, `$TMUX`) and tint the terminal for the
duration of the attach so a container shell reads as visually distinct from a
local one.

### The library: `@devc-tools/core`

Everything above except attaching an interactive shell — start/rebuild/stop/down,
status, mounts, exec, the `devc.json` overlay, the config wizard's pure helpers —
lives in the sibling [`devc-core/`](../devc-core/README.md) package and is
consumed from source here. `devc` compiles unchanged into the same `deno compile`
binary described below; `devc-core` additionally publishes to npm as
`@devc-tools/core`, for a programmatic consumer (a coding-agent extension, a
script) that wants `ContainerInfo` back as a value instead of parsing a CLI's
stdout. See [`.plans/archived/devc-core-npm-library.md`](../.plans/archived/devc-core-npm-library.md)
for the design.

### The embedded devcontainer CLI

`devc` does not look for a `devcontainer` on your `PATH`. It depends on
`@devcontainers/cli` as a pinned npm package, which `deno compile` embeds in the
binary — so `devc up` works on a machine with only Docker installed, and can
never disagree with a differently-versioned CLI someone happened to install.

`@devcontainers/cli` publishes no programmatic API — its `package.json` declares
only `bin`, and importing its bundle _runs_ the CLI against `process.argv` and
then calls `process.exit()`. So `devc` re-execs **itself** with a hidden
`__devcontainer` subcommand: that child sets `process.argv` and imports the
bundle, becoming a devcontainer CLI, and the parent pipes its stdout exactly as
it piped the old PATH binary's. Nothing about the argv `devc` builds changed.

Two consequences worth knowing:

- **`devc` runs with an unscoped `--allow-run`**, where it used to allowlist
  `docker,devcontainer,git,tmux,tty`. A `devcontainer.json` may declare an
  `initializeCommand`, which the CLI runs on the **host** through `/bin/sh -c`
  (devc's own bundled default declares one), and an allowlist containing
  `/bin/sh` permits every host command anyway. It also gains `--allow-sys` and
  `--allow-net`, both the CLI's: `osRelease` at startup, and its own HTTPS
  fetches of Features from OCI registries during `up`. The
  `Info Failed to resolve '<name>' for allow-run` line Deno used to print for
  each missing allowlisted binary goes away with the allowlist.
- **Upgrading the CLI is a `devc` release.** The version is pinned in
  `devc/deno.json`'s `imports`, alongside the identical pin in
  `.github/workflows/publish-feature.yml`; bump both together.

## Optional overlay: `devc.json`

Whatever lands in `.devcontainer/` runs **without `devc` installed at all** —
that is the rule the whole tool is built around. `devc.json` does not weaken it:
the overlay is turned into `devcontainer up` flags at launch and is _never_
written into the project's `devcontainer.json`. A checkout without `devc` still
builds and runs from the standard config; it just does not get the overlay's
extra mounts, features and env. Un-augmented, not broken.

Three optional keys, in a file that is itself optional:

```jsonc
{
  // → --mount, appended to the base config's own mounts
  // Only type/source/target[/external] — see "Mount specs" below.
  "mounts": [
    "type=bind,source=${localEnv:HOME}/notes,target=${containerWorkspaceFolder}/../notes"
  ],
  // → --additional-features, merged into the base config's `features` per feature id
  "additionalFeatures": {
    "ghcr.io/devcontainers/features/rust:1": { "version": "latest" }
  },
  // → --remote-env, overriding the base config's `remoteEnv` per key
  "remoteEnv": { "MY_VAR": "value" }
}
```

Where it can live — **first hit wins per level, and the losers are not merged**:

```text
~/.config/devc/devc.jsonc          your own, applied to every project   (lowest precedence)
~/.config/devc/devc.json
<project>/.devc/devc.jsonc         this project                         (highest precedence)
<project>/.devc/devc.json
<project>/.devcontainer/devc.jsonc
<project>/.devcontainer/devc.json
```

- **Both project locations are first-class**, and behave identically.
  `.devcontainer/devc.json` is often the better fit for a **gitignored local
  override** — one file to `.gitignore`, sitting beside the config it overlays —
  while `.devc/` suits a repo that wants `devc`'s files grouped in one place.
- **Committed or gitignored, both are valid.** Committed, it says the repo has
  adopted `devc` as a tool it depends on. Gitignored, it is a purely local
  override: you add bind mounts for your own machine in a repo that need not
  know `devc` exists, and the `.devcontainer/` your teammates check out is
  untouched by definition.
- **Applies in both modes** — a project with its own
  `.devcontainer/devcontainer.json` gets the overlay just like the zero-config
  path does.
- **User under project**: `mounts` concatenate (yours first), `remoteEnv`
  overrides per key, and `additionalFeatures` merges per feature id —
  whole-value replace, options objects are _not_ deep-merged.
- `.json` vs `.jsonc` is naming convention only; both are parsed as JSONC
  (comments, trailing commas).
- **Substitution.** Mount specs and `remoteEnv` values resolve
  `${containerWorkspaceFolder}`, `${localWorkspaceFolder}`,
  `${localWorkspaceFolderBasename}` and `${localEnv:VAR}` — both reach Docker
  without passing through the devcontainer CLI. `additionalFeatures` is
  deliberately left alone: the CLI merges that JSON into the config and runs its
  own substitution over it.
- **Errors are loud.** A `devc.json` that doesn't parse fails the command,
  naming the file — this file exists only for `devc`, and silently starting a
  container without your mounts is worse. An unrecognized top-level key warns on
  stderr naming the key (so a typo like `"mount"` is visible) and is otherwise
  ignored. An empty file is simply no overlay.
- Mounts take effect at container-create time, so run `devc build` after editing
  one.
- Only these three keys have a `devcontainer up` flag. A project needing
  `containerEnv`, `forwardPorts`, `runArgs` and friends should run `devc init`
  and edit its own `devcontainer.json`. There is no flag for a lifecycle command
  either — to run something at create time, use the
  [project post-create hook](#project-post-create-hook-devc-post-createsh), which
  works without a `.devcontainer/` at all.
- `devc config` writes the `mounts` key's two managed fences here — see
  [which file it writes](#which-file-it-writes). The other keys are yours; the
  wizard never touches them.
- An overlay mount whose target collides with a base mount is not detected or
  deduped — Docker fails with `Duplicate mount point`, which says exactly what
  happened.
- `devc init` is unaffected and still requires a **missing or empty**
  `.devcontainer/`: a lone `devc.json` in there counts as content. Move it
  aside, run `init`, move it back.

### Mount specs: what an overlay mount can say

Overlay mounts become `devcontainer up --mount` args, and that flag accepts a
**strictly smaller** vocabulary than a `devcontainer.json` `mounts` entry does.
The CLI validates each one against its own regex:

```text
type=<bind|volume>,source=<source>,target=<target>[,external=<true|false>]
```

That is the whole grammar. Field order is fixed, and neither path may contain a
comma. Anything else — including **`readonly`** and **`consistency=cached`** —
is rejected outright, so:

- **There is no read-only overlay mount.** The CLI re-serializes each parsed
  spec as `type=…,src=…,dst=…` before it reaches `docker run`, so even a
  smuggled field would be dropped. Only _string_ mounts written directly in a
  `devcontainer.json` `mounts` array are passed through verbatim — which is how
  the infra `claude-seed` bind keeps its `readonly`. Everything `devc config`
  writes is read-write, including skills folders.
- Restoring read-only would mean granting the container `SYS_ADMIN` (so it could
  `mount -o remount,bind,ro` its own mounts). Docker's default seccomp profile
  fixes the `mount` allowance at container-create time from the configured
  capabilities, so even `docker exec --privileged` cannot do it after the fact.
  Trading a container-escape-class capability for read-only skill folders is a
  bad deal, so devc does not.
- `consistency=cached` is no loss: it was an osxfs-era hint that modern Docker
  Desktop ignores under VirtioFS/gRPC-FUSE.

devc validates every entry against the same regex when it loads the file, so a
bad spec fails naming the file, the index and the offending field — rather than
surfacing later as the CLI's context-free `Unmatched argument format`.

## Project post-create hook: `devc-post-create.sh`

The overlay covers **declarative** extension — mounts, features, env. This is the
**imperative** half: a script devc runs at container-create time, after its own
baseline setup. Together they let a zero-config project extend its container
without owning a `.devcontainer/` at all.

Drop an executable script at either location — first hit wins, same order and
same both-are-first-class rule as the overlay itself:

```
.devc/devc-post-create.sh
.devcontainer/devc-post-create.sh
```

`post-create.sh` runs it as its **last** step, so devc's baseline (the `.claude`
volume + seed links, `nvm install`, git identity) is already in place. It works
identically in both modes: zero-config finds it through `$PROJECT_PATH`, with no
project `.devcontainer/` involved.

```bash
#!/bin/bash
set -e
# cwd is the project root, so relative paths work
cd tools/mycli && cargo install --path .
```

The contract:

- **cwd is the project root** (`$PROJECT_PATH`), so relative paths resolve
  against the repo. Each `post-create.sh` step is a separate process, so the hook
  establishes this itself rather than inheriting it.
- **It must be executable.** A hook that exists but is not executable — or is a
  dangling symlink — **fails the create** naming the path, rather than being
  skipped. A hook that never runs is the failure mode this is designed to
  prevent, so it is never silent.
- **No fall-through.** Existence selects the hook; if `.devc/`'s copy exists but
  cannot run, devc does not quietly fall back to `.devcontainer/`'s.
- **A nonzero exit fails the create.** The hook is invoked directly under
  `set -e`.
- **devc never writes or reads it.** `post-create.sh` is devc's and gets
  regenerated; the hook is yours. Like the overlay, it is equally at home
  committed (the repo depends on devc) or gitignored (one developer's local
  setup).
- Changes take effect on the next container **create**, so run `devc build` after
  editing one.

## Default overrides: `~/.config/devc/templates/`

A **sparse** per-file overlay on the bundled default. Any file you put here
replaces the same-named bundled one — everywhere the bundle is used:

```text
~/.config/devc/templates/Dockerfile           your build, for zero-config projects and
~/.config/devc/templates/devcontainer.json    what `devc init` scaffolds
~/.config/devc/templates/scripts/node-setup.sh
```

- **Never created by `devc`.** It stays absent until you make it, and holds only
  the files you want to change.
- **Re-applied every run**, so a `devc` upgrade keeps shipping its new defaults
  for every file you have _not_ overridden. Delete a file from here and the
  bundled version is back on the next run.
- **Reaches project mode too.** `devc init` scaffolds from the same layered set,
  so a `Dockerfile` customization reaches a project's own `.devcontainer/` and
  not just the zero-config path. (`devc config` scaffolds nothing — it only
  writes the overlay — so nothing it does can disturb a template.)
- A template `devcontainer.json` still gets the two zero-config path rewrites
  (`initializeCommand` → the cache dir, `postCreateCommand` → the image-baked
  script), so keeping the standard in-project references in it is fine.
- The two lifecycle entry scripts and `scripts/*.sh` get their exec bit restored
  on scaffold; a _new_ top-level `*.sh` a template adds does not, which is
  cosmetic since both hooks are invoked as `bash "<path>"`.
- **`devc.json` does not belong here** — it is skipped, with a warning on
  stderr. The two are adjacent paths meaning opposite things: `templates/` holds
  files _copied into_ a project's `.devcontainer/`, which run without `devc`
  installed, while the [overlay](#optional-overlay-devcjson) is a devc-only
  layer applied as flags at launch. A `devc.json` left here would be copied to
  `<project>/.devcontainer/devc.json` and read back as that _project's own_
  overlay — the highest-precedence slot — putting your machine's bind mounts
  into every repo you scaffold. For mounts that apply to every project, the file
  goes one level up, at `~/.config/devc/devc.jsonc`.

## Claude config: `~/.config/devc/.claude`

Anything you want the in-container agent to see goes in
`~/.config/devc/.claude` — **you put it there, and nothing else gets in.** The
directory is bind-mounted read-only at `/usr/local/share/devc/claude-seed`, and
on every container create `scripts/agents-setup.sh` (run by `post-create.sh`)
symlinks each entry into the container's `~/.claude`:

```text
~/.config/devc/.claude/CLAUDE.md      →  /home/vscode/.claude/CLAUDE.md
~/.config/devc/.claude/settings.json  →  /home/vscode/.claude/settings.json
~/.config/devc/.claude/statusline.sh  →  /home/vscode/.claude/statusline.sh
```

- **Top-level files only.** Directories are ignored — the `devc:skills` fence
  owns `~/.claude/skills/`, and per-skill mounts are configured through
  `devc config` instead.
- **Read-only, and live.** Edits on the host show up immediately; no rebuild, no
  recreate. File modes carry over, so `statusline.sh` keeps its exec bit.
- **Deletions are honored.** Remove a file here and its link disappears on the
  next container create.
- **Missing is fine.** `devc` creates the directory if absent, and says so the
  once. An empty one is valid — files that aren't there simply aren't linked.
- **Nothing is copied in for you**, and in particular your host `~/.claude` is
  never read. Whether your personal `CLAUDE.md`, `settings.json` or
  `statusline.sh` should reach every container is a decision only you can make,
  so making it means copying (or symlinking) the file in yourself:

  ```sh
  cp ~/.claude/CLAUDE.md ~/.config/devc/.claude/
  ```

  Copy, and the container gets a snapshot you can diverge from the host's. Symlink
  (`ln -s`), and the two stay identical — the seed mount is live, so either way
  edits land without a rebuild.
- The container's own `~/.claude` stays a per-workspace volume, so `projects/`,
  `todos/`, and credentials persist per project and are never touched by this.

Migrating from an older `devc`: nothing is migrated automatically. Copy in
whichever of `~/.claude/CLAUDE.md`, `~/.claude/settings.devc.json` (→
`settings.json`) and `~/.claude/statusline.sh` you actually want — the `.devc`
suffix existed only to avoid colliding with the real `~/.claude/settings.json`,
and a dedicated directory removes the collision. Projects whose
`.devcontainer/devcontainer.json` was written by an earlier `devc` also still
carry three per-file binds — `devc` writes infra mounts once at creation and
never re-asserts them, so replace them by hand with:

```jsonc
"initializeCommand": "mkdir -p \"$HOME/.config/devc/.claude\"",
// …and in "mounts", replacing the three ~/.claude/* bind lines:
"type=bind,source=${localEnv:HOME}/.config/devc/.claude,target=/usr/local/share/devc/claude-seed,consistency=cached,readonly",
```

The `initializeCommand` is what creates the mount source on a machine without
`devc` installed (a bind mount with a missing source is a hard error, not an
auto-created directory). It has to be top-level — it is the only host-side
lifecycle hook — so a project that needs its own `initializeCommand` should
either keep the `mkdir -p` in it or drop the `claude-seed` mount alongside it.

## Shell setup: `shell/` folders

Every interactive container shell sources two optional layers of `*.sh`, after
devc's own additions (prompt, terminal title, `nvm` auto-use) and before the
`devc attach` first-prompt clear:

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

- **User first, then project**, so a project's committed settings win on
  conflict — the same `system → global → local` order git uses. A project that
  _assigns_ rather than appends to a shared variable (`PS1`, `PATH`) will
  therefore override your personal one.
- **Order within a layer** is glob (name) order. Prefix with `10-`, `20-`, … to
  control it.
- **Optional.** Missing or empty directories do nothing. Neither is created or
  written by `devc config`, and neither is ever overwritten, so both are yours —
  commit the project one or `.gitignore` it. Only `*.sh` is sourced; a
  `README.md` alongside is ignored.
- **Live.** Both layers are _sourced_ from `~/.bashrc`, not appended into it —
  edits apply to the next new shell, with no rebuild and no recreate. Deleting a
  file stops it being read. The user layer is a read-only bind mount, so host
  edits are picked up the same way.
- **Both modes.** The project layer works in the zero-config path too: a project
  can have only `.devcontainer/shell/` and no `devcontainer.json` and still get
  it, since it is found through the workspace mount at `$PROJECT_PATH`.
- **Interactive shells only.** The project layer additionally needs
  `PROJECT_PATH` — the workspace root devc sets as `remoteEnv` and re-passes on
  `exec`/`attach`; a raw `docker exec … bash` without it deliberately sources
  nothing. The user layer is at a fixed container path and does not depend on
  it.
- Avoid setting `PROMPT_COMMAND` outright (append to it instead) — replacing it
  drops the first-prompt clear that `devc attach` installs after these layers
  run.

`~/.config/devc/shell` is created by `initialize-command.sh`, because a bind
mount errors on a missing source rather than creating it. Projects whose
`.devcontainer/devcontainer.json` was written by an earlier `devc` predate the
mount — `devc` writes infra mounts once at creation and never re-asserts them —
so add it by hand to pick up the user layer:

```jsonc
"type=bind,source=${localEnv:HOME}/.config/devc/shell,target=/usr/local/share/devc/shell,consistency=cached,readonly",
```

## Git setup

`~/.gitconfig` is container-local and wiped on every rebuild, while the working
tree and `.git` are host bind mounts. `scripts/git-setup.sh` (run by
`post-create.sh`) re-applies the user-scope settings git needs each create:

- **Your identity.** `initialize-command.sh` extracts `user.name` / `user.email`
  from the host into `~/.config/devc/gitconfig-identity`, which binds in
  read-only and is picked up via `include.path`. Only those two keys cross the
  boundary — binding the whole host `~/.gitconfig` would drag in host-absolute
  paths, credential helpers and signing config that do not work in here. A host
  with no identity configured is a warning at create time, not a failure.
- **LFS filters,** because the `git-lfs` feature installs them as root, where
  the `remoteUser` never sees them; without them every LFS asset shows as
  modified. Installed with `--skip-smudge`, so **LFS objects are not
  materialized on checkout** — run `git lfs pull`, or
  `git lfs checkout --
  <path>`, when you need the real bytes.
- **`worktree.useRelativePaths`,** so a `git worktree add` run in here does not
  write container-absolute paths into a `.git` the host also reads.
- **`safe.directory=*`,** since the workspace mount can present a foreign owner
  and git otherwise refuses to operate on it.

Projects whose `.devcontainer/devcontainer.json` was written by an earlier
`devc` predate the identity mount — `devc` writes infra mounts once at creation
and never re-asserts them — so add it by hand to get your identity in the
container:

```jsonc
"type=bind,source=${localEnv:HOME}/.config/devc/gitconfig-identity,target=/usr/local/share/devc/gitconfig-identity,consistency=cached,readonly",
```

## devc-bridge: the opt-in Feature

[devc-bridge](../devc-bridge/README.md) lets a container run an allowlisted
command on the host. Its container half is a **devcontainer Feature**, and it is
**opt-in** — devc's bundled config does not reference it, and a devc container
comes up fine on a host that has never heard of the bridge. That is deliberate:
a Feature ref in the bundled default would make every `devc up` anywhere depend
on that ref resolving.

Opt in for **every project** (user level, `~/.config/devc/devc.json`) or for
**one project** (`.devc/devc.json`, or `.devcontainer/devc.jsonc`):

```jsonc
{
  "additionalFeatures": {
    "ghcr.io/bmingles/devc-tools/devc-bridge:0": {}
  }
}
```

Project level wins per feature id. A project that does not use devc at all opts
in with the same reference in its own `devcontainer.json` `features` block.

The Feature installs the client: it downloads the arch-matched Linux binary from
the matching release, verifies it, and symlinks `/usr/local/bin/devc-bridge` at
it. Nothing is mounted for the client, and nothing is compiled in the container.
See [the Feature's README](../features/devc-bridge/README.md) for what it does
and why.

### The token mount, and the one place devc does something for you

The bridge also needs the host's shared-secret token, which does have to cross as
a bind mount — and it must be **read-only**, or a container can pin the host's
token for the next restart. That is the whole reason this is not simply another
`additionalFeatures` line:

- A **Feature** cannot declare it. The Feature schema's `Mount` has no `readonly`
  field, and the CLI re-serializes object mounts without one.
- A **devc.json overlay** cannot declare it either. Overlay mounts become
  `devcontainer up --mount` arguments, whose validation rejects `readonly` — see
  [Mount specs](#mount-specs-what-an-overlay-mount-can-say) above.

A `devcontainer.json` `mounts` array is the only place a read-only bind can be
expressed at all. So the two modes differ, and this is the one asymmetry between
a devc project and a non-devc one:

| Mode                                              | Who declares the token mount                                                                            |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| **Zero-config** (no `.devcontainer/` of your own) | **devc**, into the config it materializes into its cache — automatically, when you opt into the Feature |
| **Project mode** (you have a `devcontainer.json`) | **You**, in your own config — exactly like a non-devc project                                           |

In project mode, add it yourself:

```jsonc
"mounts": [
  "type=bind,source=${localEnv:HOME}/.config/devc-bridge/run,target=/run/devc-bridge,readonly"
]
```

devc does not write into a project's `.devcontainer/` — not here, not anywhere.
The zero-config injection touches only devc's own cached artifact, happens only
when you opted in, and has no host-side side effects; that is what keeps it from
being the kind of devc-only shortcut the Feature exists to avoid.

The injected mount arrives as a `devc:bridge-mount` fence in the cached config,
spliced into whatever `mounts` array is there (created if there is none). Nothing
in the bundled `devcontainer.json` marks the spot, on purpose: that file is also
what `devc init` copies into your project, and a project that never opts into the
bridge should carry no trace of it. If you keep your own
`~/.config/devc/templates/devcontainer.json`, it needs no marker either — but a
token mount you wrote there yourself is left alone, and no fence is added.

**Install the host bridge first.** A Feature cannot create its own mount sources
— its lifecycle hooks all run inside the container, and `--mount type=bind`
errors on a missing source — so opting in on a host with no
`~/.config/devc-bridge/` fails the create with Docker's `bind source path does
not exist`. Running `devc-bridge start` once seeds that directory. devc does
**not** pre-create it, in either mode: a host that never uses the bridge should
not carry directories for it. That prerequisite is identical for devc and
non-devc projects; only who writes the mount line differs.

**If you already wired the bridge yourself** — a `run` mount in `devc.json`, a
client mount copied into `devcontainer.json`, or a `devc-post-create.sh` that
builds the client — remove it before opting in. Mounts are not deduped across
those layers, and Docker fails the create with `Duplicate mount point`. (A token
mount already present in a project-mode `devcontainer.json` is the one safe case:
zero-config injection skips a config that declares the target already.)

On **Docker Compose** devcontainers the CLI drops `readonly` when it rewrites
mounts into the generated compose file, so the token mount ends up writable
whichever way it is declared. The bridge is hardened against that — it
regenerates the token on every start and never writes through a symlink — so this
is a caveat, not an exclusion.

## Development

Requires Deno 2.9+. This is the from-a-clone path; users install the prebuilt
binary instead (see [Install](#install)).

```sh
deno task run    -- <command> [args]   # run from source
deno task test                         # unit tests
deno task check                        # type-check
deno task build                        # compile the `devc` binary (embeds ../devc-core/default)

# What the release workflow calls: same flags, cross-compiled, into the repo-root dist/.
DEVC_TARGET=aarch64-apple-darwin deno task build:release

# The lifecycle logic devc compiles from — startContainer, the devc.json overlay, the config
# wizard's pure helpers — lives in the sibling `devc-core/` package (see its own README and
# .plans/archived/devc-core-npm-library.md), checked and tested the same way:
cd ../devc-core && deno task check && deno task test

# Parts of the baseline are bash (in devc-core/default/scripts/, or in the host-side entry
# script), so they are covered by shell harnesses rather than `deno task test`. Each extracts a
# fenced block from the real script and runs it against temp dirs, so the tests cannot drift
# from the implementation:
bash tests/seed_link_test.sh ../devc-core/default/scripts/agents-setup.sh      # devc:seed-link
bash tests/shell_dirs_test.sh ../devc-core/default/scripts/bashrc-additions.sh # devc:shell-dirs
bash tests/project_hook_test.sh ../devc-core/default/scripts/project-hook.sh   # devc:project-hook

# shell_dirs_test.sh takes the script path so it can run against *both* copies of the
# devc:shell-dirs block — devc's above, and the shell-dirs Feature's. It must pass unmodified
# against each; if it needs changes for one of them, the two have drifted:
bash tests/shell_dirs_test.sh ../features/shell-dirs/install.sh             # devc:shell-dirs

# seed_link_test.sh takes the script path too, for the same reason — devc's copy above, and the
# claude-config Feature's post-create.sh below. Must pass unmodified against both:
bash tests/seed_link_test.sh ../features/claude-config/post-create.sh         # devc:seed-link

# The bridge's PATH symlink is no longer devc's — it lives in the devc-bridge Feature:
bash ../features/devc-bridge/test/install_link_test.sh   # devc:bridge-client-link

# The release installer has its own harness at the repo root (offline, no network):
bash ../tests/install_test.sh ../install.sh
```

`deno task test` spawns the runtime: `tests/devcontainer_cli_test.ts` runs the
[embedded devcontainer CLI](#the-embedded-devcontainer-cli) for real — a
`--version` and an `up` against a Docker path that cannot exist — because
nothing else would notice if the pin, the argv shim or the embedding broke. It
needs no Docker, and on a cold cache it fetches the pinned npm package like any
other dependency.

### `devc config`

`devc config [PATH]` is a picker-driven flow for the project's
[`devc.json` overlay](#optional-overlay-devcjson). You _select_ folders — no
typing paths:

- **Source folders** and **skills folders** are each chosen with a multi-select,
  type-to-filter picker: `↑/↓` move, `→` open a folder, `←` (or backspace on an
  empty filter) go up, `space` ticks/unticks (selection persists across
  folders), `⏎` confirms, `esc` cancels. Type any characters to filter the
  current folder.
- Each picker screen (see `.plans/design/wizard/` for the reference frames) is a
  banner naming the screen — `WORKSPACE CONFIG` or `GLOBAL CONFIG` — over two
  labelled lists: what is picked so far (`Source Folders`, `Skills`,
  `Source Folder Roots`, `Skills Folder Roots`) and the browser you add from
  (`Add Source Folders`, `Add Skills`, `Add Roots`), with the key legend under a
  rule at the foot.
- The **project folder is pinned** in the source picker (`◎` — a `◉` you cannot
  untick — labelled "this project (always mounted)"): the dev container binds it
  on its own, so it heads the picked list and picking nothing still mounts it.
  It also appears in the review, above the `devc:source` rows.
- Markers: `◯` not picked · `◉` picked · `◎` mounted regardless (the project
  folder, or a mount another pick drags in — such as a picked worktree's primary
  repo `.git`).
- Your configured roots are **shortcuts, not boundaries**: the picker opens on
  the list of roots, but `←` walks above a root like any other folder, and at
  the filesystem root it wraps back to the shortcut list — so you can mount a
  folder from anywhere on the machine. The roots themselves aren't selectable;
  tick one from its parent folder.
- A **review** summary then a single `Apply?` confirm writes the two managed
  mount blocks (`devc:source`, `devc:skills`); everything else in the file —
  hand-written mounts, `additionalFeatures`, `remoteEnv`, comments — is left
  untouched.
- Afterwards, `devc config` compares what it wrote to what was already on disk
  and only then offers a rebuild, since mounts take effect at container-create
  time:
  - **Changed**, container exists → `Rebuild now? [Y/n]`, which runs the same
    recreate as `devc build`.
  - **Changed**, no container yet → `Build it now? [Y/n]`.
  - **Unchanged** → `No config changes — no rebuild needed.` and no prompt.
    Ticking a folder off and back on ends at the same bytes, so it counts as no
    change and the file is not even rewritten. Declining a rebuild prints a
    reminder to run `devc build` later.

**Roots** (where the pickers are scoped) live in `~/.config/devc/config.json`,
stored folded to `~/…`. On first run — or any time roots are missing —
`devc config` collects them first with a free-navigation picker. Run
**`devc config --global`** to reconfigure them at any time.

#### Which file it writes

Extra bind mounts are **machine-specific**: another checkout of the same repo
will not have your sibling repos at the same host paths, so the mount cannot be
committed and be correct for anyone else. That is why they go in the overlay and
not in `devcontainer.json`.

`devc config` **never writes `.devcontainer/`** — not the config, not the
scaffold. Creating `.devcontainer/` is `devc init`'s job, so recording one mount
on a zero-config project does not saddle it with a `Dockerfile` and lifecycle
scripts to maintain. The target is picked like this:

```text
an existing overlay, in the usual first-hit order   → written in place
  .devc/devc.jsonc · .devc/devc.json
  .devcontainer/devc.jsonc · .devcontainer/devc.json
otherwise, the project has a .devcontainer/         → .devcontainer/devc.jsonc
otherwise                                           → .devc/devc.jsonc
```

An existing overlay always wins, and a second one is never created beside it —
only the first hit is ever read, so the loser would silently do nothing.

Upgrading from a `devc` that wrote fences into `devcontainer.json`: **delete the
`devc:source` and `devc:skills` blocks there by hand**, then run `devc config`.
There is no automatic migration. Left in place, those mounts are applied
_as well as_ the overlay's — same target fails container creation with Docker's
`Duplicate mount point`, a different target just mounts the folder twice.
