# devc `~/.claude` seed directory

Replace the three per-file `~/.claude/*` host bind mounts in the bundled default
with **one read-only directory bind mount** of a dedicated host config dir, plus
a symlink step in `post-create.sh` that links every top-level _file_ from it
into the `~/.claude` volume.

## Why

Today the bundled default carries three per-file binds:

```jsonc
"type=bind,source=${localEnv:HOME}/.claude/CLAUDE.md,target=/home/vscode/.claude/CLAUDE.md,consistency=cached,readonly",
"type=bind,source=${localEnv:HOME}/.claude/settings.devc.json,target=/home/vscode/.claude/settings.json,consistency=cached,readonly",
"type=bind,source=${localEnv:HOME}/.claude/statusline.sh,target=/home/vscode/.claude/statusline.sh,consistency=cached,readonly",
```

Each assumes the host file exists. `mounts` entries take "the same values as the
Docker CLI `--mount` flag", and `--mount type=bind` **errors** on a missing
source (`bind source path does
not exist`) — unlike `-v`, which auto-creates a
directory. So a user missing any one of the three cannot create the container at
all.

Mounting a **directory** removes the brittleness: the host dir is created before
`devcontainer up` runs, and an empty dir is a valid mount source. Symlinking
(rather than copying) preserves exactly today's semantics — live host edits,
read-only in-container, host file modes intact — and makes deletion work, which
a copy into the persistent volume cannot do.

### Rejected: `COPY` in the Dockerfile

Two blockers, both fatal:

1. **Build context.** `COPY` reads only from the build context —
   `~/.cache/devc/default/` (zero-config, see `materializeDefaultConfig`) or
   `<project>/.devcontainer/` (project mode). The host config dir is outside
   both, so `devc` would have to stage a copy into the context first; in project
   mode that means writing personal config into the user's repo.
2. **The volume shadows the image.** `/home/vscode/.claude` is the named volume
   `claude-code-config-${localWorkspaceFolderBasename}`. Docker seeds an empty
   volume from the image's directory contents _only at first creation_. After
   that the volume wins, so a `COPY` never reaches an existing container — edit
   `CLAUDE.md`, rebuild, nothing changes until the volume is deleted.

Baking user config into image layers would also bust the build cache on every
edit.

### Rejected: copy instead of symlink

A copy into the volume is additive and the volume persists, so a file removed
from the host config dir would live on in the container forever. Recovering
deletion would need a manifest of what was copied last time. Symlinks make
deletion fall out for free (prune links pointing into the seed mount, then
relink what is present) and additionally give live host edits with no container
recreate.

### Decision: top-level files only, directories ignored

Directory entries in the seed dir are **skipped**, not descended into. This is
what keeps the step trivial: the `devc:skills` fence (`SKILLS_CONTAINER_ROOT` in
`mounts.ts`) mounts per-skill binds at `/home/vscode/.claude/skills/<name>`, and
Docker materializes the intermediate `~/.claude/skills/` directory at container
create — _before_ `postCreate` runs. Any attempt to link or copy a seed
`skills/` over it either silently produces `~/.claude/skills/skills` (plain
`ln -s` into an existing directory), fails with `EBUSY` (`ln -sfn` replacing a
directory with live mountpoints under it), or fails with `EROFS` (`cp` into a
read-only bind). Ignoring directories sidesteps the whole class.

Cost: directory-based Claude config (`agents/`, `commands/`, `hooks/`,
`output-styles/`) does not propagate. `skills/` is already covered by its own
fence; if another directory kind is wanted later, the natural move is a second
managed fence, not recursion here.

## Contract

**Host config dir:** `~/.config/devc/.claude` — i.e. `${CONFIG_DIR}/.claude`,
using the existing `CONFIG_DIR` constant in `default_config.ts`. Created by
`devc` if absent.

**Container mount target:** `/usr/local/share/devc/claude-seed`

**Mount spec** — the single line replacing the three above in
`devc/default/devcontainer.json`, positioned immediately after the
`claude-code-config-*` volume mount:

```jsonc
"type=bind,source=${localEnv:HOME}/.config/devc/.claude,target=/usr/local/share/devc/claude-seed,consistency=cached,readonly",
```

**Host-side file names.** Plain `settings.json`, not `settings.devc.json`. The
`.devc` suffix existed only to avoid colliding with the real
`~/.claude/settings.json`; a dedicated directory removes the collision.

**`initializeCommand`** — a new top-level key in
`devc/default/devcontainer.json`, so a committed project config works for a
developer who does not have `devc` installed:

```jsonc
"initializeCommand": "mkdir -p \"$HOME/.config/devc/.claude\"",
```

This is what makes the mount safe to commit. Since `--mount type=bind`
hard-errors on a missing source, without this hook a `devc config` project
cloned by a `devc`-less developer fails at container create. `mkdir -p` is
idempotent, which matters because the hook also runs on subsequent starts, not
just creation.

Three constraints behind this placement:

- **It must be top-level; a Feature cannot carry it.** The Features spec permits
  only `onCreateCommand`, `updateContentCommand`, `postCreateCommand`,
  `postStartCommand`, and `postAttachCommand` — `initializeCommand` is not among
  them. This is the one piece of the baseline that cannot compose via the
  Feature, so it inherits the single-valued clobbering problem: a project that
  later needs its own `initializeCommand` must either merge the `mkdir` into it
  or drop the seed mount — the hook and the mount are a pair, and removing both
  is an equally valid resolution (that project simply opts out of host
  `~/.claude` config). Document it in `devc/README.md` as that either/or. The
  failure mode is loud (a mount error at create), not silent, so a user who
  overrides and forgets finds out immediately.
- **It is the only host-side hook.** The other five run inside the container,
  after mounts are established — structurally too late to create a mount source.
- **Host shell, so POSIX only.** `mkdir -p "$HOME/..."` is correct on macOS and
  Linux and fails on a Windows host (string form runs through `cmd`/PowerShell).
  Windows is already outside the supported path — the existing
  `${localEnv:HOME}` mount specs assume `HOME` is set, which Windows does not
  guarantee — so no workaround is in scope here.

`materializeDefaultConfig` needs no change for this: its zero-config transform
only deletes the Feature reference and sets `postCreateCommand`, so
`initializeCommand` passes through to the cached copy untouched. Add a test
pinning that.

`ensureClaudeSeedDir` (below) stays regardless — the hook guarantees existence,
while the function owns the not-a-directory guard and the readable error. The two
are complementary, not redundant.

### `post-create.sh` behavior

Runs on every container create, **after** the existing
`sudo chown vscode:vscode /home/vscode/.claude` (write permission is required)
and before the `~/.claude.json` symlink block.

1. **Prune.** For every symlink at depth 1 in `/home/vscode/.claude`, if
   `readlink` reports a target under `/usr/local/share/devc/claude-seed/`,
   unlink it. Only symlinks are ever removed — volume state (`projects/`,
   `todos/`, `.credentials.json`) and the skills mountpoints are untouched.
   `-type l` and `readlink` both work on a dangling link, so a link whose host
   file was deleted or renamed is caught here.
2. **Link.** For every top-level entry in the seed dir that is a **regular
   file**, create `/home/vscode/.claude/<name>` as a symlink to it. Skip
   directories, and skip and log:
   - an entry that is a symlink dangling _inside the container_ (a host symlink
     whose absolute target does not exist in the container namespace);
   - a destination that already exists and is neither a symlink nor a regular
     file;
   - a failed `ln` (never fail the create — `post-create.sh` runs under
     `set -e`).

   A destination that is an existing **plain file** (e.g. a `settings.json`
   Claude Code wrote into the volume) is **replaced** by the symlink — the seed
   wins, matching what the bind mount does today. Log it, since it discards
   in-volume state.

Reference implementation (bash, matching the file's existing style):

```bash
# ~/.claude seed: symlink every top-level *file* from the read-only seed bind mount
# into the .claude volume. Directories are ignored by design — the devc:skills fence
# owns ~/.claude/skills/, whose mountpoints already exist by the time this runs.
# Runs on every create, so host edits, additions, and deletions all take effect
# without deleting the volume.
SEED=/usr/local/share/devc/claude-seed
CLAUDE_DIR=/home/vscode/.claude

# Prune links a previous create made whose seed file is now gone or renamed.
if [ -d "$CLAUDE_DIR" ]; then
  while IFS= read -r -d '' link; do
    case "$(readlink "$link")" in
      "$SEED"/*) rm -f "$link" ;;
    esac
  done < <(find "$CLAUDE_DIR" -mindepth 1 -maxdepth 1 -type l -print0)
fi

if [ -d "$SEED" ]; then
  while IFS= read -r -d '' src; do
    name="$(basename "$src")"
    dest="$CLAUDE_DIR/$name"
    if [ -L "$src" ] && [ ! -e "$src" ]; then
      echo "devc: skipping $name — host symlink dangles in the container; use a real file"
      continue
    fi
    [ -f "$src" ] || continue   # -f follows symlinks; skips directories
    if [ -e "$dest" ] && [ ! -L "$dest" ] && [ ! -f "$dest" ]; then
      echo "devc: skipping $name — $dest exists and is not a regular file"
      continue
    fi
    if [ -f "$dest" ] && [ ! -L "$dest" ]; then
      echo "devc: replacing volume-local $name with the host seed copy"
    fi
    ln -sfn "$src" "$dest" || echo "devc: could not link $dest (bind-mounted?)"
  done < <(find "$SEED" -mindepth 1 -maxdepth 1 -print0)
fi
```

Gotchas baked into the above:

- `find -print0` + `read -r -d ''` rather than a glob: a glob misses dotfiles
  and yields the literal pattern when the dir is empty.
- `case "$(readlink "$link")" in "$SEED"/*)` — the quoted segment is literal,
  `*` globs. Do not quote the whole pattern.
- Process substitution (`< <(...)`) is bash-only; the shebang is already
  `#!/bin/bash`.
- `-type l` matches dangling links (it uses `lstat`), which is what makes prune
  work.

### `ensureClaudeSeedDir` in `default_config.ts`

Called from `startContainer` in `container.ts`, **before** the `devcontainer`
command is spawned and **unconditionally** (both zero-config and project mode
use the same mount).

Signature — parameters exist purely as test seams, mirroring
`materializeDefaultConfig`:

```ts
export async function ensureClaudeSeedDir(
  seedDir?: string, // defaults to `${CONFIG_DIR}/.claude`
): Promise<{ created: boolean }>;
```

Behavior:

1. `Deno.mkdir(seedDir, { recursive: true })`, catching `AlreadyExists`.
   **Gotcha:** recursive `mkdir` is not `mkdir -p` — it throws `AlreadyExists`
   when the path is a regular file or a _dangling symlink_. So after the mkdir,
   `Deno.stat` the path and throw an error naming it if it is not a directory;
   otherwise the failure surfaces later as an opaque Docker mount error.
2. **The directory is created empty and stays that way.** Nothing is ever
   copied out of the host's real `~/.claude` — not on first creation, not ever.
   Republishing a machine's personal `CLAUDE.md`/`settings.json`/`statusline.sh`
   into every container is a decision only the user can make, and they make it
   by putting the file in the seed dir themselves (`cp` for a snapshot they can
   diverge, `ln -s` to track the host copy). The `settings.devc.json` →
   `settings.json` rename is documentation for someone doing that by hand, not
   behavior.

   Return `created` so the caller can report the one-time creation. Whether
   `created` was true must **not** gate any copying — there is none.
3. `startContainer` prints one line when `created` is true, naming the seed dir
   (via `displayPath` from `config.ts`) and what belongs in it, so an empty
   directory the user has never heard of is still discoverable.

## Out of scope

Projects with an existing `.devcontainer/devcontainer.json` from an earlier
`devc` keep the three old per-file binds — `applySelection` writes infra mounts
once at creation and never re-asserts them (see the module comment in
`wizard_apply.ts`). Migrating those is a manual edit, documented in
`devc/README.md`; `devc` does not detect or rewrite them.

## Checklist

- [x] `devc/default/devcontainer.json`: replace the three `~/.claude/*` per-file
      bind mounts with the single seed directory mount (exact spec string
      above), keeping the surrounding comment accurate.
- [x] `devc/default/devcontainer.json`: add the top-level `initializeCommand`
      (exact string above) so the mount source exists without `devc`.
- [x] `devc/default/features/devc/post-create.sh`: add the prune + link block
      after the `chown /home/vscode/.claude` line and before the
      `~/.claude.json` symlink block.
- [x] `devc/default_config.ts`: export `ensureClaudeSeedDir` (and a
      `CLAUDE_SEED_HOST_DIR` constant for `${CONFIG_DIR}/.claude`), including
      the not-a-directory guard. No copying from the host `~/.claude`.
- [x] `devc/container.ts`: call `ensureClaudeSeedDir` in `startContainer` before
      spawning `devcontainer`, and print one line when `created` is true saying
      what belongs in the (empty) directory.
- [x] `devc/tests/default_config_test.ts`: tests for `ensureClaudeSeedDir` —
      creates the dir; idempotent on a second call (`created: false`); the
      created dir is **empty** even when the host `~/.claude` holds
      `CLAUDE.md`/`settings.json`/`settings.devc.json`/`statusline.sh`; throws a
      path-naming error when the target is a regular file or dangling symlink.
- [x] `devc/tests/wizard_apply_test.ts`: update the infra-mount assertion at
      line 63 (`/home/vscode/.claude/CLAUDE.md`) to assert the seed mount target
      instead.
- [x] `devc/tests/default_config_test.ts`: assert `materializeDefaultConfig`
      preserves `initializeCommand` in the cached zero-config copy.
- [x] `devc/README.md`: document `~/.config/devc/.claude` — top-level files
      only, directories ignored, read-only in-container, deletion honored on
      next create — plus the manual replacement snippet for projects configured
      by an earlier `devc`, and the note that a project overriding the top-level
      `initializeCommand` should either keep the `mkdir -p` or drop the seed
      mount alongside it.
- [x] `.plans/design/devc-design.md`: update the "Bundled default and the `devc`
      Feature" section (line ~46) to list the seed link step among the Feature's
      runtime setup, and note that `~/.claude` host config arrives via the seed
      dir rather than per-file binds.
- [x] `.plans/PLAN.md`: move this plan's entry to `## Completed` and set its
      `## Development Phases` row to `complete`, then move this file to
      `.plans/archived/`.

## Validation

Run from `/workspaces/devc-tools/devc` unless noted.

> The seven unchecked items below all need a Docker host. They cannot run from
> inside the dev container (neither `docker` nor `devcontainer` is on `PATH`
> there) — run them from the host after building the binary. Everything not
> requiring a host is checked and passing.

- [x] `deno task test` (or `deno test -A`) passes.
- [x] `deno check main.ts` passes; `deno fmt --check` and `deno lint` are clean.
- [x] `bash -n default/features/devc/post-create.sh` parses.
- [x] `grep -c 'localEnv:HOME}/.claude/' default/devcontainer.json` reports `0`
      — no per-file `~/.claude` binds remain.
- [x] `grep -c 'devc/.claude,target=/usr/local/share/devc/claude-seed' default/devcontainer.json`
      reports `1`.
- [x] Seed-link logic, exercised directly against fake dirs (no container
      needed) — a throwaway script that sources the block's logic with
      `SEED`/`CLAUDE_DIR` pointed at temp dirs, asserting: a top-level file is
      linked; a directory is not; a removed seed file's link is pruned on the
      next run; a non-seed symlink in `CLAUDE_DIR` survives the prune; a
      pre-existing plain file at the destination is replaced by the link.
- [x] End-to-end, zero-config: with `~/.config/devc/.claude` absent and
      `~/.claude/{CLAUDE.md,settings.devc.json,statusline.sh}` present, `devc up`
      in a folder with no `.devcontainer/` succeeds, prints the created-it line,
      and leaves the seed dir **empty** — nothing was taken from `~/.claude`.
      Then `cp ~/.claude/CLAUDE.md ~/.config/devc/.claude/`, `devc build`, and
      `devc exec . -- ls -l /home/vscode/.claude` shows `CLAUDE.md` as a symlink
      into `/usr/local/share/devc/claude-seed`.
- [x] End-to-end, missing files: with `~/.config/devc/.claude` empty, `devc up`
      succeeds (this is the case that fails today).
- [x] **No-`devc` path:** delete `~/.config/devc/.claude` entirely, then bring a
      `devc config`-generated project up with the upstream CLI only —
      `devcontainer up --workspace-folder <project>` — and confirm it succeeds,
      that `initializeCommand` recreated the directory, and that `~/.claude`
      contains no seed symlinks (empty seed dir, nothing to link). This is the
      scenario the hook exists for; run it without `devc` on `PATH` to be sure
      nothing else is creating the directory.
- [x] Deletion is honored: remove `statusline.sh` from the seed dir,
      `devc up --rebuild` (or `devc down` + `devc up`), and confirm
      `/home/vscode/.claude/statusline.sh` is gone.
- [x] Live edit needs no recreate: append a line to the host `CLAUDE.md` and
      confirm `devc exec . -- cat /home/vscode/.claude/CLAUDE.md` shows it
      immediately.
- [x] Skills coexistence: in a project configured with at least one skills
      mount, confirm `devc exec . -- ls -l /home/vscode/.claude/skills` still
      lists the bind-mounted skills and that `~/.claude/skills` is not a
      symlink.
- [x] `devc exec . -- test -x /home/vscode/.claude/statusline.sh` succeeds (host
      mode preserved through the symlink).

## Relevant Files

| File                                        | Change                                                              |
| ------------------------------------------- | ------------------------------------------------------------------- |
| `devc/default/devcontainer.json`            | Three per-file `~/.claude` binds → one seed directory bind.         |
| `devc/default/features/devc/post-create.sh` | New prune + link block.                                             |
| `devc/default_config.ts`                    | `CLAUDE_SEED_HOST_DIR`, `ensureClaudeSeedDir` (no host copying).    |
| `devc/container.ts`                         | Call `ensureClaudeSeedDir` in `startContainer`; print created line. |
| `devc/tests/default_config_test.ts`         | New `ensureClaudeSeedDir` tests.                                    |
| `devc/tests/wizard_apply_test.ts`           | Update infra-mount assertion (line 63).                             |
| `devc/README.md`                            | Document the config dir; migration is manual, by design.            |
| `.plans/design/devc-design.md`              | Update the bundled-default / Feature runtime-setup section.         |
| `.plans/PLAN.md`                            | Status + phase row.                                                 |

No changes needed in the root `README.md` (no `~/.claude` references),
`mounts.ts`, or the wizard TUI — the seed mount is infra, not a managed fence,
so the wizard never touches it.
