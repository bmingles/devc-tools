# Merged effective config: one `devcontainer.json` instead of `devcontainer up` flags

Status: **proposal, not started.** Written in response to the idea of
materializing a literal merge of (project config | bundled default) ⊕ `devc.json`
into a `.devcontainer.tmp/` folder in the project for the duration of a `devc`
run.

## Verdict, up front

**The merge is right.** Translating the overlay into `devcontainer up` flags is
what caps the overlay at four keys, forbids `readonly`, forbids removing or
replacing anything the base config says, and forces devc to reimplement the
CLI's own variable substitution and worktree path algorithm. Producing one
effective `devcontainer.json` and handing it to the CLI removes all of that at
once, and deletes more code than it adds.

**The `.devcontainer.tmp/`-in-the-project part is the wrong half**, and it is
not needed to get any of the benefits. The reason to want a project-level
location is that a relocated config breaks relative paths (`build.dockerfile`,
`build.context`, `dockerComposeFile`, local `./features/…`) and changes the
container's identity. Both of those are solved outright by
**`devcontainer up --override-config`**, which reads the config _content_ from
wherever you point it while keeping `configFilePath` — and therefore every
relative path and both identity labels — anchored to the project's own
`.devcontainer/devcontainer.json`. See [Research findings](#research-findings)
for the code that proves it.

So the recommended shape is: **merge into a per-project file under
`~/.cache/devc/`, deliver it with `--override-config`, write nothing into the
project, delete nothing afterwards.** That keeps the "one stable target per
project" simplicity the idea was reaching for, without putting a generated file
inside a git worktree and a Docker build context.

## Research findings

Read out of the pinned bundle (`@devcontainers/cli@0.88.0`,
`dist/spec-node/devContainersSpecCLI.js`). These are static reads of minified
source, not Docker runs — every one of them is on the Validation list below.

1. **`--config` must be named `devcontainer.json` or `.devcontainer.json`.**
   `Hv` rejects anything else outright:
   `if (e && !/\/\.?devcontainer\.json$/.test(e.path)) throw …`. Any plan that
   passes a generated file through `--config` has to name it that. The check is
   applied to `--config` only, **not** to `--override-config`.

2. **Relative paths resolve against `dirname(configFilePath)`.** `nV` is
   `path.posix.resolve(dirname(configFilePath), value)`, and it is what backs
   `build.dockerfile` / `dockerFile` (`xo`/`oV`), `dockerComposeFile` (`dg`),
   and local Feature paths. Absolute values pass through `resolve` unchanged,
   so a generated config can always dodge this by emitting absolute paths.

3. **`--override-config` decouples content from identity — this is the whole
   design.** In `M9`, the config _path_ is
   `configFile || <discovered in workspace> || <workspace>/.devcontainer/devcontainer.json`,
   and that path is what `vi` records as `configFilePath` and what the CLI
   labels the container with. The override file only supplies bytes:
   `vi(…, t /* config path */, …, s /* overrideConfigFile */)` does
   `readDocument(s ?? t)` and then `B.configFilePath = t`. So with
   `--override-config`:
   - relative `build.dockerfile` / `context` / `dockerComposeFile` / local
     Features resolve against the project's real `.devcontainer/`;
   - `.devcontainer-lock.json` is still looked up beside the project's config
     (`SQ` derives it from the config path);
   - the `devcontainer.config_file` label is still the project's own config
     path, so **no container churn and no divergence from VS Code**.

4. **Container identity is `devcontainer.local_folder` + `devcontainer.config_file`,
   and a mismatch is expensive.** `bg` looks up by both labels, then by
   `local_folder` alone; a container found by `local_folder` that carries _any_
   `config_file` label is discarded rather than reused — and, critically, it is
   **not removed even under `--remove-existing-container`** (the removal arm is
   the `else` of that test). This is the mechanism behind the existing
   `renameConflictWarning` "same workspace" branch. Consequence: **any change to
   the config path devc passes strands the old container permanently**, needing a
   manual `docker rm`. It is the single strongest argument against a config path
   that moves.

5. **`--id-label` overrides identity wholesale.** When id-labels are passed, `bg`
   returns them directly and never consults the config path. That is an escape
   hatch if identity ever needs pinning independently of the config location —
   noted, not proposed.

6. **The image tag does not depend on the config path.** `Yo` is
   `vsc-${basename(cwd)}-${sha256(cwd)}` over the _workspace_ folder. Relocating
   the config costs nothing in image cache or image naming.

7. **Lifecycle commands accept an object form and run its entries in parallel**
   (`typeof e === "string" || Array.isArray(e) ? … : Object.keys(e).map(…)`). So
   a merge _could_ combine a project's `initializeCommand` with one of devc's —
   but in parallel, not in sequence. See [Lifecycle collisions](#lifecycle-collisions).

8. **`devcontainer build` has no `--override-config`** (only `up`, `exec`,
   `run-user-commands` and `read-configuration` do). Harmless: `devc build` is
   `up --remove-existing-container`, not `devcontainer build`.

9. **Compose is still the exception.** On a `dockerComposeFile` config the CLI
   rewrites `mounts` into a generated compose file and drops `readonly` on the
   way (already documented in `devc/README.md`). The merge does not fix that;
   read-only overlay mounts are a non-compose win.

## What the merge buys

- **`readonly` mounts in the overlay.** String entries in a config's `mounts`
  array reach `docker run` verbatim; only the `--mount` _flag_ is restricted to
  `type/source/target/external`. `MOUNT_SPEC_RE` and the whole
  `RETIRED_MOUNT_FIELDS` complaint exist solely because of that flag, and both
  go away. (The `SYS_ADMIN`/seccomp finding in
  [devc-mounts-to-overlay](archived/devc-mounts-to-overlay.md) is unaffected —
  it was about _retrofitting_ read-only onto an existing mount. Declaring one at
  create time was always fine, and is what the infra mounts already do.)
- **Every `devcontainer.json` key becomes overlayable**: `runArgs`, `capAdd`,
  `securityOpt`, `containerEnv`, `forwardPorts`, `customizations`,
  `workspaceMount`, `remoteUser`, `updateRemoteUserUID`, lifecycle commands. The
  README's "run `devc init` and edit your own config" escape hatch stops being
  the answer to half the questions.
- **Replacement and removal become expressible**, which flags cannot do at all.
  Overriding the bundled `claude-seed` mount, dropping a Feature the default
  declares, or changing `remoteUser` are all currently impossible without
  forking the whole config through `~/.config/devc/templates/`.
- **devc stops substituting variables itself.** `overlayArgs`' `substituteVars`
  calls exist because `--mount`/`--remote-env` bypass the CLI's substitution.
  Inside a config file the CLI substitutes, so `${devcontainerId}` and
  `${containerEnv:…}` start working, and `computeContainerWorkspaceFolder` — a
  hand-port of the CLI's worktree algorithm, plus the `isEmptyOverlay`
  optimization that exists only to avoid its `git` subprocesses — leaves the
  `up` path entirely. It stays exported for library consumers.
- **`withBaselineFeatures`' exact-id dedupe hazard disappears.** The pinned CLI
  dedupes `--additional-features` against `features` by exact id string, which
  is why devc has to pre-check by _name_. Merging `features` ourselves means we
  decide, in one place, by the rule we want.
- **Secrets leave `argv`.** `--remote-env KEY=value` is visible in `ps` to every
  user on the host. A `0600` file is strictly better.

## Why not `.devcontainer.tmp/` in the project

Fair hearing first: it _would_ be self-describing ("here is exactly what devc
ran"), and it makes relative paths work without `--override-config`. Neither is
worth the following.

1. **It lands inside Docker build contexts.** A config with
   `"context": ".."` (common — it is how a project shares a root `Dockerfile`)
   makes the project root the build context. Dropping a new directory in there
   on every `up` invalidates the build cache and can end up `COPY`'d into the
   image. Silent, and horrible to debug.
2. **It is inside a git worktree.** `git status` dirt, `git add -A` accidents,
   `.gitignore` that every consuming repo now has to carry (including repos that
   deliberately do not know devc exists — half the overlay's reason to exist).
   Worse, the merged file contains the **user-level** overlay's contents, which
   is exactly where a machine's private paths and any `remoteEnv` secrets live.
   A generated file that mixes user-level secrets into a committable location is
   a bad shape regardless of how careful the cleanup is.
3. **Cleanup cannot be made reliable.** The container outlives the devc process,
   but `devc exec` / `attach` still need the config afterwards (`remoteEnv`
   re-derivation, and any later `up`). So either the file survives the run —
   contradicting "deleted after" — or it is rewritten on every `exec`, which
   means every `devc exec` writes into the project tree. And `SIGKILL`, a
   panicking build, or a laptop lid leaves residue behind either way.
4. **It re-creates the exact failure class `ensureDefaultConfig` was built to
   remove.** That function's doc comment enumerates three bugs caused by one
   shared mutable config directory — per-project flags fighting over shared
   content, two copies of core rewriting each other's file (read by the CLI as a
   changed config → rebuild), and `rm -rf` landing while another process's
   `devcontainer up` is reading. A fixed project path _plus a delete step_ has
   all three back, with a delete-under-a-reader race added on top. Two devc
   processes on one project (`devc attach` in one pane, `devc exec` in another)
   is an ordinary thing to do.
5. **It moves the config path, which strands containers.** Per finding 4, every
   existing devc container for every project becomes an orphan on first run
   after the upgrade, unremovable by `devc build`. One-time, but it hits
   everyone and needs an explicit migration.
6. **Tooling noise.** File watchers and dev servers restart; formatters and
   linters pick it up (`deno fmt` in this very repo); `devc init` refuses a
   non-empty `.devcontainer/` and would need to learn about a sibling; and the
   directory is inside the workspace mount, so the agent running _in_ the
   container can read the host paths of every mount the user declared at the
   user level. That last one is small but it is the wrong direction for
   [devcontainer-agent-sandbox-hardening](design/devcontainer-agent-sandbox-hardening.md).

The inspectability it buys is worth having — deliver it as
**`devc up --print-config`** (and/or `devc config --show`), which prints the
merged config to stdout without starting anything. That is better than a file
on disk anyway: it works before the first `up`, and it cannot be stale.

## Design

### Where the merged config lives

```text
~/.cache/devc/projects/<basename>-<sha256(localFolder)[0..8]>/devcontainer.json
```

One stable directory per project, mirroring `containerNameForLocalFolder`'s
existing naming convention so the two are recognizably about the same thing.
Written on every `up`/`exec` via write-to-temp + `rename` (atomic within the
filesystem, same trick `ensureDefaultConfig` already uses), mode `0600`.
Never deleted during a run; a `devc down` may prune it, and a directory whose
`localFolder` no longer exists is garbage-collectible later.

The path is **stable**, deliberately: content changes freely, the path does not,
so container identity never churns (finding 4).

The shared, content-addressed `~/.cache/devc/default-<key>/` tree stays exactly
as it is — it is still where the bundled `Dockerfile` and `initialize-command.sh`
are materialized, and it is still the input the merge starts from in zero-config
mode. Only the _merged_ artifact is per-project.

### How it is delivered

| Mode                                                                       | Base config                    | Flag                         | `configFilePath` the CLI records                             |
| -------------------------------------------------------------------------- | ------------------------------ | ---------------------------- | ------------------------------------------------------------ |
| Project (`.devcontainer/devcontainer.json` or `.devcontainer.json` exists) | the project's own              | `--override-config <merged>` | the project's own config — **unchanged from today**          |
| Zero-config                                                                | bundled default ⊕ `templates/` | `--override-config <merged>` | `<project>/.devcontainer/devcontainer.json` (does not exist) |

In project mode this is a pure no-op for identity and for relative-path
resolution: same labels, same lock file, same `.devcontainer/`-relative
`Dockerfile`. Nothing rebuilds, and VS Code still matches the same container.

In zero-config mode the recorded path is a file that does not exist, which is
fine for the CLI (finding 3) but means the merged config must carry **absolute**
`build.dockerfile` and `build.context` pointing into the shared default cache
dir. devc generates the file, so that is one rewrite in one place — the same
kind of rewrite `materializeDefaultConfig` already does for `initializeCommand`.

Zero-config identity does change once (from `~/.cache/devc/default-<key>/devcontainer.json`
to `<project>/.devcontainer/devcontainer.json`) — see [Migration](#migration).

> Alternative considered: `--config <merged>` in zero-config mode, keeping
> today's cache-dir path. Rejected because the merged content depends on the
> overlay, so the path would have to be keyed on the overlay too, and then
> _every overlay edit_ strands a container. Stability of the path is the whole
> point.

### Merge model

Three layers, lowest to highest: **base config → user `devc.json` → project
`devc.json`**. The existing user-under-project rules are preserved; the base
config simply becomes a third layer underneath, instead of something the CLI
merges flags into.

Per value kind:

- **Plain objects** (`features`, `remoteEnv`, `containerEnv`, `build.args`,
  `customizations` and its nested objects) merge **recursively, per key**, higher
  layer wins. One exception kept from today: a **Feature's options object is
  replaced whole**, not deep-merged (`overlay.ts` already argues why, and the
  argument is unchanged).
- **Arrays** (`mounts`, `forwardPorts`, `runArgs`, `capAdd`, `securityOpt`,
  `customizations.vscode.extensions`) **append**, base first. `mounts` then
  **dedupes by parsed `target=`, last layer winning** — that one rule is what
  turns "append" into "override the bundled `claude-seed` mount", and it also
  replaces today's `Duplicate mount point` foot-gun with defined behavior.
  Extensions dedupe by exact string.
- **Scalars** (`name`, `image`, `remoteUser`, `workspaceFolder`,
  `updateRemoteUserUID`, `init`, `privileged`) — higher layer replaces.
- **`null` deletes the key** (RFC 7386 semantics). This is the removal
  primitive: `"initializeCommand": null` in a project overlay drops the base
  config's. A later layer may re-add.
- **Whole-value replace for a mergeable key** is opt-in via a top-level
  `"$replace": ["mounts", "customizations"]` in that overlay file — explicit and
  greppable, rather than inventing per-key sigil syntax (`"mounts!"`). Only
  needed for the "throw away everything below me" case; `null` covers deletion
  and target-dedupe covers most replacement.

`build` vs `image` vs `dockerComposeFile` are mutually exclusive in the spec: if
an overlay layer sets one, the others from lower layers are dropped rather than
merged. Worth a warning when it happens — an overlay silently replacing a
project's `build` is a surprising amount of power for a machine-local file.

### Lifecycle collisions

`postCreateCommand` and friends are single-valued per config. A base and an
overlay both setting one is a real conflict, and the object form (finding 7)
runs entries **in parallel**, which is not what "and also run mine" means.
Proposal: **the higher layer replaces, with a `logWarning` naming the key**, and
the warning points at `devc-post-create.sh` (the project post-create hook
Feature), which is the mechanism that already composes correctly. Do not
auto-combine into the object form.

### Overlay schema after the change

`devc.json` becomes "**any `devcontainer.json` key**, plus devc-only
`baselineFeatures`". Concretely:

- `mounts`, `remoteEnv` keep working unchanged, now with the full mount
  vocabulary (`readonly`, `consistency`, any field order).
- `additionalFeatures` stays accepted as a **deprecated alias for `features`**,
  merged identically. No existing overlay breaks. Docs lead with `features`.
- `baselineFeatures` is unchanged, including its veto semantics — it is the one
  key that is not a `devcontainer.json` key and never reaches the merged file.
- The unknown-key warning changes meaning rather than disappearing: warn on keys
  that are neither a known `devcontainer.json` key nor `baselineFeatures`, so
  `"mount"` is still caught. The known-key list is enumerable from the spec and
  belongs next to `OVERLAY_KEYS`.
- Mount validation relaxes from `MOUNT_SPEC_RE` to a much looser shape check
  (non-empty string, has `type=` and `target=`) whose only job is a better error
  than Docker's. Object-form mounts (`{"type": "bind", …}`) become legal too,
  since the config schema allows them.

### Container identity and "your container predates this config"

Today, a zero-config user gets a fresh container whenever devc's bundled default
changes, because the cache path is content-keyed — an accident that happens to
be useful. A stable path removes it, and project-mode users never had it at all
(editing `devcontainer.json` has always required `devc build`).

Rather than silently losing it or silently rebuilding, make it explicit:
**stamp the merged config's hash on the container at create time and compare on
every start**, printing one notice when they differ — _"this container was
created from an older config — run `devc build` to apply the change."_ That
covers the project-mode gap too, which is a long-standing papercut, and it is
strictly better than today's zero-config behavior of rebuilding without asking.

Two ways to stamp it, both needing a decision (open question 5):

- `runArgs: ["--label", "devc.config_hash=<hash>"]` in the merged config, read
  back with `docker inspect`. Self-contained and survives anything, at the cost
  of putting devc's fingerprint into the generated config — and `runArgs` is a
  key an overlay may also set, so the merge has to append rather than replace.
- A `~/.cache/devc/projects/<key>/applied-hash` file written after a successful
  `up`, compared against the container's create time to catch a container
  recreated by someone else. No config pollution; loses the answer if the cache
  is cleared, which degrades to a spurious notice rather than a wrong one.

**Not** `--id-label`: identity labels participate in container lookup
(finding 4), so a hash there would strand a container on every config edit —
the exact failure this design is avoiding.

### Failure modes

The base config now has to be **parsed to be merged**, where today devc only
reads `remoteEnv` and `features` out of it forgivingly (`{}` / `[]` + a warning
on failure). That forgiveness cannot survive: merging into a config we failed to
read would build the wrong container.

Proposal: **a base config that does not parse is a hard error naming the file,
with no fallback path.** `jsonc-parser` accepts comments and trailing commas, so
a failure here means genuinely malformed JSON that `devcontainer up` would
reject seconds later anyway. Keeping the old flag path alive as a fallback would
mean maintaining two behaviors forever, which is precisely the complexity this
change is supposed to remove.

Comments in the base config are **not** preserved in the merged output — it is a
generated artifact parsed by a machine. (The project's own `.devcontainer/` is
still never touched, so no user-authored comment is ever lost.) That is the one
place this differs from every other write devc does, and it is fine because
nothing hand-edits the merged file.

## Concerns that remain in the recommended shape

- **devc now has to understand the config shape**, not just pass it through. The
  merge rules above are opinions about a spec that has more corners than the
  list covers (`waitFor`, `overrideCommand`, `shutdownAction`, `hostRequirements`,
  `otherPortsAttributes`, …). Mitigation: default any key not on the rules list
  to "higher layer replaces", which is always safe-ish and never wrong for
  scalars.
- **The overlay gains the power to break the container.** Replacing `image`,
  dropping `features`, changing `remoteUser` — all now one typo away in a file
  that used to be able to do four additive things. This is the real cost of the
  feature, and it is inherent, not incidental.
- **"No hidden abstraction" takes a real hit.** Today the config in
  `.devcontainer/` _is_ what runs (plus visible flags). Afterwards the effective
  config is generated and lives in a cache. The standalone invariant survives
  untouched (nothing is written into the project, a checkout without devc still
  works), but the "read the folder and you know what runs" property does not.
  `devc up --print-config` is the mitigation and should ship in the same change,
  not later.
- **Divergence from VS Code widens.** devc and VS Code share a container in
  project mode (same identity labels), but VS Code applies no overlay. Whichever
  tool created the container wins, and the overlay can now change far more than
  mounts and env. Worth a README paragraph; possibly worth a notice when a
  container was created by something other than devc.
- **Compose projects get less** — `readonly` is still dropped, and `mounts`
  merging interacts with the CLI's compose rewrite. Test it or document it as
  unsupported for now.
- **Feature install order.** `--additional-features` and a config's own
  `features` are merged by the CLI with its own ordering rules; merging them
  ourselves into one object changes key order, and while `installsAfter` governs
  real ordering, the round-robin fallback is order-sensitive. Needs a Docker
  check that `devc-config` still installs after `agents` /
  `git-container-config`.
- **`devcontainer-lock.json` / `--frozen-lockfile`.** With `--override-config`
  the lock file is still read from beside the project config (finding 3), which
  is right — but a project that pins Features in its lock file while an overlay
  adds unpinned ones is an interaction nobody has exercised.

## Open questions

1. **Location**: is there a use case that genuinely needs the merged config
   _in-tree_, that `devc up --print-config` does not cover? If not, the cache
   location is strictly better on every axis I can find.
2. **Merge semantics**: does "arrays append + `mounts` dedupe by target +
   `null` deletes + `$replace` opt-out" match what you meant by "merge the JSON
   smartly", or did you have full RFC 7386 (arrays replace wholesale) in mind?
   Arrays-replace is more standard and much simpler to explain; it also breaks
   the single most common overlay use (add one mount).
3. **How much power should an overlay have?** Should it be allowed to replace
   `image` / `build` / `dockerComposeFile` and lifecycle commands at all, or
   should those be rejected with "run `devc init` and edit your config"?
4. **Zero-config migration**: accept a one-time container recreate (plus a
   stranded old container per project needing `docker rm`), or invest in
   detecting and removing the old one automatically?
5. **Config-drift notice**: worth it, and is `runArgs: ["--label", …]` an
   acceptable way to stamp the hash? Alternative: keep a small
   `~/.cache/devc/projects/<key>/last-applied` file and compare against the
   container's create time.
6. **Naming**: promote `features` and deprecate `additionalFeatures`, or keep
   `additionalFeatures` as the documented name to avoid churn in existing
   overlays and docs?
7. **Read-only wizard mounts**: `devc config`'s skills mounts could go back to
   `readonly` once this lands. Same change, or a follow-up plan?
8. **Fallback**: agreed that the flag path is deleted outright rather than kept
   as a degradation path for unparseable configs?

## Checklist

- [ ] `devc-core/merge.ts` — the merge engine: layer merge, per-kind rules,
      `null` deletion, `$replace`, `mounts` target dedupe. Pure, no I/O, fully
      unit-testable.
- [ ] `devc-core/overlay.ts` — schema opens up to all `devcontainer.json` keys;
      `additionalFeatures` becomes an alias; known-key warning list; mount
      validation relaxed; `MOUNT_SPEC_RE` / `RETIRED_MOUNT_FIELDS` deleted;
      `overlayArgs` deleted; `resolveOverlayRemoteEnv` kept (still needed for
      `docker exec`).
- [ ] `devc-core/default_config.ts` — `materializeDefaultConfig` keeps producing
      the shared default tree; add absolute-path emission for
      `build.dockerfile`/`context` when the merged config is delivered by
      override. `loadDeclaredFeatureIds` folds into the merge.
- [ ] `devc-core/merged_config.ts` (or extend `default_config.ts`) —
      `ensureMergedConfig(localFolder)`: resolve base, load overlay, merge,
      atomic write to `~/.cache/devc/projects/<key>/devcontainer.json`, return
      its path plus the merged object.
- [ ] `devc-core/container.ts` — `buildUpArgs` emits `--override-config` and
      drops `--mount` / `--remote-env` / `--additional-features`;
      `startContainer` uses the merged object for `remoteEnv` re-derivation;
      the `isEmptyOverlay` / `computeContainerWorkspaceFolder` branch goes.
- [ ] `withBaselineFeatures` becomes a merge layer rather than a CLI-dedupe
      workaround.
- [ ] `devc up --print-config` (and `devc config --show`?) — print the merged
      config, start nothing.
- [ ] Config-drift notice (pending open question 5).
- [ ] Docs: `devc/README.md` overlay section (the "four keys" and "Mount specs"
      subsections are both rewritten), `.plans/design/devc-design.md`
      (Configuration precedence, No hidden abstraction, the read-only claim),
      `devc-core/README.md` (zero-config cache section).
- [ ] `.plans/PLAN.md` status entry.

## Validation

Offline (unit, no Docker):

- [ ] Merge engine: every rule above, plus base-only and overlay-only cases,
      plus `null` deletion through two layers, plus `$replace`.
- [ ] `mounts` dedupe by target across all three layers, including a target
      written with `${containerWorkspaceFolder}` in one layer and literally in
      another (they will _not_ dedupe — decide and test the chosen behavior).
- [ ] `buildUpArgs` emits `--override-config` and no `--mount`/`--remote-env`/
      `--additional-features`, in both modes.
- [ ] Zero-config merged output carries absolute `build.dockerfile` and
      `build.context` into the shared default cache dir.
- [ ] An unparseable base config fails, naming the file.
- [ ] Existing `overlay_test.ts` / `up_args_test.ts` rewritten, and the
      `additionalFeatures` alias keeps old overlays working byte-for-byte.
- [ ] Atomic write: two concurrent `ensureMergedConfig` calls leave a complete
      file.

Needs Docker (goes on `docs/manual-verification.md`):

- [ ] **Finding 3** end to end: `--override-config` in project mode reuses the
      _existing_ container (no rebuild), and `docker inspect` shows
      `devcontainer.config_file` still pointing at the project's own config.
- [ ] A project whose `build.context` is `".."` still builds under
      `--override-config`.
- [ ] A `readonly` overlay mount is actually read-only in the container
      (`docker exec -u 0` cannot write to it).
- [ ] `devc-config` still installs after `agents` and `git-container-config`
      when `features` is merged directly rather than passed as
      `--additional-features`.
- [ ] Zero-config: first run after the change creates a new container; the old
      one is stranded (confirm the manual `docker rm` message is what the user
      sees).
- [ ] A compose-based project still comes up; document what happens to
      `readonly`.
- [ ] VS Code "Reopen in Container" on a devc-started project-mode container
      still attaches to the same container.

## Non-goals

- Writing anything into a project's `.devcontainer/`. The standalone invariant
  is unchanged and unconditional.
- Preserving comments or formatting in the merged output.
- Replacing `~/.config/devc/templates/` — it stays the way to change the
  _bundled default_; the overlay is the way to change _this project_.
- Supporting `devcontainer build`'s flag surface (devc does not use it).
- Read-only mounts on compose projects (CLI limitation, out of devc's hands).

## Relevant files

| Path                                               | Role                                                                                                                                                      |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `devc-core/overlay.ts`                             | Overlay load/merge/validate; `overlayArgs`, `MOUNT_SPEC_RE`, `withBaselineFeatures`                                                                       |
| `devc-core/default_config.ts`                      | Bundled default materialization, the content-addressed cache, `substituteVars`, `loadResolvedRemoteEnv`, `loadDeclaredFeatureIds`, bridge-mount injection |
| `devc-core/container.ts`                           | `buildUpArgs`, `startContainer`, `computeContainerWorkspaceFolder`, `renameConflictWarning`                                                               |
| `devc-core/default/devcontainer.json`              | The bundled base config being merged into                                                                                                                 |
| `devc-core/wizard_apply.ts`, `devc-core/mounts.ts` | What `devc config` writes into the overlay's `mounts` fences                                                                                              |
| `devc/README.md`                                   | Overlay documentation, "Mount specs"                                                                                                                      |
| `.plans/design/devc-design.md`                     | Configuration precedence, "No hidden abstraction"                                                                                                         |
| `.plans/archived/devc-mounts-to-overlay.md`        | The read-only research this supersedes in part                                                                                                            |
