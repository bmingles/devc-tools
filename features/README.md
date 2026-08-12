# devcontainer Features

This directory is a devcontainer Feature **collection**: `features/` is the
collection, and each `features/<id>/` is one Feature published as its own OCI
artifact. Adding a directory here is the whole of adding a Feature —
[`publish-feature.yml`](../.github/workflows/publish-feature.yml) walks the
collection rather than naming its members, and so does its version guard.

## Published Features

| Feature                              | Ref                                       | What it does                                                                |
| ------------------------------------ | ----------------------------------------- | --------------------------------------------------------------------------- |
| [devc-bridge](devc-bridge/README.md) | `ghcr.io/bmingles/devc-tools/devc-bridge` | Installs the devc-bridge client so container code can invoke host commands. |

The tag tracks the repo's version line: `:0` while devc-tools is pre-1.0, `:1`
at the first 1.x release.

## Layout

```
features/
  <id>/
    devcontainer-feature.json   # id must equal the directory name
    install.sh                  # runs as root at image build time
    README.md                   # what a bare `{}` gives you, plus any mount recipe
    scripts/                    # optional; whatever install.sh installs
    test/
      test.sh                   # the `devcontainer features test` scenario
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

**One repo, one version.** Every Feature carries the repo's version in its
`devcontainer-feature.json` and moves with the repo tag, exactly as the binaries
do — a new Feature joins at whatever version the repo is on rather than starting
at `0.1.0` of its own. `publish-feature.yml`'s version guard fails the release if
any Feature disagrees with the tag, so the whole collection publishes together or
not at all. See the root [README's Releasing section](../README.md#releasing).

A Feature that downloads a release asset also bakes `FEATURE_VERSION='<version>'`
into its `install.sh`, because the manifest is JSON and no `jq` is guaranteed in
an arbitrary base image; the guard checks it wherever it appears. Only
`devc-bridge` needs one today. **Do not add one to a Feature that fetches
nothing** — an unused duplicate of the version is one more thing to bump.

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
directory minus its `test/`, plus `test/test.sh` in the place the command looks
for it. Copy it into a new Feature unchanged — it derives the id from its own
path and has nothing per-Feature in it.

Most Features also have offline harnesses under `test/` that extract a fenced
block from the real `install.sh` and run it directly. Those need no Docker and
are the ones to reach for first; each Feature's README lists its own.
