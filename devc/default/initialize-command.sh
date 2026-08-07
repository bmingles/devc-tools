#!/bin/bash
# devc host-side init (devcontainer "initializeCommand").
#
# Runs on the HOST, before the container is created — the only lifecycle hook that
# does. Its job: ensure the bind-mount sources exist, because `--mount type=bind`
# errors on a missing source rather than creating it. So a clone of this
# .devcontainer/ comes up cleanly even for someone who has never run `devc` (the
# `devc` CLI otherwise guarantees the ~/.claude one itself via ensureClaudeSeedDir).
#
# Idempotent; also runs on subsequent starts.
set -e
mkdir -p "$HOME/.config/devc/.claude"

# User-level shell customization: every *.sh here is sourced by every interactive container
# shell (see the USER_SHELL_DIR layer in scripts/bashrc-additions.sh). Created empty so the
# mount source exists; devc never writes into it.
mkdir -p "$HOME/.config/devc/shell"
