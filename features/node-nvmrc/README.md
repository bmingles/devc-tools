# node-nvmrc (devcontainer Feature)

Installs the Node version your workspace pins in `.nvmrc` at container-create time,
and selects it in every interactive shell — including on `cd`.

It does **not** install Node or nvm. It drives an nvm that is already in the image;
see [What this is not](#what-this-is-not).

```jsonc
"features": {
  "ghcr.io/devcontainers/features/node:1": {},
  "ghcr.io/bmingles/devc-tools/node-nvmrc:0": {}
}
```

No mounts, no options, nothing host-side. `.nvmrc` is read from the workspace, and
everything else is written inside the container.

> The tag tracks **this Feature's** version line, not the repo's — Features
> version independently of the devc-tools release tag. It is `:0` while this
> Feature is pre-1.0; it becomes `:1` at its first 1.x release.

## Prerequisite: something has to provide nvm

The default `nvmDir` is `/usr/local/share/nvm`, which is where
[`ghcr.io/devcontainers/features/node`](https://github.com/devcontainers/features/tree/main/src/node)
puts nvm — so the two lines above are the whole setup. Any other source works too:
point `nvmDir` at it.

**If nothing provides nvm, the container still creates.** The create-time step warns
on stderr, naming the directory it searched, and exits 0:

```
node-nvmrc: /workspaces/yours/.nvmrc found, but there is no nvm at /usr/local/share/nvm.
node-nvmrc: add a Feature that provides one (ghcr.io/devcontainers/features/node),
node-nvmrc: or set this Feature's 'nvmDir' option. Nothing was installed.
```

That is deliberate: failing the create over a missing prerequisite turns a one-line
misconfiguration into a container you cannot open to fix it. The shell hook degrades
the same way — with no nvm loaded it leaves `cd` alone entirely, rather than leaving
you a `cd` that calls a nonexistent command on every directory change.

`nvm install` **failing** is a different matter and _is_ fatal. Your `.nvmrc` asked
for a version that could not be installed, and a container that quietly comes up on
the wrong Node is worse than one that fails while you are still watching the log.

## Why `installsAfter` and not `dependsOn`

`dependsOn` would install `ghcr.io/devcontainers/features/node` for you — with
_this_ Feature choosing its `version`, `pnpmVersion` and `nvmVersion`, which are
exactly the things you want to choose. So the prerequisite is documented rather than
imposed, and `installsAfter` only orders this Feature behind the node Feature when
you have asked for both.

Nothing here needs nvm to exist at build time either, so providing it some other way
works.

## What it does

At **build time** (as root) it places two things and touches nvm not at all:

- `/usr/local/share/devc-features/node-nvmrc/post-create.sh`, with the options baked
  in — the manifest's `postCreateCommand` takes no arguments, so that is how they
  cross over.
- a marker-guarded block in the remote user's `~/.bashrc`, between
  `# >>> node-nvmrc >>>` and `# <<< node-nvmrc <<<`. Guarded by the opening marker,
  so a rebuild does not double-append.

At **create time** (as the remote user, before any `postCreateCommand` your own
`devcontainer.json` declares) `post-create.sh`:

1. changes to the workspace root — `$PROJECT_PATH` if set, else the cwd the
   devcontainer CLI gave the hook;
2. exits 0 **silently** if there is no `.nvmrc`, so the Feature is safe to leave
   enabled in a repo that pins nothing;
3. loads nvm, or warns and exits 0 as above;
4. repairs `./node_modules` ownership, best-effort (below);
5. runs `nvm install`, which installs the pinned version.

In every **interactive shell**, the `~/.bashrc` block loads nvm, runs
`nvm use --silent` if the starting directory has a `.nvmrc`, and wraps `cd` so that
entering any directory with a `.nvmrc` selects its version.

| Option                    | Default                | Meaning                                                                         |
| ------------------------- | ---------------------- | ------------------------------------------------------------------------------- |
| `nvmDir`                  | `/usr/local/share/nvm` | Directory holding `nvm.sh`.                                                     |
| `installOnCreate`         | `true`                 | Run `nvm install` for the workspace's `.nvmrc` at create time.                  |
| `autoUseOnCd`             | `true`                 | Append the `~/.bashrc` block. `false` leaves shells untouched.                  |
| `fixNodeModulesOwnership` | `true`                 | `chown` an existing `./node_modules` to the create-time user before installing. |

### The `node_modules` chown

`sudo -n chown -R "$(id -u):$(id -g)" ./node_modules`, guarded by `command -v sudo`
and `[ -d node_modules ]`, and best-effort (`2>/dev/null || true`).

It exists because a **named volume** mounted at
`${containerWorkspaceFolder}/node_modules` first mounts root-owned, after which
`npm ci` as the remote user cannot write into it. This Feature does not declare that
volume — devc does, for its own containers — but the repair is portable: anyone who
mounts a volume there hits the same thing.

Deliberately narrow: only `node_modules`, only when it already exists, **never** the
workspace itself. `sudo -n` rather than `sudo` so an image whose sudo wants a
password fails instantly instead of hanging create on a prompt nobody can answer.

## What this is not

**`ghcr.io/devcontainers/features/node` installs Node and nvm. This Feature installs
neither.** It reads `.nvmrc` and drives the nvm that is already there. Use both: the
node Feature to get nvm and a baseline Node, this one to make the version your repo
pins the version you actually get.

An issue that says "the node feature" could mean either, so the two are worth naming
in full.

## Relationship to devc

The logic here was copied out of [devc](../../devc/README.md)'s baseline —
`devc/default/scripts/node-setup.sh` and the nvm lines in
`scripts/bashrc-additions.sh` — and generalized: no `vscode` user, no `PROJECT_PATH`
requirement, no assumption that nvm or `sudo` exist. Those devc copies still run
unchanged; swapping devc onto this published Feature is a separate change. Until
then, enabling this Feature **in a devc container is redundant** — devc already does
both halves, and you would get the `~/.bashrc` block twice.

Two places it deliberately differs from what devc does today, both because a Feature
does not own the image it lands in:

- **The `cd` override is conditional on nvm having loaded.** devc redefines `cd`
  unconditionally.
- **The block never leaves a non-zero `$?` behind.** It is the last thing `~/.bashrc`
  runs and a consumer's prompt may report exit status; devc's own only colors it.
  For the same reason a successful `cd` into a directory without a `.nvmrc` returns
  **0** here, where devc's one-liner returns 1 — otherwise `cd somewhere && make`
  silently stops running `make`.

## Tests

No Docker needed. The `devc:nvm-use` block, extracted from the real `install.sh` so
the test cannot drift from what lands in `~/.bashrc`:

```sh
bash features/node-nvmrc/test/nvm_use_test.sh
```

It covers both halves of the degradation story: with a fake nvm on the path,
`nvm use` fires on `cd` into a directory with a `.nvmrc` and not otherwise; with no
nvm at all, `cd` is left alone and still works; and `$?` is 0 after sourcing either
way.

Needs Docker and a network. The default scenario is the bare `{}` case on a base
image with **no nvm in it**, which is the hostile one; `test/scenarios.json` adds the
two where nvm is present, with and without a `.nvmrc`:

```sh
bash features/node-nvmrc/test/run-features-test.sh
```

The `with_nvmrc` scenario writes its `.nvmrc` from the scenario's own
`onCreateCommand` (which runs before every `postCreateCommand`), because
`devcontainer features test` generates the workspace folder itself and copies the
test directory in only after the container is created — there is no committed fixture
that could be in place when the hook looks.

### The cwd of a Feature-declared `postCreateCommand`

`post-create.sh` uses `${PROJECT_PATH:-$PWD}`, and the `$PWD` half carries a
consumer who is not devc. In the devcontainers CLI, `runLifecycleHook` computes
`remoteCwd = containerProperties.remoteWorkspaceFolder || containerProperties.homeFolder`
once and passes it to every hook, Feature-declared ones included
([`spec-common/injectHeadless.ts`](https://github.com/devcontainers/cli/blob/main/src/spec-common/injectHeadless.ts)),
so the cwd is the workspace folder whenever there is one.

That is read from the CLI's source, **not measured in a running container** — no
Docker was available where this Feature was written. The `with_nvmrc` scenario above
is what measures it: if the cwd were anything else, the hook would have found no
`.nvmrc` and its first check fails.

## Publishing

`.github/workflows/publish-feature.yml` publishes this folder to
`ghcr.io/bmingles/devc-tools/node-nvmrc` on a push to `main` that touches
`features/`, in its own matrix job. `version` is this Feature's own — bump it in
the commit that changes this Feature, and nothing else in the repo has to move;
leave it and the publish is a no-op, since the CLI skips a version already in
the registry. There is no `DEVC_TOOLS_RELEASE` in `install.sh` — this Feature
downloads no release asset, so it pins none, and nothing here is coupled to a
devc-tools release at all.
