# devc container baseline — fix out-of-tree Feature + drop in-container tmux

## Context

`devc-container-feature` packaged devc's baseline as a local (relative-path)
devcontainer Feature referenced as `"./features/devc"`, materialized to the
cache and loaded via `devcontainer up
--config <cache>/...`. This fails for the
**zero-config** path: `@devcontainers/cli` resolves a local Feature relative to
the config's dir but validates it against **`<workspaceRoot>/.devcontainer`**
(confirmed from `containerFeaturesConfiguration.ts`):

```ts
const featureFolderPath = path.join(
  path.dirname(configPath),
  userFeature.userFeatureId,
);
const parent = path.join(_workspaceRoot, '.devcontainer'); // workspace root == the user's repo
if (path.relative(parent, featureFolderPath).indexOf('..') !== -1) {
  /* reject */
}
```

`devc up` passes `--workspace-folder <repo>` and an out-of-tree
`--config <cache>`, so the cache-resident Feature can never sit under
`<repo>/.devcontainer` and is rejected ("Resolved path must be a child of the
.devcontainer/ folder"). Absolute paths are rejected outright. **A local Feature
is only usable when its files live inside the workspace's own `.devcontainer/`**
— i.e. the `devc config`-generated project case, which already works.

This also reverts the wrong first attempt (commit `a2e0b53`) that nested the
materialized config under `<cache>/.devcontainer/` — the CLI validates against
the _workspace_ `.devcontainer`, not the config's, so nesting the cache does
nothing.

### Fix strategy (decided with the user)

Split baseline delivery by context, and keep the Feature as the real (eventually
OCI-published) artifact:

- **Zero-config `devc up`** (no `<repo>/.devcontainer/`): the bundled default
  carries the baseline itself — **build-time in the Dockerfile**, **runtime via
  a top-level `postCreateCommand`**. No Feature reference (there is no competing
  user config, so owning the top-level hook is harmless).
- **`devc config`-generated projects**: config lives in `<repo>/.devcontainer/`,
  so `./features/devc` resolves. Keep the **Feature** there; its
  `postCreateCommand` runs the runtime setup, leaving the project's top-level
  `postCreateCommand` free (the composability the Feature exists for).
- **Repo with its own hand-written `.devcontainer/`**: unchanged; devc injects
  nothing.

### Why build-time is in the Dockerfile, not the Feature (caching)

Both a Dockerfile `RUN` and a Feature `install.sh` execute at **image-build**
time and bake into cached layers — a Feature does **not** reinstall on every
rebuild. But Dockerfile `RUN` layers cache more **reliably**: the CLI builds all
Features together, so changing the _feature set / options_ (e.g. later tweaking
skills via `devc config`) can bust the Feature layers, while the base Dockerfile
layers are insulated. So the heavy, stable install (Claude CLI, `.bashrc`)
belongs in the Dockerfile. The only thing that always re-runs on
container-create is `postCreateCommand` — so the runtime script must be small
(it is). **Do not** put the Claude install in a postCreate hook.

### OCI-readiness (future, not this phase)

The user intends to publish the Feature to an OCI registry eventually. Because
build-time lives in the Dockerfile, the Feature is **runtime-only** — and that
is its _durable_ shape, unchanged by an OCI move. Publishing later is a
reference swap (`"./features/devc"` → `"ghcr.io/<user>/devc:1"` in the project
base, point zero-config at it too, delete zero-config's top-level bridge). OCI
refs are not path-validated, so zero-config can use it then. The Feature is
authored self-contained now (it stages its own runtime script) so it is
publishable as-is with no restructuring. **No OCI work in this phase** — local
features iterate faster during active development.

### Build-time vs runtime split (authoritative)

- **Dockerfile (build-time, cached):** install the Claude CLI (→ `~/.local/bin`,
  not shadowed by the `.claude` volume); append
  `features/devc/bashrc-additions.sh` to `/home/vscode/.bashrc`
  (marker-guarded); install `features/devc/post-create.sh` to
  `/usr/local/share/devc/post-create.sh` (so the zero-config top-level hook can
  find it). **tmux dropped** — no `apt-get install tmux`.
- **Runtime script `post-create.sh` (postCreate, irreducible):**
  `chown vscode:vscode ~/.claude` (volume, root-owned on first mount); seed +
  symlink `~/.claude.json` through the `~/.claude-json-vol` volume;
  `nvm install` when the **workspace** has a `.nvmrc`. These cannot bake
  (volumes/workspace absent at build). `nvm` itself is provided by the ghcr node
  feature at build and is present by postCreate time even in zero-config.

The runtime script is invoked two ways, both pointing at
`/usr/local/share/devc/post-create.sh`: zero-config's top-level
`postCreateCommand`, and the Feature's `postCreateCommand`.

### Drop in-container tmux

The tool no longer supports tmux **inside** the container. Remove: the
`apt-get install tmux` step, `default/features/devc/tmux.conf` (+ its install),
and the in-container `$TMUX` branches in `bashrc-additions.sh`:

- iTerm tab-color block: drop the `|| [ -n "$TMUX" ]` clause (keep
  iTerm/`TERM_PROGRAM` coloring).
- Title block: remove the `if [ -n "$TMUX" ]; then tmux rename-window ...`
  branch; always use the `printf '\033]0;%s\007'` escape-sequence path (plus the
  existing DEBUG-trap / `precmd` retitle).

**Host-side** tmux behavior in `container.ts` (host-terminal tint + host window
rename on attach, kept by `devc-lifecycle-core`) stays **unchanged** — including
the `$TMUX` env forwarding onto `docker exec`. That forwarding is _not_ dead: it
makes Claude-in-the-container detect tmux and negotiate extended keys
(shift+enter) against the host terminal when the **host** is in tmux
(`container.ts:799-804`). It has nothing to do with running tmux _inside_ the
container. Only the in-container `bashrc` `$TMUX` branch (which ran
`tmux rename-window` in the container) is removed.

### File layout (`default/`)

Scripts stay **inside** `features/devc/` (single source; the Feature is
self-contained; the Dockerfile reaches in via `COPY`). Build context is `.` (the
config's dir) for both the cache and a project, and `features/devc/` exists in
both, so `COPY features/devc/<x>` resolves in both.

- `default/Dockerfile` — `FROM mcr.microsoft.com/devcontainers/base:noble`;
  `COPY
  features/devc/{bashrc-additions.sh,post-create.sh}`; `RUN` the
  build-time install (Claude CLI + marker-guarded `.bashrc` append); install
  `post-create.sh` to `/usr/local/share/devc/`. No tmux.
- `default/devcontainer.json` — **project base**: references `"./features/devc"`
  and the Dockerfile; **no** top-level `postCreateCommand`;
  `mounts`/`remoteEnv`/`customizations` unchanged.
- `default/features/devc/devcontainer-feature.json` — empty `options`,
  `installsAfter` node, `postCreateCommand` =
  `/usr/local/share/devc/post-create.sh`.
- `default/features/devc/install.sh` — **runtime-only staging** (self-contained
  for OCI): install `post-create.sh` to `/usr/local/share/devc/post-create.sh`.
  No build baseline (that is the Dockerfile's job); idempotent; executable.
- `default/features/devc/post-create.sh` — the runtime script (single source;
  unchanged logic).
- `default/features/devc/bashrc-additions.sh` — shell additions; in-container
  tmux branches removed.
- Deleted: `default/features/devc/tmux.conf`.

For projects, both the Dockerfile and the Feature `install.sh` stage
`post-create.sh` — an idempotent duplicate copy, harmless (the Feature staging
keeps it standalone-usable for OCI).

### Zero-config transform (`materializeDefaultConfig`)

Revert the `.devcontainer/` nesting from `a2e0b53`. Materialize the embedded
`default/` **flat** into `~/.cache/devc/default/`, then transform the config
before writing `devcontainer.json`:

1. Parse the canonical `devcontainer.json` (strip `//` line comments — cache
   copy is machine-only).
2. Delete the `"./features/devc"` key from `features` (keep the ghcr features).
3. Add top-level `"postCreateCommand": "/usr/local/share/devc/post-create.sh"`.
4. Write the transformed JSON as `<cacheDir>/devcontainer.json`; return that
   path.

`loadResolvedRemoteEnv` already parses this file — JSON output is fine.

### devc config first-creation (`wizard_apply`)

Unchanged copy set: first-creation copies the `Dockerfile` and the `features/`
subtree into `<repo>/.devcontainer/` (scripts ride along inside `features/`).
The generated `devcontainer.json` keeps the Feature reference and no top-level
`postCreateCommand`. Only the two mount fences are managed, as today. (Confirm
the copy already includes `features/` recursively — it does.)

### Gotchas

- **Feature `install.sh` must exist and be executable** (CLI requirement). It
  stages the runtime script only — it must **not** redo build baseline, or
  projects double-install.
- **Build context assets:** the Dockerfile references
  `features/devc/{bashrc-additions.sh,
  post-create.sh}`; both the cache
  materialization and the wizard `features/` copy place them there.
- **`.claude.json` symlink** could bake as a dangling link, but the volume
  seed + chown cannot — keep all three lines together in `post-create.sh`.
- **Zero-config still ships `features/` in the cache** (unused by the stripped
  config, but the Dockerfile `COPY features/devc/...` needs it present). That is
  fine.

## Checklist

- [x] `devc/default/Dockerfile` —
      `COPY features/devc/{bashrc-additions.sh,post-create.sh}`; build-time
      Claude CLI install + marker-guarded `.bashrc` append; install
      `post-create.sh` to `/usr/local/share/devc/`. **No tmux.**
- [x] `devc/default/features/devc/bashrc-additions.sh` — remove in-container
      `$TMUX` branches (iTerm-color guard clause + `tmux rename-window` title
      branch → escape-sequence title only).
- [x] `devc/default/features/devc/post-create.sh` — runtime script (chown
      `.claude`, seed+symlink `.claude.json`, conditional `nvm install`).
      Executable. (Logic unchanged.)
- [x] `devc/default/features/devc/install.sh` — stage `post-create.sh` to
      `/usr/local/share/devc/` only; no build baseline; idempotent; executable.
- [x] `devc/default/features/devc/devcontainer-feature.json` —
      `postCreateCommand` = `/usr/local/share/devc/post-create.sh`; empty
      options; `installsAfter` node.
- [x] `devc/default/devcontainer.json` — project base: keep `"./features/devc"`,
      **no** top-level `postCreateCommand`; unchanged
      mounts/remoteEnv/customizations.
- [x] Delete `devc/default/features/devc/tmux.conf`.
- [x] `devc/default_config.ts` — revert `.devcontainer/` nesting; materialize
      flat; add the zero-config transform (strip `./features/devc`, add
      top-level `postCreateCommand`); return `<cacheDir>/devcontainer.json`.
      Keep `loadBundledDefault`/`copyBundledFeatures` accessors pointing at the
      (unchanged) embedded asset locations.
- [x] `devc/container.ts` — **no change**: keep `$TMUX` + `TERM*` forwarding
      (host-tmux extended-key support) and host-side tint/window-rename. Only
      in-container `bashrc` tmux is removed.
- [x] Tests updated (see Validation).

## Validation

- [x] `cd devc && deno task test` — all pass, including updated
      `default_config` + `wizard_apply` tests.
- [x] `cd devc && deno task check` clean.
- [x] `materializeDefaultConfig` test: materializes **flat** to
      `<cacheDir>/devcontainer.json`; the written config has **no**
      `"./features/devc"` key and a top-level `postCreateCommand` =
      `/usr/local/share/devc/post-create.sh`; `Dockerfile` and
      `features/devc/{post-create.sh,
      bashrc-additions.sh}` present under
      the cache.
- [x] Canonical `devc/default/devcontainer.json` parse test: **has**
      `"./features/devc"` and **no** top-level `postCreateCommand`.
- [x] `wizard_apply` first-creation test: `<repo>/.devcontainer/` gets
      `devcontainer.json` (Feature referenced, no top-level postCreateCommand),
      `Dockerfile`, and `features/devc/` with its scripts.
- [x] No-tmux assertions: `grep -rni "tmux" devc/default/` returns nothing; no
      `tmux.conf` exists.
- [x] `grep -n "\.devcontainer" devc/default_config.ts` shows the cache nesting
      is gone (materialize returns `<cacheDir>/devcontainer.json`).
- [ ] (user) Zero-config `devc up` in a clean repo builds and starts:
      `which claude` resolves, custom prompt/title works, `~/.claude` owned by
      `vscode`, `~/.claude.json` is a symlink into the volume.
- [ ] (user) `devc config` then `devc up`: builds via the Feature; a top-level
      `postCreateCommand` the user adds still runs alongside devc's setup
      (composability).
- [ ] (user) Change bind mounts + `devc up --build`: Claude is **not**
      reinstalled (cached Dockerfile layer); only postCreate re-runs.

## Relevant Files

- `devc/default/Dockerfile` — build-time baseline; tmux removed; stages scripts.
- `devc/default/features/devc/bashrc-additions.sh` — tmux branches removed.
- `devc/default/features/devc/post-create.sh` — runtime script.
- `devc/default/features/devc/install.sh` — runtime-script staging only.
- `devc/default/features/devc/devcontainer-feature.json` — postCreateCommand →
  shared script.
- `devc/default/devcontainer.json` — project base (Feature ref, no top-level
  postCreateCommand).
- Deleted: `devc/default/features/devc/tmux.conf`.
- `devc/default_config.ts` — flat materialize + zero-config transform.
- `devc/tests/{default_config_test,wizard_apply_test}.ts` — updated assertions.
