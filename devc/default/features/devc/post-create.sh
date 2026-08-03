#!/bin/bash
# devc Feature — create-time runtime setup.
#
# Declared as the Feature's postCreateCommand, so it runs *in addition to* any
# top-level postCreateCommand a project defines (Feature lifecycle hooks are
# additive; the top-level command is single-valued). Handles the volume-
# dependent steps that cannot run at build time because volumes are not mounted
# until the container is created.
set -e

# The isolated .claude volume mounts root-owned on first creation.
# Non-recursive: subpaths like CLAUDE.md, settings.json, and skills/ are
# host bind mounts and must not be chowned.
sudo chown vscode:vscode /home/vscode/.claude

# ~/.claude.json (auth) is persisted in a per-workspace volume, mounted as a
# directory at ~/.claude-json-vol. Seed the backing file on first run, then
# symlink it into place so Claude Code reads/writes through the volume.
sudo chown vscode:vscode /home/vscode/.claude-json-vol
if [ ! -f /home/vscode/.claude-json-vol/claude.json ]; then
  echo '{}' > /home/vscode/.claude-json-vol/claude.json
fi
if [ ! -L /home/vscode/.claude.json ]; then
  rm -f /home/vscode/.claude.json
  ln -s /home/vscode/.claude-json-vol/claude.json /home/vscode/.claude.json
fi

cd "${PROJECT_PATH:-$PWD}"

export NVM_DIR="/usr/local/share/nvm"
# shellcheck source=/dev/null
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

if [ -f .nvmrc ]; then
  sudo chown -R vscode:vscode "$PWD/node_modules" 2>/dev/null || true
  nvm install
fi
