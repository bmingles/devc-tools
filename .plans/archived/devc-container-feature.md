# devc baseline as a devcontainer Feature

## Context

See `.plans/design/devc-design.md` → "Bundled default and the `devc` Feature". After
`devc-lifecycle-core`, the bundled `default/` still bakes devc's baseline into the Dockerfile
(Claude CLI install, `.bashrc` additions, tmux.conf) plus a top-level
`postCreateCommand` (`post-create.sh`: `~/.claude` volume chown, `~/.claude.json` symlink
seeding, `nvm install`). That top-level `postCreateCommand` is the problem: it is single-valued,
so a developer who needs their own would overwrite it and silently lose devc's setup.

This phase repackages the baseline as a **custom devcontainer Feature** whose own lifecycle
hooks run *in addition to* the top-level `postCreateCommand`, so devc's setup composes with a
project's own. The generated/bundled `devcontainer.json` references the Feature under
`"features"` and leaves the top-level `postCreateCommand` free.

### Decision: local materialized Feature (no registry)

The Feature ships **inside the embedded `default/` tree** as `default/features/devc/` and is
referenced by **relative path**: `"features": { "./features/devc": {} }`. Rationale: fully
self-contained (design "Self-containment") — no OCI registry, no network, no publish step. Because
`materializeDefaultConfig` copies the whole `default/` tree to the cache dir, the relative path
resolves there when `devcontainer up --config` runs. (The wizard phase will materialize the same
subtree into project `.devcontainer/` dirs; that is `devc-config-wizard`'s concern, not this one.)

### What moves where

- **Feature `install.sh` (build-time):** install the Claude CLI; append `bashrc-additions.sh`
  content to the vscode user's `.bashrc`; install `tmux.conf`. (Everything currently in the
  `default/Dockerfile` `USER vscode` block.)
- **Feature `postCreateCommand` (create-time, declared in `devcontainer-feature.json`):** the
  runtime bits from `post-create.sh` — `~/.claude` volume chown, `~/.claude.json` volume seed +
  symlink, and `nvm install` when a `.nvmrc` is present.
- **Dropped:** the `post-create.sh` project hook that ran `.devc/devc-postcreate.sh` /
  `.devcontainer/devc-postcreate.sh`. With the top-level `postCreateCommand` now free, projects
  use the standard devcontainer mechanism (design "No hidden abstraction").
- **`default/Dockerfile` slims** to `FROM mcr.microsoft.com/devcontainers/base:noble` plus only
  genuinely image-level needs (e.g. `apt-get install tmux`, if kept). Everything else is the Feature.
- **`default/devcontainer.json`:** remove top-level `"postCreateCommand"`; add the `devc` Feature
  to `"features"` (alongside the existing ghcr deno/go/node/python features); keep `remoteEnv` and
  `customizations` unchanged. **Skills are opt-in** (design Step 3): remove the blanket skills bind
  (`~/.agents/skills → /home/vscode/.claude/skills`) from `mounts` so the zero-config default
  mounts no skills — skills are added per-project via `devc config`. Keep all other infra mounts
  (claude-config volume, CLAUDE.md/settings/statusline binds, claude-json + go/node cache volumes).
  **Feature ordering:** the `devc` Feature's `install.sh` needs `nvm`/node present, so declare
  `"installsAfter": ["ghcr.io/devcontainers/features/node"]` in `devcontainer-feature.json`.
- Delete `default/post-create.sh` and `default/bashrc-additions.sh` from the top level (their
  content now lives in the Feature). `default/tmux.conf` moves under the Feature if the Feature
  installs it, else stays image-level — keep it wherever its installer lives.

### Gotchas

- **Feature lifecycle hooks are additive, top-level is not** — this is the entire point; verify by
  building a project whose *own* devcontainer.json sets a top-level `postCreateCommand` and
  confirming devc's `.claude` setup still ran.
- **`devcontainer-feature.json` `postCreateCommand`** may be a string or array; it runs as the
  feature's contribution. Volume-dependent steps (chown, symlink) must be here, not in
  `install.sh` (volumes are not mounted at build time).
- **Relative-path feature resolution** is relative to the `devcontainer.json` location. Confirm it
  resolves from the materialized cache dir (`~/.cache/devc/default/devcontainer.json` →
  `~/.cache/devc/default/features/devc`).
- `install.sh` must be idempotent and executable (`chmod +x`); appending to `.bashrc` must not
  double-append on rebuild (guard with a marker line).

## Checklist

- [x] `devc/default/features/devc/devcontainer-feature.json` — id `devc`, name/version, empty
      `options`, `installsAfter` node, and `postCreateCommand` running the runtime setup script.
- [x] `devc/default/features/devc/install.sh` — build-time: Claude CLI install, `.bashrc`
      additions (marker-guarded), tmux.conf install. Executable.
- [x] `devc/default/features/devc/post-create.sh` — create-time: `.claude` volume chown,
      `.claude.json` seed+symlink, conditional `nvm install`. Executable. (No project hook.)
- [x] `devc/default/features/devc/bashrc-additions.sh` — moved from `default/`, unchanged content.
- [x] Slim `devc/default/Dockerfile` to base image (+ image-level `tmux` if retained).
- [x] Edit `devc/default/devcontainer.json` — drop top-level `postCreateCommand`; add
      `"./features/devc": {}` to `features`; keep everything else.
- [x] Delete top-level `devc/default/post-create.sh`; relocate `tmux.conf` under the Feature (or
      keep image-level, matching wherever it is installed).
- [x] Confirm `materializeDefaultConfig` copies the `features/` subtree (it already recurses; add a
      test asserting `features/devc/install.sh` lands in the cache dir).

## Validation

- [x] `cd devc && deno task test` — including a new assertion that `materializeDefaultConfig`
      materializes `features/devc/{devcontainer-feature.json,install.sh,post-create.sh}`.
- [x] `devcontainer-feature.json` and `devcontainer.json` are valid JSON/JSONC (parse in a test).
- [ ] (user) `devc up` in a clean repo builds successfully; inside: `which claude` resolves; the
      custom prompt/title works; `ls -l ~/.claude.json` is a symlink into the volume; `~/.claude`
      is owned by `vscode`.
- [ ] (user) In a repo whose **own** `.devcontainer/devcontainer.json` sets a top-level
      `postCreateCommand` (e.g. `touch /tmp/mine`), `devc up` runs both: `/tmp/mine` exists **and**
      devc's `.claude` setup ran — proving the Feature composes rather than being clobbered.
- [x] `grep -rn "devc-postcreate\|\.devc/" devc/default/` returns nothing (project hook removed).

## Relevant Files

- `devc/default/features/devc/devcontainer-feature.json` — new: Feature manifest + postCreate hook.
- `devc/default/features/devc/install.sh` — new: build-time baseline install.
- `devc/default/features/devc/post-create.sh` — new: runtime baseline (from old post-create.sh).
- `devc/default/features/devc/bashrc-additions.sh` — moved from `devc/default/`.
- `devc/default/Dockerfile` — slimmed to base image.
- `devc/default/devcontainer.json` — features updated, top-level postCreateCommand removed.
- `devc/default/post-create.sh` — deleted (top-level).
- `devc/default/tmux.conf` — relocated under the Feature (or kept image-level).
- `devc/default_config.ts` / `devc/tests/default_config_test.ts` — feature-materialization assertion.
