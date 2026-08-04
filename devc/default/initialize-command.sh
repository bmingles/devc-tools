#!/bin/bash
# devc host-side init (devcontainer "initializeCommand").
#
# Runs on the HOST, before the container is created — the only lifecycle hook that
# does. Its job: ensure the ~/.claude seed bind-mount source exists, because
# `--mount type=bind` errors on a missing source rather than creating it. So a
# clone of this .devcontainer/ comes up cleanly even for someone who has never run
# `devc` (the `devc` CLI otherwise guarantees this itself via ensureClaudeSeedDir).
#
# Idempotent; also runs on subsequent starts.
set -e
mkdir -p "$HOME/.config/devc-tui/.claude"
