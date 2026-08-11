#!/bin/bash
# Run this Feature's `devcontainer features test` scenario (test.sh).
#
# Why a wrapper: `devcontainer features test` insists on a *collection* layout —
# `<project>/src/<id>/` and `<project>/test/<id>/` — while this repo keeps each Feature
# self-contained under `features/<id>/`, which is also what `devcontainer features publish`
# wants. Rather than split one Feature across two trees to satisfy one command, stage a
# throwaway copy in the layout it expects.
#
# Needs Docker, and a host with the bridge installed — so this is run deliberately, not from
# `deno task test`.
set -euo pipefail

FEATURE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ID="$(basename "$FEATURE_DIR")"
CLI="${DEVCONTAINER_CLI:-devcontainer}"

# The Feature cannot create its own mount sources (no host-side hook), so a missing one is a
# Docker "bind source path does not exist" at create. Say so up front instead.
for dir in run client; do
  [ -d "$HOME/.config/devc-bridge/$dir" ] || {
    echo "error: $HOME/.config/devc-bridge/$dir does not exist." >&2
    echo "       Install and start the host bridge first — see ../README.md." >&2
    exit 1
  }
done

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/src/$ID" "$STAGE/test/$ID"
cp "$FEATURE_DIR/devcontainer-feature.json" "$FEATURE_DIR/install.sh" \
  "$STAGE/src/$ID/"
cp "$FEATURE_DIR/test/test.sh" "$STAGE/test/$ID/"

exec "$CLI" features test --project-folder "$STAGE" --features "$ID" "$@"
