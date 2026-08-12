# devcontainer Features

This directory is a devcontainer Feature **collection**: `features/` is the
collection, and each `features/<id>/` is one Feature published as its own OCI
artifact. Adding a directory here is the whole of adding a Feature —
[`publish-feature.yml`](../.github/workflows/publish-feature.yml) derives its
publish matrix from the collection rather than naming its members, and so does
[`tests/features_test.sh`](../tests/features_test.sh), the guard it runs.

## Published Features

| Feature                              | Ref                                       | What it does                                                                                        |
| ------------------------------------ | ----------------------------------------- | --------------------------------------------------------------------------------------------------- |
| [devc-bridge](devc-bridge/README.md) | `ghcr.io/bmingles/devc-tools/devc-bridge` | Installs the devc-bridge client so container code can invoke host commands.                         |
| [node-nvmrc](node-nvmrc/README.md)   | `ghcr.io/bmingles/devc-tools/node-nvmrc`  | Installs the Node version a workspace pins in `.nvmrc`, and selects it on `cd`.                     |
| [shell-dirs](shell-dirs/README.md)   | `ghcr.io/bmingles/devc-tools/shell-dirs`  | Sources every `*.sh` in a project (and optionally a personal) directory in every interactive shell. |

The tag tracks **each Feature's own** version line: `:0` while that Feature is
pre-1.0, `:1` at its first 1.x release. It is not the repo's version — see
[Versions](#versions).

`node-nvmrc` is **published and public** — `0.1.0` pushed `0`, `0.1`, `0.1.0` and
`latest`, and an unauthenticated pull resolves, so the `:0` refs in the tables
above and in `devc/README.md` work today. `devc-bridge` is **not published yet**:
it pins `DEVC_TOOLS_RELEASE='v0.1.0'`, and until that release is tagged its
publish job fails the pin guard by design. Nothing else is blocked by that — see
[Versions](#versions) for why each Feature publishes on its own.

## Layout

```
features/
  <id>/
    devcontainer-feature.json   # id must equal the directory name
    install.sh                  # runs as root at image build time
    README.md                   # what a bare `{}` gives you, plus any mount recipe
    scripts/                    # optional; whatever install.sh installs
    test/
      test.sh                   # the default `devcontainer features test` scenario
      scenarios.json            # optional; extra scenarios, one <name>.sh each
      run-features-test.sh      # wrapper for the above (see below)
      *_test.sh                 # offline harnesses over blocks of install.sh
```

Each Feature is **self-contained** — that is what `devcontainer features publish`
packages, and there is deliberately no `features/common/`. Two Features that both
append to `~/.bashrc` duplicate those lines instead of sharing them; a shared
directory would either be missing from both artifacts or duplicated into both,
and the second is at least honest about it.

A Feature declares **no host bind mounts**. It cannot declare a read-only one
(the published Feature schema's `Mount` has no `readonly`), and it cannot create
a bind source (Features cannot declare `initializeCommand`). Anything
host-coupled belongs to the consumer's `devcontainer.json`, so each Feature's
README carries the mount line to paste. See
[../.plans/design/devc-feature-split.md](../.plans/design/devc-feature-split.md)
for the reasoning, and `devc-bridge/README.md` for the shape.

## Versions

**Every Feature versions itself.** The `version` in a `devcontainer-feature.json`
is that Feature's own, unrelated to the repo's `vX.Y.Z` tag and to the other
Features. Two Features at different versions is the normal state here, not drift.
The binaries still move in lockstep on one tag — see the root
[README's Releasing section](../README.md#releasing) — but a Feature is pulled
from ghcr by a consumer's `devcontainer.json`, not installed by `install.sh`, so
nothing needs the coupling. It only ever cost: a byte-identical Feature getting a
new digest because some unrelated tool changed, and a one-line Feature fix
needing a full binary release. (Reasoning:
[.plans/archived/feature-independent-versions.md](../.plans/archived/feature-independent-versions.md).)

**Bump what you changed, in the same commit.** A push to `main` touching
`features/` publishes each Feature from its own matrix job, so:

- bump a Feature's `version` when that Feature changes — nothing else has to move;
- leave it alone and the publish is a no-op. `devcontainer features publish` skips
  a version already in the registry, prints `Version X already exists, skipping`,
  and pushes nothing. So "I forgot to bump it" shows up as "nothing published" in
  the run that changed it, not silently at the next release.

A new Feature starts at `0.1.0`.

A Feature that downloads a release asset bakes `DEVC_TOOLS_RELEASE='<tag>'` into
its `install.sh`, naming the devc-tools release it fetches from — **not its own
version**; the two are independent and only ever looked equal because the old
rule forced them to be. It is duplicated out of the manifest because the manifest
is JSON and no `jq` is guaranteed in an arbitrary base image. Only `devc-bridge`
has one today. **Do not add one to a Feature that fetches nothing** — a Feature
that downloads nothing must not be made to invent a version.

`bash tests/features_test.sh --check-release-pins` asserts every pinned release
exists, which the old tag trigger used to guarantee by accident: publishing from
`main` otherwise lets a Feature ship pinned to a release nobody has tagged yet.

## Guarding the collection

```sh
bash tests/features_test.sh                       # the whole collection, offline
bash tests/features_test.sh --feature node-nvmrc  # one Feature
bash tests/features_test.sh --check-release-pins  # + the network check above (needs gh)
```

Per Feature it checks that `id` equals the directory name (`features package`
names the artifact from it, and a mismatch surfaces as a baffling packaging
error), that `version` parses as semver (the whole tag set is derived from it),
and that `name` and `description` are non-empty (`features package` refuses the
Feature otherwise, far from the cause). It walks the collection, reports every
offender, and fails on an empty glob — a guard that finds nothing to check must
not pass.

`publish-feature.yml` runs it three times: once over the whole collection before
the matrix, once per Feature with `--feature` so one Feature's failed guard
cannot fail another Feature's publish, and once more in the `collection-index`
job below.

## The collection index package

`ghcr.io/bmingles/devc-tools` — no trailing `/<id>` — is **not** a Feature and
not an image. It is a metadata-only OCI artifact holding one
`devcontainer-collection.json` layer that lists what is in this collection.
`devcontainer features publish` pushes it on every run and there is no flag to
suppress it.

Because each Feature publishes from its own job, every one of those runs would
otherwise overwrite that document with a one-Feature view — so it would name
whichever Feature published last as the whole collection. The `collection-index`
job repairs it: it runs after the matrix, `needs: publish` so it is skipped
unless **every** Feature published cleanly, and re-publishes the whole
collection. Every Feature is already at its current version by then, so the CLI
skips them all and only the index document is rewritten.

Nothing in this repo reads it — `devc` never resolves a Feature version, and
`devcontainer features info` goes through a Feature's own OCI annotations. It is
kept honest because it is visible on the repo's Packages page.

## Running a Feature's tests

Every Feature has `test/run-features-test.sh`, and it is the same file in each
one:

```sh
bash features/<id>/test/run-features-test.sh
```

It needs **Docker** (and a network, if the Feature downloads anything), so it is
run deliberately and not from `deno task test`.

The wrapper exists because `devcontainer features test` insists on a collection
laid out as `<project>/src/<id>/` + `<project>/test/<id>/`, while `publish` wants
the flat `features/<id>/` this repo keeps. Rather than split one Feature across
two trees, the wrapper stages a throwaway copy in a tempdir: the whole Feature
directory minus its `test/`, plus the whole `test/` minus the wrapper itself, in
the place the command looks for it. Both copies are wholesale on purpose — a
per-file list drops a Feature's `scripts/` from the build, or its
`scenarios.json` from the test run, and both failures surface far from the
omission. Copy it into a new Feature unchanged — it derives the id from its own
path and has nothing per-Feature in it.

A Feature with a `test/scenarios.json` gets those scenarios run too, each from
its own `test/<name>.sh`. A scenario may name external Features by their full
`ghcr.io/...` ref, and its own `onCreateCommand` runs before **every**
`postCreateCommand` — which is the only way to have a workspace fixture in place
before a Feature's own create-time hook looks for one, since the command
generates the workspace folder itself.

Most Features also have offline harnesses under `test/` that extract a fenced
block from the real `install.sh` and run it directly. Those need no Docker and
are the ones to reach for first; each Feature's README lists its own.
