#!/bin/bash
# devc create-time entry point — run after the container is created (top-level
# onCreateCommand; see devcontainer.json for why this runs in onCreate rather than
# postCreate). This file only orchestrates; each step is its own script under scripts/.
# Extend it by dropping a script in scripts/ and adding a line below, or by editing the
# step it belongs to.
#
# The project's own .devc/devc-post-create.sh, if it has one, is no longer run from here —
# it runs via the project-hook Feature's own postCreateCommand, which devc injects into
# every container it starts (see overlay.ts's withBaselineFeatures). A Feature's
# postCreateCommand runs *after* this whole file, which is why this file's steps — git
# identity and ~/.claude in particular — still precede the project's hook.
#
# It runs the scripts next to itself: in `devc config` mode those are the copies in the
# project's own .devcontainer/, so edits take effect on the next container create with no
# image rebuild; in the zero-config path they are the image-baked copies.
set -e
scripts="$(cd "$(dirname "$0")/scripts" && pwd)"

bash "$scripts/agents-setup.sh"        # Claude/agent config: ~/.claude volume, seed links, ~/.claude.json
bash "$scripts/git-setup.sh"           # git user scope: host identity, LFS filters, worktree/safe.directory
bash "$scripts/bashrc-additions.sh"    # inject this script's own content into ~/.bashrc, marker-guarded
