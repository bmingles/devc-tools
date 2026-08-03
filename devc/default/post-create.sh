#!/bin/bash
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

# if [ -f package.json ]; then
#   npm install
#   npx playwright install --with-deps
# fi

if [ -x "$PROJECT_PATH/.devc/devc-postcreate.sh" ]; then
  "$PROJECT_PATH/.devc/devc-postcreate.sh"
elif [ -x "$PROJECT_PATH/.devcontainer/devc-postcreate.sh" ]; then
  "$PROJECT_PATH/.devcontainer/devc-postcreate.sh"
fi
