# project-hook (devcontainer Feature)

On every container create, runs **your own** create-time script if you have
committed one. It installs nothing and configures nothing on its own —
`"project-hook": {}` is the complete install; the whole of what you add is a
committed, executable script in your own repo.

```jsonc
"features": {
  "ghcr.io/bmingles/devc-tools/project-hook:0": {}
}
```

No mounts, no options, no host state, no network. This is the cleanest
standalone Feature in the collection: it reads the workspace and nothing else.

> The tag tracks **this Feature's own** version line, not the repo's — see
> [../README.md#versions](../README.md#versions). It is `:0` while this
> Feature is pre-1.0.

## No mount recipe

Unlike every other Feature in this collection, there is nothing to mount.
Worth saying explicitly rather than leaving you to notice the absence: your
create-time script lives in your own repo, at a path this Feature only reads —
there is no host state to bring in and no `initializeCommand` recipe to paste.

## Your side of the contract

Create one of these, `chmod +x` it, and commit it:

- `.devc/devc-post-create.sh`, or
- `.devcontainer/devc-post-create.sh`

Both locations are first-class; `.devc/` is checked first, `.devcontainer/`
second, and the first one that **exists** wins — nothing runs both. It runs
with cwd set to your project root, so it can use paths relative to the repo,
and its exit code fails container create: a script that fails create is doing
its job, not misbehaving.

If the file exists but is **not executable** (or is a dangling symlink),
create fails naming the path — it is never silently skipped. A hook that
exists either runs or fails the build; there is no path on which an existing
hook is quietly ignored in favor of the other candidate.

If neither path exists, this Feature does nothing at all, silently. That is
the point of a bare `{}`: safe to enable in a repo that has not written a hook
yet.

## Ordering

This hook runs **before** your own `devcontainer.json`'s `postCreateCommand`,
and before any Feature that declares `installsAfter: ["project-hook"]`. A
hook that needs the project's own create-time setup to have already happened —
`npm ci`, a generated config file, anything a later step depends on — is in
the wrong place if it is written expecting to run first among equals; it runs
first, full stop.

## What it does

At **build time** (as root) it places one file and touches nothing else:
`/usr/local/share/devc-features/project-hook/post-create.sh`. No options
cross into it — there is nothing to bake, since this Feature has none.

At **create time** (as the **remote user**) it looks for your hook, in order,
and runs the first one it finds:

1. `${PROJECT_PATH:-$PWD}/.devc/devc-post-create.sh`
2. `${PROJECT_PATH:-$PWD}/.devcontainer/devc-post-create.sh`

`PROJECT_PATH` is devc's own `remoteEnv`; a non-devc consumer has none, and
the `$PWD` fallback carries the weight — the devcontainer CLI runs every
lifecycle hook, Feature-declared ones included, with cwd set to the remote
workspace folder.

## No `options`, deliberately

Two reasons:

1. **The candidate paths are hardcoded inside a fenced block this Feature
   shares, byte-for-byte, with devc's own copy of the same script** (see
   [Relationship to devc](#relationship-to-devc)). Making either path an
   option means rewriting a line inside that fence, which breaks the
   byte-identity a drift-guard test depends on.
2. **A `projectDir` option — the shape `node-nvmrc` and `shell-dirs` both
   have — could not be usefully set by devc anyway.** Measured against the
   pinned `@devcontainers/cli` 0.88.0: `--additional-features` JSON is stored
   raw from argv and never passes through the CLI's substitution pass, while a
   config's own `features` block is substituted along with the rest of the
   config. So devc could not pass `${containerWorkspaceFolder}` through an
   option here even if one existed, and the option would exist for nobody.

A monorepo that wants one hook at the workspace root dispatching to
per-package logic can do that entirely inside its own
`devc-post-create.sh` — that is a shell script's job, not something this
Feature needs an option for.

## The double-run hazard — read this before enabling in a devc container

**Do not enable this Feature in a devc container yet.** During the interim,
devc's own baseline still runs its own copy of this exact script from
`post-create.sh`. A **devc** container that also enables `project-hook` runs
your `devc-post-create.sh` **twice** — once from devc's baseline, once from
this Feature.

Unlike `shell-dirs` (superseded by `bash-config`; see
[../README.md](../README.md)), there is no guard available here. The
sourcing-idempotence trick `shell-dirs`/`bash-config` use
(`_DEVC_SHELL_DIRS_DONE`) works because both copies run inside **one shell**
and can leave a variable for the other to see. These are two **separate
create-time processes**, and this Feature's copy runs **first** — so it has no
way to detect that devc's own copy has not run yet and is about to run the
same script again.

A project's `devc-post-create.sh` is arbitrary and is not guaranteed to be
idempotent (unlike `git config` assignments, or sourcing a shell file twice),
so this is not a caveat to work around — it is a reason not to enable this
Feature in a devc container until devc's own copy is retired. See
[Relationship to devc](#relationship-to-devc).

## Relationship to devc

**This Feature and `devc-core/default/scripts/project-hook.sh` are two files
with the same behavior inside one fenced block, not one file.** devc's copy
keeps running exactly as it does today — swapping devc onto this published
Feature (and retiring devc's own copy, so the double-run above stops being
possible) is a separate, later plan. Both this Feature's `post-create.sh` and
devc's `project-hook.sh` carry the same `devc:project-hook` fence, kept
byte-for-byte identical on purpose: `devc/tests/project_hook_test.sh` extracts
that fence and runs it — unmodified — against **both** copies, so the two
cannot silently drift apart. If you are editing "the project hook script,"
check which one you mean: this Feature's copy is namespaced under
`/usr/local/share/devc-features/project-hook/`, devc's own runs from
`/usr/local/share/devc/scripts/` and writes nothing under that prefix.

## What this is not

Not a way to configure **what** runs — it runs whatever you put at one of the
two fixed paths, unconditionally. Not a monorepo dispatcher — see
[No `options`, deliberately](#no-options-deliberately) above. Not a
`postStartCommand` — this is create time only, matching what devc's baseline
does today; your hook does not re-run on every container start.

## Tests

No Docker needed — the drift guard, and the most important test for this
Feature:

```sh
bash devc/tests/project_hook_test.sh features/project-hook/post-create.sh
bash devc/tests/project_hook_test.sh devc-core/default/scripts/project-hook.sh
```

Both must pass, **unmodified**, against both copies: eight cases each — a
`.devc/` hook running, a `.devcontainer/` hook running when `.devc/` is
absent, `.devc/` winning when both are present and executable (no
fall-through), a non-executable `.devc/` failing the create without falling
through to `.devcontainer/`, a dangling symlink being graded as a failure
rather than an absence, neither path present being a silent no-op, a hook
that exits non-zero failing the block, and the hook's cwd being the project
root regardless of the caller's own cwd. If the harness ever needs an edit to
pass against one copy but not the other, the copy has drifted and the fix is
the copy, not the harness.

Needs Docker and a network:

```sh
bash features/project-hook/test/run-features-test.sh
```

The default scenario is the bare `{}` case with no hook fixture anywhere:
`post-create.sh` installed at the manifest's path, executable and
root-owned, create succeeding with the inert no-hook case, nothing appended
to `~/.bashrc`, and a manual re-run with `env -u PROJECT_PATH` in a fresh
temp dir being a silent no-op. `test/scenarios.json` adds `with_hook` and
`devcontainer_dir_hook` — each writes an executable
`devc-post-create.sh` at one of the two candidate paths via the scenario's
own `onCreateCommand` (the only way to have a fixture in place before this
Feature's own `postCreateCommand` looks for it, since `devcontainer features
test` generates the workspace folder itself and copies the test directory in
only after the container is created), and asserts the marker file exists and
the hook's own recorded cwd is the workspace folder.

That last assertion is what actually measures the lifecycle-hook cwd
question `.plans/design/devc-feature-split.md` open question 1 has only ever
read from the CLI's source
([`spec-common/injectHeadless.ts`](https://github.com/devcontainers/cli/blob/main/src/spec-common/injectHeadless.ts)):
if a Feature-declared `postCreateCommand` did not run with cwd at the
workspace folder, `${PROJECT_PATH:-$PWD}` would resolve somewhere else and
the marker would be absent.

The five failure paths — non-executable, dangling symlink, a hook that exits
non-zero, no fall-through from a bad `.devc/` hook to a good `.devcontainer/`
one — are **not** container scenarios and deliberately so: `devcontainer
features test` has no way to assert that a create genuinely _failed_, since a
failing `postCreateCommand` aborts the run it would report from. Those five
cases are exactly what `project_hook_test.sh` covers offline above.

## Publishing

This Feature is **not yet** on
[`features/PUBLISH_ALLOWLIST.txt`](../PUBLISH_ALLOWLIST.txt) — see
[../README.md#the-publish-allowlist](../README.md#the-publish-allowlist) for
what that gate is and isn't, and `.plans/PLAN.md` for what is still open
before it is added.
