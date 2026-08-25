# agents-config (devcontainer Feature)

Installs coding-agent CLIs at build time — the **Claude Code CLI**, and optionally
the **GitHub Copilot CLI** — and at create time wires `~/.claude` and
`~/.claude.json` to whatever persistence and seed the consumer has mounted. Named
for the plural: only two CLIs today, but the install-guard shape each one uses
(idempotent, remote-user, network-required-or-fail-the-build) is meant to take a
third without a rename. **Not** the `anthropic.claude-code` VS Code extension —
see [What this is not](#what-this-is-not).

```jsonc
"features": {
  "ghcr.io/bmingles/devc-tools/agents-config:0": {}
}
```

No mounts, no required options. A bare `{}` installs the Claude CLI and does
nothing else — no seed linking, `~/.claude.json` left completely alone, Copilot
absent. Each further capability is one mount plus one option paste; see
[What a consumer mounts](#what-a-consumer-mounts-in-itself) below.

> The tag tracks **this Feature's own** version line, not the repo's — see
> [../README.md#versions](../README.md#versions). It is `:0` while this Feature is
> pre-1.0.

## The four Claude paths

Four different paths, three different lifetimes — reproduced here rather than
paraphrased, because getting one of these confused for another is the whole
failure mode this Feature exists to prevent:

| Path                                      | What it is                                                                        | Lifetime                                                  |
| ----------------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `~/.claude` (`claudeDir`)                 | Claude Code's own state directory — `projects/`, `todos/`, credentials, settings. | Per-workspace, if you mount a volume there (your choice). |
| `~/.claude.json`                          | Claude Code's auth/session file.                                                  | Same lifetime as whatever `claudeJsonDir` backs it with.  |
| a host seed directory (`seedDir`)         | **Your** config — `CLAUDE.md`, `settings.json`, `statusline.sh` — read-only.      | Lives on your host; the container only ever reads it.     |
| `claude-seed` (the container mount point) | Where `seedDir` is bind-mounted to, inside the container.                         | Same as the bind mount.                                   |

## What it does

At **build time** (as root):

1. Installs the Claude CLI (when `installClaudeCli`, default `true`) and the
   GitHub Copilot CLI (when `installCopilotCli`, default `false`) — as the
   **remote user**, not root, into `~/.local/bin`. Installing as root would put
   the binary somewhere the remote user cannot later update (`claude`/`copilot
   update`) — the same reason
   [`devc-core/default/Dockerfile`](../../devc-core/default/Dockerfile) switches
   `USER` before its own two equivalent `RUN` lines, which this Feature copies
   the install guards from verbatim. Idempotent: a rebuild does not re-download
   when the binary is already there. **Network is required** when either
   install option is true — a failed download fails the build, rather than
   leaving a container that looks fine until the first `claude`.
2. Pre-creates `claudeDir` (default `$_REMOTE_USER_HOME/.claude`) owned by the
   remote user. See [The volume question](#the-volume-question) for why.

At **create time** (as the remote user, before any user `postCreateCommand`),
`post-create.sh` runs three steps:

1. **Ownership repair.** If `claudeDir` exists and is not owned by the current
   user, a non-recursive `sudo chown` fixes it (best-effort; a missing `sudo`
   only warns). Non-recursive is a hard requirement, not a style choice —
   subpaths like `skills/` may be host bind mounts and must not be chowned.
   Expected to be a no-op given step 2 of the build-time install above; kept
   because it is cheap and the alternative is unverified — see
   [The volume question](#the-volume-question).
2. **Seed links.** When `seedDir` is non-empty and exists, every top-level
   _file_ in it is symlinked into `claudeDir` — host edits are live, host file
   modes (the statusline exec bit) survive, deletions on the host prune the
   link on the next create. Directories are ignored by design: a
   `~/.claude/skills/` mount point (something else's job, not this Feature's)
   would either get a nested `skills/skills` or fail on a busy mountpoint if
   this tried to link over it. Empty (the default) skips the whole step — this
   Feature never invents a seed path, since only the consumer's own
   `devcontainer.json` can mount one in.
3. **`~/.claude.json`.** When `claudeJsonDir` is non-empty: the directory is
   chowned (best-effort), `"$claudeJsonDir/claude.json"` is seeded with `{}` if
   absent, and `~/.claude.json` is replaced with a symlink to it unless it
   already is one. A volume can only mount at a _directory_, which is the whole
   reason for the indirection — a per-workspace `~/.claude.json` (a file)
   cannot be a mount target on its own. Empty (the default) leaves
   `~/.claude.json` alone entirely — the plain file Claude Code creates itself,
   for a consumer with nothing mounted here.

Every skip path exits `0`. A `postCreateCommand` that fails aborts container
creation, and none of these skips (no seed, no claude.json volume, ownership
already correct) is worth an unbootable container.

| Option              | Default | Meaning                                                                                                  |
| ------------------- | ------- | -------------------------------------------------------------------------------------------------------- |
| `installClaudeCli`  | `true`  | Install the Claude Code CLI at build time, as the remote user.                                           |
| `installCopilotCli` | `false` | Install the GitHub Copilot CLI too. Defaults false — see [below](#why-installcopilotcli-defaults-false). |
| `claudeDir`         | `""`    | Container path for `~/.claude`. Empty resolves to `$_REMOTE_USER_HOME/.claude` at build time.            |
| `seedDir`           | `""`    | Container path to a read-only host config seed. Empty skips seed linking entirely.                       |
| `claudeJsonDir`     | `""`    | Container path to a directory backing `~/.claude.json`. Empty leaves the file alone.                     |

Every path option is pasted into a double-quoted shell assignment in
`post-create.sh`, so a value containing a double quote, backtick, dollar sign,
backslash or newline fails the **build**, naming the option, rather than
silently producing a script that does something else — same policy as every
other Feature in this collection.

### Why `installCopilotCli` defaults `false`

devc's own baseline installs both CLIs unconditionally today, and will pass
`installCopilotCli: true` when it eventually swaps onto this Feature (see
[Relationship to devc](#relationship-to-devc)). Even though this Feature is
named and scoped for agent CLIs plural, a consumer who enables it for Claude
should not silently get a second vendor's CLI too — each install stays
opt-in per CLI, so the default here is the narrower one and devc opts in
explicitly.

## What a consumer mounts in itself

A Feature can declare no read-only mount and no `initializeCommand` (see
[../README.md](../README.md#layout)), so the seed and the auth persistence are
both, unavoidably, the consumer's own `devcontainer.json` — paste what you want:

```jsonc
// persistence: per-workspace auth + config that survives a rebuild
"mounts": [
  "type=volume,source=agents-config-${localWorkspaceFolderBasename},target=/home/vscode/.claude",
  "type=volume,source=claude-json-${localWorkspaceFolderBasename},target=/usr/local/share/claude-json",
  // seed: your own host config, read-only and live
  "type=bind,source=${localEnv:HOME}/.config/claude-seed,target=/usr/local/share/claude-seed,readonly"
],
"initializeCommand": "mkdir -p ${localEnv:HOME}/.config/claude-seed",
"features": {
  "ghcr.io/bmingles/devc-tools/agents-config:0": {
    "seedDir": "/usr/local/share/claude-seed",
    "claudeJsonDir": "/usr/local/share/claude-json"
  }
}
```

Each piece is independent — mount only the volume you want, or only the seed.
`${localWorkspaceFolderBasename}` substitution inside a **consumer's own**
`mounts` (as above) is ordinary, documented devcontainer behavior — nothing
about the open question below affects it. So per-workspace isolation is
available to every consumer **today**, however that question eventually lands;
it costs one extra line in your own config, not a missing capability.

## The volume question

devc's baseline names its two volumes per workspace —
`claude-code-config-${localWorkspaceFolderBasename}` and
`claude-json-${localWorkspaceFolderBasename}` — and a Feature _can_ declare
`type=volume` mounts (no `readonly` needed, so the object form is legal in the
published Feature schema). Doing so would make this Feature self-sufficient for
persistence, with no paste required.

It turns on one fact nobody has measured yet: **does
`${localWorkspaceFolderBasename}` substitute inside a Feature's own `mounts`
array?** `${localEnv:HOME}` is measured working (see
[`.plans/archived/devc-bridge-feature.md`](../../.plans/archived/devc-bridge-feature.md)),
but that is a different variable class, and nobody has run a container to
check this one — no Docker in the environment this Feature was written in.

If it substitutes, declaring both volumes here is strictly better and a later
version of this Feature should do it. If it does not, declaring them anyway
would silently give **every project one shared volume** — worse than declaring
nothing, since two unrelated repos would share Claude auth and history with no
way to tell. That asymmetry is why this version takes the safe path: **no
`mounts` are declared**, and the two lines above are a paste instead of a
default. See
[`.plans/design/devc-feature-split.md`](../../.plans/design/devc-feature-split.md)
(open question 2) for the note recording this as still unmeasured, and open
question 3 for a related, also-unmeasured question about first-use volume
ownership — which is why the ownership-repair step in `post-create.sh` stays,
belt-and-braces, regardless of how question 2 eventually lands.

## Relationship to devc

**This Feature and `devc-core/default/scripts/agents-setup.sh` are two files
with the same behavior, not one.** `agents-setup.sh` is devc's own copy — it
keeps running exactly as it does today; swapping devc onto this published
Feature is a separate, later change (see `.plans/PLAN.md`). Both are named for
_agents_ plural now (`agents-setup.sh` already says so in its own comment,
`# Copilot or other agent setup would join here`; this Feature was originally
published as `claude-config` and renamed to `agents-config` to match, before
any consumer depended on the old id) — if you are editing "the agent setup
script," check which file you mean regardless: this Feature's `post-create.sh`
is namespaced under `/usr/local/share/devc-features/agents-config/`, devc's
copy runs from `devc-core/default/scripts/` and writes nothing under that
namespace.

The path devc's own script and docs cite has moved since this plan was
written: the plan that produced this Feature cites `devc/default/scripts/`,
`devc/default/Dockerfile` and `devc/default/devcontainer.json`, all of which
had already become `devc-core/default/` by the time this Feature was
implemented — the same rename `git-container-config`'s README already records.
Every path in this document uses the current, real location.

devc's own `~/.claude` seed is documented in
[`devc/README.md`](../../devc/README.md#claude-config-configdevcclaude); its
`ensureClaudeSeedDir` (in
[`devc-core/default_config.ts`](../../devc-core/default_config.ts)) is why the
host seed directory always exists before devc ever binds it in. Enabling this
Feature in a devc container today would be redundant with devc's own
baseline — both would seed-link and manage `~/.claude.json` the same way,
harmlessly (the block is idempotent) — but is not yet how devc itself is
wired.

## What this is not

**Not the `anthropic.claude-code` VS Code extension** — that is a
`customizations.vscode.extensions` entry in devc's own
`devcontainer.json`, unrelated to installing the CLI. This Feature could
declare that extension too; it deliberately does not, without deciding that
separately — a config Feature that silently installs editor extensions is a
surprise a consumer did not ask for.

**Not a place for the `devc:skills` per-skill bind mounts** either — those are
wizard output `devc config` writes into `devc.json` as overlay mounts, not
baseline config, and nothing about them is Feature-shaped.

## Tests

No Docker needed:

```sh
bash devc/tests/seed_link_test.sh features/agents-config/post-create.sh
bash features/agents-config/test/install_options_test.sh
bash features/agents-config/test/claude_json_test.sh
```

`seed_link_test.sh` is devc's own shared harness (see
[`devc/README.md`](../../devc/README.md#development)), reused unmodified
against this Feature's copy of the `devc:seed-link` block — the drift guard.
`install_options_test.sh` runs the real `install.sh` with `curl` and `runuser`
stubbed on `PATH` (no network, no real privilege switch — that half needs
Docker), covering option baking, the path-option injection guard, the
already-installed idempotent skip, and that a failed download fails the build.
`claude_json_test.sh` runs the real, installed `post-create.sh` against a temp
`HOME` with `stat`/`sudo` stubbed, covering the ownership-repair and
`~/.claude.json` steps (the seed-link step is what the first command above
already covers).

Needs Docker and a network:

```sh
bash features/agents-config/test/run-features-test.sh
```

The default scenario (`test.sh`) is the bare `{}` case: `claude` on `PATH` and
executable by the remote user, `~/.claude` owned by the remote user, nothing
linked into it, `~/.claude.json` left alone, and `copilot` absent.
`test/scenarios.json` adds `with_seed_and_json` (a seed and a claude.json
directory written into a fixed container path by the scenario's own
`onCreateCommand`, the same technique `git-container-config`'s
`mounted_identity` scenario uses to stand in for a mount a Feature cannot
declare — asserting top-level seed files land as symlinks, a seed subdirectory
does **not**, and `~/.claude.json` becomes a symlink reading back `{}`) and
`with_copilot` (`installCopilotCli: true` puts `copilot` on `PATH` alongside
`claude`).

## Publishing

This Feature is **not** on
[`features/PUBLISH_ALLOWLIST.txt`](../PUBLISH_ALLOWLIST.txt) — it does not
publish to ghcr.io yet. See
[../README.md#the-publish-allowlist](../README.md#the-publish-allowlist) for
what that gate is and isn't.
