# agents (devcontainer Feature)

Installs coding-agent CLIs at build time — the **Claude Code CLI**, and optionally
the **GitHub Copilot CLI** and the **pi coding agent CLI** — and at create time
links a host config seed into `~/.claude` and folds `~/.claude.json` into
`~/.claude`, so **one** volume captures all of Claude Code's state and **one**
host directory supplies all of your config. Named for the plural: three CLIs
today, and the install-guard shape each one uses (idempotent, remote-user,
network-required-or-fail-the-build) is meant to take a fourth without a
rename. **Not** the `anthropic.claude-code` VS Code extension — see
[What this is not](#what-this-is-not).

```jsonc
"features": {
  "ghcr.io/bmingles/devc-tools/agents:0": {}
}
```

No mounts, no options you have to set. A bare `{}` installs the Claude CLI,
leaves an empty seed directory for you to mount onto, and points
`~/.claude.json` at `~/.claude/.claude.json`.

> The tag tracks **this Feature's own** version line, not the repo's — see
> [../README.md#versions](../README.md#versions). It is `:0` while this Feature is
> pre-1.0.

## The three Claude paths

Three paths, three lifetimes — reproduced here rather than paraphrased, because
getting one of these confused for another is the whole failure mode this Feature
exists to prevent:

| Path                                                | What it is                                                                                                                 | Lifetime                                                       |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `~/.claude`                                         | Claude Code's own state directory — `projects/`, `todos/`, credentials, settings, and now `.claude.json` too.              | Per-workspace, if you mount a volume there (your choice).      |
| `/usr/local/share/devc-features/agents/claude-seed` | **Fixed.** Where you bind-mount your own host config. Created empty at build time; this Feature only ever reads it.        | Same as your bind mount; empty and harmless if you mount none. |
| a host seed directory                               | **Your** config — `CLAUDE.md`, `settings.json`, `statusline.sh`. The one thing you decide, and you decide it with a mount. | Lives on your host; the container only ever reads it.          |

`~/.claude.json` is deliberately **not** in that table any more: it is now a
symlink into `~/.claude`, with no lifetime of its own. See
[Why `~/.claude.json` moves](#why-claudejson-moves).

## What it does

At **build time** (as root):

1. Installs the Claude CLI (when `installClaudeCli`, default `true`), the
   GitHub Copilot CLI (when `installCopilotCli`, default `false`), and the pi
   coding agent CLI (when `installPiCli`, default `false`) — as the **remote
   user**, not root, into `~/.local/bin`. Installing as root would put the
   binary somewhere the remote user cannot later update (`claude`/`copilot
   update`/`pi update`) — the same reason
   [`devc-core/default/Dockerfile`](../../devc-core/default/Dockerfile) switches
   `USER` before its own two equivalent `RUN` lines, which this Feature copies
   the install guards from verbatim. Idempotent: a rebuild does not re-download
   when the binary is already there. **Network is required** when any install
   option is true — a failed download fails the build, rather than leaving a
   container that looks fine until the first `claude`.
2. Pre-creates `$_REMOTE_USER_HOME/.claude` owned by the remote user. See
   [The volume question](#the-volume-question) for why.
3. Pre-creates the seed directory, empty. It is this Feature's published
   surface — the same shape as `bash-config`'s `dirs/user`.

At **create time** (as the remote user, before any user `postCreateCommand`),
`post-create.sh` runs three steps:

1. **Ownership repair.** If `~/.claude` is not owned by the current user, a
   non-recursive `sudo chown` fixes it (best-effort; a missing `sudo` only
   warns). Non-recursive is a hard requirement, not a style choice — subpaths
   like `skills/` may be host bind mounts and must not be chowned. Expected to
   be a no-op given step 2 above; kept because it is cheap and the alternative
   is unverified — see [The volume question](#the-volume-question).
2. **Seed links.** Every top-level _file_ in the seed directory is symlinked
   into `~/.claude` — host edits are live, host file modes (the statusline exec
   bit) survive, deletions on the host prune the link on the next create.
   Directories are ignored by design: a `~/.claude/skills/` mount point
   (something else's job, not this Feature's) would either get a nested
   `skills/skills` or fail on a busy mountpoint if this tried to link over it.
   An empty seed — nothing mounted — links nothing and moves on.
3. **`~/.claude.json`.** Replaced with a symlink to `~/.claude/.claude.json`,
   seeded with `{}` if nothing is there yet. Unconditional. See
   [below](#why-claudejson-moves).

Every skip path exits `0`. A `postCreateCommand` that fails aborts container
creation, and none of these skips (an empty seed, ownership already correct) is
worth an unbootable container.

| Option              | Default | Meaning                                                                                                  |
| ------------------- | ------- | -------------------------------------------------------------------------------------------------------- |
| `installClaudeCli`  | `true`  | Install the Claude Code CLI at build time, as the remote user.                                           |
| `installCopilotCli` | `false` | Install the GitHub Copilot CLI too. Defaults false — see [below](#why-installcopilotcli-defaults-false). |
| `installPiCli`      | `false` | Install the pi coding agent CLI too. Defaults false, same reasoning as `installCopilotCli`.               |

That is the whole option surface.

### Why there are no path options

Versions before `0.2.0` had three: `claudeDir`, `seedDir` and `claudeJsonDir`.
All three are gone, and each for its own reason:

- **`claudeDir`** was a footgun rather than a capability. Claude Code resolves
  its own state directory as `$CLAUDE_CONFIG_DIR`, or `$HOME/.claude` when that
  variable is unset — so any value other than the remote user's own
  `~/.claude` pointed this Feature at a directory Claude Code never reads, and
  did it silently. There is exactly one correct answer, and the Feature now
  derives it.
- **`seedDir`** existed because the Feature "never invents a path only the
  consumer can mount." But the consumer does not need to _name_ the path to
  mount onto it — `bash-config` already fixes `dirs/user` and asks you to
  mount there. Fixing the path deletes the option **and** the class of bug
  where the mount target and the option disagree.
- **`claudeJsonDir`** is answered by [the section below](#why-claudejson-moves).

With no path options left, `install.sh` has nothing to validate and nothing to
bake: the injection guard and the `bake()` rewriting earlier versions carried
are gone with them. What replaced the bake guard is a pair of `grep`s in
`test/install_options_test.sh` asserting that the seed path `install.sh`
creates and the one `post-create.sh` reads are still the same string.

### Why `~/.claude.json` moves

Claude Code resolves its config/auth file as `$CLAUDE_CONFIG_DIR/.claude.json`,
falling back to `$HOME/.claude.json`. It is therefore a **sibling** of
`~/.claude`, not a member of it — the one piece of Claude Code state that a
volume mounted at `~/.claude` does not capture. And a volume can only mount at a
_directory_, so `~/.claude.json` cannot be a mount target on its own.

Earlier versions solved that with a second volume and the `claudeJsonDir`
option naming where it was mounted. Symlinking the file into `~/.claude`
instead solves it with no volume and no option: **one** mount now captures
everything, and `.claude.json` sits next to the `.credentials.json` and
`history.jsonl` it belongs with.

This is unconditional — there is nothing left to opt into. With no volume
mounted it is an indirection inside one home directory, which costs nothing and
keeps one code path instead of two.

Two consequences worth knowing:

- **A pre-existing real `~/.claude.json` is _moved_, not deleted.** The step
  used to run only when you opted in, so deleting the file it replaced was
  defensible; unconditional, it would be data loss. If
  `~/.claude/.claude.json` does not exist yet and `~/.claude.json` is a real
  file, it is `mv`d into place and you keep your session.
- **A symlink left by an older version is repointed, not kept.** The check
  compares the link's _target_, not just whether it is a link. Upgrading from
  `0.1.x` with a `claudeJsonDir` volume therefore starts a fresh
  `.claude.json` in the `~/.claude` volume — one re-login, once. The old
  volume is left untouched on disk; nothing deletes it for you.

### Why `installCopilotCli` defaults `false`

devc's own baseline installs both CLIs unconditionally today, and will pass
`installCopilotCli: true` when it eventually swaps onto this Feature (see
[Relationship to devc](#relationship-to-devc)). Even though this Feature is
named and scoped for agent CLIs plural, a consumer who enables it for Claude
should not silently get a second vendor's CLI too — each install stays
opt-in per CLI, so the default here is the narrower one and devc opts in
explicitly. `installPiCli` defaults `false` for the identical reason: enabling
this Feature for Claude must not silently install a third vendor's CLI either.

## What a consumer mounts

A Feature can declare no read-only mount and no `initializeCommand` (see
[../README.md](../README.md#layout)), so both mounts below are, unavoidably,
your own `devcontainer.json` — but neither needs a matching option any more:

```jsonc
"mounts": [
  // persistence: per-workspace Claude state that survives a rebuild — one volume,
  // and ~/.claude.json rides along inside it
  "type=volume,source=claude-config-${localWorkspaceFolderBasename},target=/home/vscode/.claude",
  // seed: your own host config, read-only and live
  "type=bind,source=${localEnv:HOME}/.config/claude-seed,target=/usr/local/share/devc-features/agents/claude-seed,readonly"
],
"initializeCommand": "mkdir -p ${localEnv:HOME}/.config/claude-seed",
"features": {
  "ghcr.io/bmingles/devc-tools/agents:0": {}
}
```

Each piece is independent — mount only the volume you want, or only the seed,
or neither. `${localWorkspaceFolderBasename}` substitution inside a
**consumer's own** `mounts` (as above) is ordinary, documented devcontainer
behavior — nothing about the open question below affects it. So per-workspace
isolation is available to every consumer **today**, however that question
eventually lands; it costs one line in your own config, not a missing
capability.

The seed bind is `readonly` on purpose, and that has one edge: seeded files are
symlinked into `~/.claude`, so Claude Code writing to one of them (a `/config`
change, a plugin install touching `settings.json`) fails. Host edits reaching
the container live, with no rebuild, is the trade that buys.

## The volume question

devc's baseline names its volumes per workspace — and a Feature _can_ declare
`type=volume` mounts (no `readonly` needed, so the object form is legal in the
published Feature schema). Doing so would make this Feature self-sufficient for
persistence, with no paste required.

It turns on one fact nobody has measured yet: **does
`${localWorkspaceFolderBasename}` substitute inside a Feature's own `mounts`
array?** `${localEnv:HOME}` is measured working (see
[`.plans/archived/devc-bridge-feature.md`](../../.plans/archived/devc-bridge-feature.md)),
but that is a different variable class, and nobody has run a container to
check this one — no Docker in the environment this Feature was written in.

If it substitutes, declaring the volume here is strictly better and a later
version of this Feature should do it. If it does not, declaring it anyway
would silently give **every project one shared volume** — worse than declaring
nothing, since two unrelated repos would share Claude auth and history with no
way to tell. That asymmetry is why this version takes the safe path: **no
`mounts` are declared**, and the line above is a paste instead of a default.
See
[`.plans/design/devc-feature-split.md`](../../.plans/design/devc-feature-split.md)
(open question 2) for the note recording this as still unmeasured, and open
question 3 for a related, also-unmeasured question about first-use volume
ownership — which is why the ownership-repair step in `post-create.sh` stays,
belt-and-braces, regardless of how question 2 eventually lands.

Note that this question got **cheaper** at `0.2.0`, not harder: there is one
volume to declare now instead of two.

## Relationship to devc

**devc no longer carries its own copy of this script.** It used to run an
equivalent `devc-core/default/scripts/agents-setup.sh` against its own
`/usr/local/share/devc/claude-seed` and `/usr/local/share/devc/claude-json`
paths; that script is retired, and devc now declares this Feature directly
in its bundled `devcontainer.json` (see
[`.plans/archived/devc-swap-baseline-features.md`](../../.plans/archived/devc-swap-baseline-features.md)),
with its seed bind retargeted onto this Feature's fixed path and the second,
`claude-json-*` volume dropped outright — `0.2.0`'s fold of `~/.claude.json`
into `~/.claude` left nothing for it to back.

This Feature is named for _agents_ plural (the original id was
`claude-config`, renamed before any consumer depended on it — see
[../README.md](../README.md)) — `post-create.sh` is namespaced under
`/usr/local/share/devc-features/agents/`.

devc's own `~/.claude` seed is documented in
[`devc/README.md`](../../devc/README.md#claude-config-configdevcclaude); its
`ensureClaudeSeedDir` (in
[`devc-core/default_config.ts`](../../devc-core/default_config.ts)) is why the
host seed directory always exists before devc ever binds it in. That function
has a `seedDir` parameter of its own — it names a **host** path and is
unrelated to the Feature option of the same name that `0.2.0` removed.

## What this is not

**Not the `anthropic.claude-code` VS Code extension** — that is a
`customizations.vscode.extensions` entry in devc's own
`devcontainer.json`, unrelated to installing the CLI. This Feature could
declare that extension too; it deliberately does not, without deciding that
separately — a config Feature that silently installs editor extensions is a
surprise a consumer did not ask for.

**Not a place for the `devc:skills` per-skill bind mounts** either — those are
wizard output `devc config` writes into `devc.json` as overlay mounts, not
baseline config, and nothing about them is Feature-shaped. They are also why
the seed step ignores directories.

**Not a way to share one `.claude.json` across projects.** Folding it into
`~/.claude` ties its lifetime to whatever you mount there — a per-workspace
volume keeps it per-workspace, exactly as the separate volume did.

## Tests

No Docker needed:

```sh
bash devc/tests/seed_link_test.sh features/agents/post-create.sh
bash features/agents/test/install_options_test.sh
bash features/agents/test/claude_json_test.sh
```

`seed_link_test.sh` is devc's own shared harness (see
[`devc/README.md`](../../devc/README.md#development)), reused unmodified
against this Feature's copy of the `devc:seed-link` block — the drift guard.
The block is byte-identical to devc's across `0.2.0` apart from its two
parameterizing assignments, which is the whole point of the fence.
`install_options_test.sh` runs the real `install.sh` with `curl` and `runuser`
stubbed on `PATH` (no network, no real privilege switch — that half needs
Docker), covering the two fixed paths, the already-installed idempotent skip,
and that a failed download fails the build. `claude_json_test.sh` runs the
real, installed `post-create.sh` against a temp `HOME` with `stat`/`sudo`
stubbed, covering ownership repair and every `~/.claude.json` case including
the move-don't-delete and repoint-a-stale-link paths.

Needs Docker and a network:

```sh
bash features/agents/test/run-features-test.sh
```

The default scenario (`test.sh`) is the bare `{}` case: `claude` on `PATH` and
executable by the remote user, `~/.claude` owned by the remote user, an empty
seed directory with nothing linked out of it, `~/.claude.json` a symlink into
`~/.claude` reading back `{}`, and `copilot`/`pi` absent. `test/scenarios.json`
adds `with_seed` (a populated seed written into the fixed container path by the
scenario's own `onCreateCommand`, the same technique
`git-container-config`'s `mounted_identity` scenario uses to stand in for a
mount a Feature cannot declare — asserting top-level seed files land as
symlinks and a seed subdirectory does **not**), `with_copilot`
(`installCopilotCli: true` puts `copilot` on `PATH` alongside `claude`), and
`with_pi` (`installPiCli: true` puts `pi` on `PATH` alongside `claude`). None
of these scenarios pass a path option, because there are none: `with_seed`
differs from the default scenario only by what it writes into the seed.

## Publishing

This Feature **is** on
[`features/PUBLISH_ALLOWLIST.txt`](../PUBLISH_ALLOWLIST.txt) and publishes to
ghcr.io. `0.2.0` removes three options, which is breaking for anyone who set
them — the floating `:0` tag carries it. See
[../README.md#the-publish-allowlist](../README.md#the-publish-allowlist) for
what that gate is and isn't.
