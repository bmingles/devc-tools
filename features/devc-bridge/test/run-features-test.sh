#!/bin/bash
# Run this Feature's `devcontainer features test` scenario (test.sh).
#
# Why a wrapper: `devcontainer features test` insists on a *collection* layout —
# `<project>/src/<id>/` and `<project>/test/<id>/` — while this repo keeps each Feature
# self-contained under `features/<id>/`, which is also what `devcontainer features publish`
# wants. Rather than split one Feature across two trees to satisfy one command, stage a
# throwaway copy in the layout it expects.
#
# Needs Docker and a network (the Feature downloads its client from the release), so this is
# run deliberately, not from `deno task test`.
#
# It no longer needs the host bridge installed: the Feature declares no mounts, so there are
# no bind sources to exist. The token mount is the consumer's to declare — see ../README.md.
set -euo pipefail

FEATURE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ID="$(basename "$FEATURE_DIR")"
CLI="${DEVCONTAINER_CLI:-devcontainer}"

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/src/$ID" "$STAGE/test/$ID"
# The whole Feature directory minus its tests, rather than a list of files to keep in step
# with the Feature — a Feature that ships scripts/ alongside install.sh would otherwise stage
# an incomplete copy and fail inside the container, far from the omission. This file is
# identical in every Feature; copy it as-is.
cp -R "$FEATURE_DIR"/. "$STAGE/src/$ID/"
rm -rf "$STAGE/src/$ID/test"
cp "$FEATURE_DIR/test/test.sh" "$STAGE/test/$ID/"

exec "$CLI" features test --project-folder "$STAGE" --features "$ID" "$@"
