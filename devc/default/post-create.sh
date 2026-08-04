#!/bin/bash
# devc create-time entry point — run after the container is created (top-level
# postCreateCommand). This file only orchestrates; each step is its own script under
# scripts/. Extend it by dropping a script in scripts/ and adding a line below, or by
# editing the step it belongs to.
#
# It runs the scripts next to itself: in `devc config` mode those are the copies in the
# project's own .devcontainer/, so edits take effect on the next container create with no
# image rebuild; in the zero-config path they are the image-baked copies.
set -e
scripts="$(cd "$(dirname "$0")/scripts" && pwd)"

bash "$scripts/agents-setup.sh"   # Claude/agent config: ~/.claude volume, seed links, ~/.claude.json
bash "$scripts/node-setup.sh"     # nvm install from the project's .nvmrc
