# devc swaps onto `agents`/`git-container-config`; `bashrc-additions` moves into `devc-config`

## Goal

Three of `devc-core/default/scripts/`' four remaining baseline steps go away as
devc's own scripts:

1. **`agents-setup.sh`** is retired. devc's bundled `devcontainer.json` declares
   the already-published [`agents`](../features/agents/README.md) Feature
   instead, with options pointing at the same mounts devc already declares.
   The Dockerfile's own Claude/Copilot CLI install steps are retired too — the
   Feature's `install.sh` does that now.
2. **`git-setup.sh`** is retired the same way, onto
   [`git-container-config`](../features/git-container-config/README.md).
3. **`bashrc-additions.sh`** does **not** retire the same way. Its content —
   the custom `PS1`, the terminal-title trap, the `DEVC_ATTACH` first-prompt
   clear — moves _into_ [`devc-config`](../features/devc-config/README.md)'s
   `post-create.sh`, as a second fenced block alongside the existing
   project-hook one. This is deliberate, not a filing convenience: `devc-config`
   is the one Feature devc dynamically injects into **every** container it
   starts, project mode included, so this is what makes devc's prompt/title
   behavior reach a project-mode repo for the first time. Everything else
   devc bundles (`agents`, `git-container-config`, `bash-config`, `node-nvmrc`,
   `node`, `python`, …) stays zero-config/`devc init`-only, same as today.

With all three gone, `devc-core/default/scripts/`, `post-create.sh` and the
bundled config's `onCreateCommand` have nothing left to do — see
[Contracts](#devc-coredefault--post-createsh-scripts-and-oncreatecommand-removed)
for why this plan removes them outright rather than leaving an empty
orchestrator.

## Why this reopens the ordering question

[`devc-inject-project-hook`](archived/devc-inject-project-hook.md) put devc's
baseline on `onCreateCommand` specifically so it would precede a
Feature-declared `postCreateCommand` (`devc-config`'s, running the project's
own hook) — the CLI runs every Feature's `postCreateCommand` before the base
config's own, so there was no way to win that race by staying on
`postCreateCommand`.

This plan removes `onCreateCommand` from the picture entirely for two of the
three steps that used to live there: `agents-setup`/`git-setup`'s replacements
(`agents`, `git-container-config`) run via their own Feature-declared
`postCreateCommand`s, the **same phase** `devc-config`'s hook runs in. The
`onCreate`-precedes-`postCreate` trick no longer applies between them — that
was a phase-level lever, and all three are now in the same phase.

The lever that _does_ apply between Features in one phase is `installsAfter`:
the CLI resolves Feature-to-Feature order (both image-layer order and,
consequently, lifecycle-command order) from each Feature's own
`installsAfter`. `devc-config`'s manifest gains
`"installsAfter": ["ghcr.io/bmingles/devc-tools/agents", "ghcr.io/bmingles/devc-tools/git-container-config"]`
so its hook still runs after both, restoring the same guarantee the
`onCreateCommand` trick gave before — but only among Features devc itself
knows to name. See [Concept boundaries](#concept-boundaries) for why this does
not (and cannot) extend to a project's own, unrelated Features.

## Existing touchpoints

- `devc-core/default/devcontainer.json` — `features` gains `agents` and
  `git-container-config` entries with options; `onCreateCommand` and its
  comment are deleted.
- `devc-core/default/Dockerfile` — the `COPY post-create.sh` / `COPY scripts/`
  / chmod block is deleted; the Claude CLI and Copilot CLI `RUN` steps are
  deleted (the `agents` Feature's `install.sh` does this now). The `ripgrep`
  install and the `USER root`/`USER vscode` switches are unrelated and stay.
- `devc-core/default/post-create.sh` — deleted.
- `devc-core/default/scripts/agents-setup.sh` — deleted.
- `devc-core/default/scripts/git-setup.sh` — deleted.
- `devc-core/default/scripts/bashrc-additions.sh` — deleted; its content moves
  into `features/devc-config/post-create.sh` (see Contracts).
- `devc-core/default_config.ts` — `installBundledAssets`' fixed `executable`
  list drops `post-create.sh` and the `scripts/*.sh` readdir loop (nothing
  left under `scripts/` to chmod); `materializeDefaultConfig`'s
  `postCreateCommand`/`onCreateCommand` `replaceAll` rewrite is deleted (there
  is no such key left to rewrite). The `initializeCommand` rewrite is
  untouched.
- `devc-core/default/initialize-command.sh` — two stale comments already
  predate this plan and get fixed in the same pass: "see the `USER_SHELL_DIR`
  layer in `scripts/bashrc-additions.sh`" (that layer left
  `bashrc-additions.sh` for the `bash-config`/`shell-dirs` Features some time
  ago; the comment was never updated) and the general
  `scripts/git-setup.sh` reference. Confirm before editing rather than
  assuming — `git blame` the two lines.
- `features/devc-config/post-create.sh` — gains a second fence,
  `devc:bashrc-additions`, containing `bashrc-additions.sh`'s content
  unmodified. Sequencing is a real decision — see Contracts.
- `features/devc-config/devcontainer-feature.json` — `installsAfter` added;
  `version` bumped (a real behavior change to an already-published Feature).
- `features/devc-config/install.sh` — header comment updated: two fenced
  blocks now, not one.
- `features/devc-config/README.md` — documents the second fence, the ordering
  guarantee, and that a non-devc consumer who declares `"devc-config": {}`
  now gets the prompt/title behavior too, not just the project hook.
- `devc-core/overlay.ts` — `DEVC_CONFIG_FEATURE`'s version bumped to match.
- `tests/workflow_guards_test.sh` — the existing `devc_config_pin_agrees`
  guard covers the bump automatically; no new guard needed.
- `devc-core/tests/default_config_test.ts` — the `scripts/agents-setup.sh` /
  `scripts/git-setup.sh` / `scripts/bashrc-additions.sh` presence assertions
  in the `materializeDefaultConfig` tests are replaced with assertions that
  `agents`/`git-container-config` are declared with the right options and
  that `onCreateCommand` is absent.
- `devc-core/tests/init_test.ts` — the `.devcontainer/scripts/bashrc-additions.sh`
  existence assertion is replaced (scaffolded output no longer has a
  `scripts/` directory at all).
- `devc/tests/seed_link_test.sh` — currently run against **two** copies
  (`devc-core/default/scripts/agents-setup.sh` and
  `features/agents/post-create.sh`); devc's copy is gone, so this becomes the
  only-copy-left-to-test case, the same transition `devc_config_test.sh` went
  through for the project-hook fence.
- `devc/tests/shell_dirs_test.sh` invoked against
  `../devc-core/default/scripts/bashrc-additions.sh` in `devc/README.md`'s
  harness list — **already broken today** (confirmed: `FAIL: could not
  extract shell-dirs block` — `bashrc-additions.sh` has carried no
  `devc:shell-dirs` fence for some time, a leftover from the `shell-dirs`
  Feature's own retirement). This plan deletes the line rather than fixing
  it, since the file it points at no longer exists either way. Not this
  plan's regression, but the line has to go regardless.
- A new `devc/tests/bashrc_additions_test.sh` — offline harness extracting
  the `devc:bashrc-additions` fence from `features/devc-config/post-create.sh`
  and exercising it against a temp `$HOME`, same shape as `devc_config_test.sh`.
  No second copy to run it against — `bashrc-additions.sh` had none either,
  historically.
- `devc/README.md` — the "Claude config" section's "`scripts/agents-setup.sh`
  (run by `post-create.sh`)" line and the "Git setup" section's
  "`scripts/git-setup.sh` (run by `post-create.sh`)" line both need to
  reference the Features instead. The fence-harness list drops the two
  `agents-setup.sh`/`bashrc-additions.sh` devc-copy invocations and gains the
  new `bashrc_additions_test.sh` line.
- `docs/manual-verification.md` — new Docker-needed scenarios (see
  Validation).
- `.plans/PLAN.md` — register, then move this plan to `archived/` on
  completion.

## Contracts

### `devc-core/default/devcontainer.json` — the two new Feature entries

```jsonc
"features": {
  // … existing entries …
  "ghcr.io/bmingles/devc-tools/agents:0": {
    // claudeDir left at its default (resolves to $_REMOTE_USER_HOME/.claude at
    // build time) — MEASURE that this equals /home/vscode/.claude, the path
    // devc's own claude-code-config-* volume already mounts at, before
    // shipping. If it does not, set claudeDir explicitly instead of relying
    // on the default.
    "seedDir": "/usr/local/share/devc/claude-seed",
    "claudeJsonDir": "/usr/local/share/devc/claude-json",
    // Preserves current behavior: devc's own Dockerfile installs Copilot
    // unconditionally today. The Feature's own default is false.
    "installCopilotCli": true
  },
  "ghcr.io/bmingles/devc-tools/git-container-config:0": {
    "identityIncludePath": "/usr/local/share/devc/gitconfig-identity"
    // lfsFilters, lfsSkipSmudge, worktreeRelativePaths, safeDirectory all left
    // at their defaults — they already match git-setup.sh's behavior exactly
    // (confirmed by reading both side by side). Do not restate defaults.
  }
}
```

Both use the floating `:0`, matching every other bundled Feature except
`devc-config` — these are declared once, statically, the same way
`bash-config`/`node-nvmrc` already are. Nothing about them is forced on every
container the way `devc-config` is: a user who wants to change or remove
either can override `~/.config/devc/templates/devcontainer.json`, the
existing sparse-overlay mechanism every other bundled Feature is already
subject to. No new opt-out mechanism, no `baselineFeatures` involvement —
that key governs only devc's _dynamic_ injection, which stays exactly
`devc-config`, alone.

No mounts change. `agents` and `git-container-config` declare none
themselves (a Feature cannot), and devc's own `mounts` array already has
every target these options name — `claude-code-config-*` → `~/.claude`,
`claude-json-*` → `/usr/local/share/devc/claude-json`, the `claude-seed` bind,
the `gitconfig-identity` bind. This plan repoints existing infrastructure at
existing mounts; it adds none.

### `devc-core/default/` — post-create.sh, scripts/, and onCreateCommand removed

With `agents-setup.sh`, `git-setup.sh` and `bashrc-additions.sh` all gone,
`post-create.sh` has zero `bash "$scripts/…"` lines left and
`devc-core/default/scripts/` is empty. **Remove all three outright** —
`post-create.sh`, `scripts/`, and the `onCreateCommand` key — rather than
leaving an empty orchestrator:

- An empty `scripts/` directory cannot be committed to git at all without a
  placeholder file, so "leave it empty" is not actually a no-edit option.
- Removing cleanly avoids a Dockerfile `COPY scripts/` of nothing, an
  `installBundledAssets` readdir over an absent directory (which would throw,
  not silently no-op), and an `onCreateCommand` that runs a script that does
  nothing.
- `initializeCommand` is unaffected and stays — it runs on the **host**,
  before the container exists, and nothing in this plan touches what it does
  (seed a `.claude` mount source, write `gitconfig-identity`).

If a future baseline addition needs a devc-owned create-time step again,
reintroducing `onCreateCommand`/`post-create.sh` is one file and one
`devcontainer.json` line — cheap to redo, not worth keeping inert in the
meantime.

### `features/devc-config/post-create.sh` — the second fence, and its order

```bash
#!/bin/bash
# … existing header, updated to mention two fenced blocks …
set -e

# devc:devc-config (start)
# … unchanged project-hook block …
# devc:devc-config (end)

# devc:bashrc-additions (start)
# … bashrc-additions.sh's content, unmodified …
# devc:bashrc-additions (end)
```

**Project hook first, bashrc-additions last** — restoring the pre-`devc-config`
historical order (`agents-setup → git-setup → project-hook → bashrc-additions`,
where `bashrc-additions` ran last of all four). That order was lost when
`devc-config`'s own predecessor plan moved `bashrc-additions` ahead of the
project hook as a side effect of the `onCreateCommand` split, and that plan's
own Contracts section named the fix as a fallback ("splitting `post-create.sh`
into two orchestrators… restores the exact order") without implementing it.
Co-locating both blocks in one file, sequenced this way, _is_ that fallback,
reached by a different route.

Both fences stay independently offline-testable, matching how
`agents-setup.sh` already nests a `devc:seed-link` fence inside otherwise
unfenced code — precedent for more than one named fence per file.

### `features/devc-config/devcontainer-feature.json`

```jsonc
{
  "id": "devc-config",
  "version": "0.2.0",
  // … unchanged …
  "installsAfter": [
    "ghcr.io/bmingles/devc-tools/agents",
    "ghcr.io/bmingles/devc-tools/git-container-config"
  ],
  "postCreateCommand": "bash /usr/local/share/devc-features/devc-config/post-create.sh"
}
```

`installsAfter` only has an effect when the named Features are actually being
installed alongside it — a no-op for a consumer who declares `devc-config`
without also declaring `agents`/`git-container-config`. That is correct here:
those two are devc's own choice of how _it_ provisions Claude/git, not
something `devc-config` requires to function on its own.

Bumping the version is a real content change (new `installsAfter`, a second
fenced block) to a Feature already live on ghcr.io. `overlay.ts`'s
`DEVC_CONFIG_FEATURE` moves to `0.2.0` in the same commit;
`workflow_guards_test.sh`'s existing pin guard fails until both agree, same
as it already does for any version drift.

## Concept boundaries

- **`installsAfter` orders Features devc names, not "everything."** It cannot
  express "run after whatever this consumer happens to declare" — a project's
  own `rust`/`go`/whatever Features are invisible to it. `devc-config`'s hook
  is guaranteed to run after devc's _own_ baseline Features when devc is the
  one assembling the config; it is not guaranteed to run after a project's
  unrelated ones. State this in `devc-config/README.md` rather than let
  someone assume the stronger guarantee.
- **Static declaration (`agents`, `git-container-config` — this plan) vs.
  dynamic injection (`devc-config`, unaffected by this plan).** Two different
  delivery mechanisms living side by side in devc's own bundled config, for
  the reason `devc-inject-project-hook`'s own Superseded section already
  drew: `agents`/`git-container-config` are useful to any devcontainer
  project and need real host mounts + options a Feature cannot self-declare,
  so they get the `bash-config`/`node-nvmrc` treatment (declared once,
  standalone-capable via `devc init`). `devc-config` alone needs to reach
  configs devc does not own, needs no mounts, and is forced with no opt-in —
  the only Feature that gets `baselineFeatures`/exact-pin/dynamic-injection
  treatment stays `devc-config`.
- **Phase-level ordering (`onCreateCommand` before `postCreateCommand`) vs.
  Feature-to-Feature ordering (`installsAfter`) are different levers for
  different problems.** The first plan reached for the phase lever because
  devc's baseline was, at the time, a base-config command competing against a
  Feature's command. This plan reaches for `installsAfter` because all three
  steps are now Features competing against each other in the _same_ phase.
  Conflating the two — assuming `onCreateCommand` still has a role once
  everything is a Feature — is the mistake to name explicitly if it comes up
  in review.
- **`bashrc-additions` moving into `devc-config` is a reach extension.**
  Before this plan, the prompt/title/attach-clear block only ran for configs
  devc materializes or writes (zero-config, `devc init` output). After, it
  reaches a genuinely project-owned `.devcontainer/devcontainer.json` for the
  first time via `devc-config`'s existing dynamic injection — deliberate, and
  the reason `devc-config` (not a new, third Feature) is where this content
  goes: the earlier rename to that name specifically anticipated it becoming
  "the general vehicle for devc-specific contributions," and this is the
  first second use of that vehicle.

## Checklist

- [ ] `devc-core/default/devcontainer.json` — `agents`/`git-container-config`
      entries; `onCreateCommand` removed
- [ ] `devc-core/default/Dockerfile` — `post-create.sh`/`scripts/` COPY+chmod
      removed; Claude/Copilot `RUN` steps removed
- [ ] `devc-core/default/post-create.sh` — deleted
- [ ] `devc-core/default/scripts/` — deleted (all three files)
- [ ] `devc-core/default_config.ts` — `installBundledAssets`' executable list
      and `scripts/*.sh` loop trimmed; the `onCreateCommand` `replaceAll`
      rewrite removed
- [ ] `devc-core/default/initialize-command.sh` — the two stale
      `scripts/*.sh` comment references fixed
- [ ] `features/devc-config/post-create.sh` — `devc:bashrc-additions` fence
      added, project-hook fence first
- [ ] `features/devc-config/devcontainer-feature.json` — `installsAfter`;
      `version` → `0.2.0`
- [ ] `features/devc-config/install.sh` — header comment updated
- [ ] `features/devc-config/README.md` — the new fence, the ordering
      guarantee and its limit, the reach extension
- [ ] `devc-core/overlay.ts` — `DEVC_CONFIG_FEATURE` → `0.2.0`
- [ ] `devc-core/tests/default_config_test.ts` — replace the
      `scripts/*.sh`-presence assertions with the new Feature-declaration
      assertions
- [ ] `devc-core/tests/init_test.ts` — replace the
      `.devcontainer/scripts/bashrc-additions.sh` assertion
- [ ] `devc/tests/bashrc_additions_test.sh` — new, offline
- [ ] `devc/README.md` — Claude config / Git setup prose repointed at the
      Features; fence-harness list updated (drop two stale devc-copy lines,
      add the new harness)
- [ ] `docs/manual-verification.md` — new Docker scenarios (see Validation)
- [ ] `.plans/PLAN.md` — register, and move this plan to `archived/` on
      completion

## Validation

- [ ] `cd devc-core && deno task check && deno task test` — green, with the
      updated `materializeDefaultConfig`/`init` assertions.
- [ ] `cd devc && deno task check && deno task test` — green.
- [ ] `bash devc/tests/seed_link_test.sh ../features/agents/post-create.sh`
      — still green, now the only copy.
- [ ] `bash devc/tests/devc_config_test.sh features/devc-config/post-create.sh`
      — still green (the project-hook fence is unmoved, unmodified).
- [ ] `bash devc/tests/bashrc_additions_test.sh features/devc-config/post-create.sh`
      — new, green.
- [ ] `bash tests/workflow_guards_test.sh` — the existing pin guard fails if
      `overlay.ts` and the manifest disagree on `0.2.0`.
- [ ] `bash tests/features_test.sh` — green.
- [ ] `deno fmt --check` clean.
- [ ] (needs Docker) **`claudeDir`'s default actually resolves to
      `/home/vscode/.claude`** for this base image/remote user — the one
      value this plan assumes rather than measures. If it does not, set
      `claudeDir` explicitly rather than relying on the default.
- [ ] (needs Docker) **Zero-config end-to-end**: `devc up` on a project with
      no config of its own. `~/.claude` seeded and owned correctly,
      `~/.claude.json` symlinked, git identity/LFS/`safe.directory` all set —
      same observable outcome as before this plan, now delivered by two
      Features instead of two scripts.
- [ ] (needs Docker) **The `installsAfter` ordering claim, for real** — not
      just read from source. A hook (via `devc-config`, reached through the
      project's own `devc-post-create.sh`) that checks `git config --get
      user.email` and whether `~/.claude` is populated sees both already set
      up. This is the direct successor to the equivalent check
      `devc-inject-project-hook` ran for the `onCreateCommand` version of
      this guarantee — same property, different mechanism.
- [ ] (needs Docker) **`devc init` output still works standalone.** Scaffold a
      project, bring it up with a plain `devcontainer up` (no `devc` on
      `PATH`) — `agents`/`git-container-config` still provision correctly,
      since they are declared in the scaffolded config itself, not injected.
- [ ] (needs Docker) **The bashrc-additions reach extension.** A genuinely
      project-owned `.devcontainer/devcontainer.json` (devc never wrote it),
      no `devc.json` overlay. `devc up` → the container's interactive shell
      carries the custom `PS1` and title behavior, confirming it now reaches
      project mode as intended.
- [ ] (needs Docker) **Rebuild churn**, same shape as the previous plan's
      open question: confirm this is a one-time image-layer change per
      project, not a recurring cost.

## Open questions to measure, not assume

1. **Does `claudeDir`'s empty default really resolve to `/home/vscode/.claude`
   for `mcr.microsoft.com/devcontainers/base:noble` + the `vscode` remote
   user?** Assumed equal to devc's own mount target; not yet run against a
   real build. If wrong, the volume mounts somewhere the Feature isn't
   looking, silently losing `~/.claude` persistence.
2. **Does `installsAfter` govern lifecycle-command order, or only
   image-build order?** Cited in the Why section as settled devcontainer CLI
   behavior — worth reconfirming against the pinned `@devcontainers/cli`
   version directly (source or a real container), the way the original
   Features-before-config claim was measured, before leaning on it for
   correctness rather than just image-layer tidiness.
3. **Does the `agents` Feature's Copilot install, run at Feature-install
   time, land in the same place devc's Dockerfile `RUN` step did** (so an
   existing image's `~/.local/bin/copilot` is not orphaned by the rename in
   provisioning mechanism)? Likely yes (same install script, same target),
   but not yet confirmed against a real rebuild.

## Not in this plan

- **Any change to what `agents`/`git-container-config` themselves do.** Both
  are consumed as published, at their current `0.1.0`. If either needs a
  behavior change, that is a separate plan versioning that Feature on its
  own.
- **Reaching project mode with `agents`/`git-container-config` themselves.**
  Only `devc-config` is dynamically injected. A project-mode repo still gets
  neither Claude config nor git identity restoration from devc unless it
  declares those Features itself — unchanged from today.
- **A general "run after every Feature this consumer happens to declare"
  mechanism.** Named and rejected in Concept boundaries;
  `installsAfter`'s enumerated-list design cannot do this, and no
  alternative is designed here.
- **Deleting `devc-core/default/`'s `Dockerfile` or `initialize-command.sh`
  entirely.** Both keep real jobs (image base + ripgrep; host-side identity
  extraction and mount-source seeding) independent of this plan.
