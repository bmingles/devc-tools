#!/bin/bash
# devc create-time: install the project's pinned Node from .nvmrc via the node
# feature's nvm. Volume-dependent (touches the node_modules volume), so it runs at
# create time rather than in the image build.
set -e

cd "${PROJECT_PATH:-$PWD}"

export NVM_DIR="/usr/local/share/nvm"
# shellcheck source=/dev/null
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

if [ -f .nvmrc ]; then
  sudo chown -R vscode:vscode "$PWD/node_modules" 2>/dev/null || true
  nvm install
fi
