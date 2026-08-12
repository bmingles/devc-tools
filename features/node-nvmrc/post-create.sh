#!/bin/sh
# node-nvmrc create-time step — install the Node version this workspace pins in .nvmrc.
#
# install.sh copies this file to /usr/local/share/devc-features/node-nvmrc/post-create.sh at
# image build time and bakes the Feature's options into the three assignments below; the
# manifest's `postCreateCommand` names that copy. The devcontainer CLI runs it **as the remote
# user**, and runs every Feature-declared postCreateCommand *before* the one the consumer's own
# devcontainer.json declares.
#
# Why create time rather than build time: the workspace is not mounted while the image builds,
# so there is no .nvmrc to read then — and the node_modules repair below needs whatever is
# mounted there to actually be mounted. Copied from devc/default/scripts/node-setup.sh, which
# keeps running unchanged; the differences are that nothing here assumes a `vscode` user, a
# passwordless `sudo`, or that nvm exists at all.
set -e

# --- baked by install.sh from the Feature's options -------------------------------------
# Kept in `${VAR:-default}` form here so this file is readable and runnable straight out of
# the repo. install.sh rewrites each of these three lines to the configured literal and fails
# the build if a rewrite does not take, so a rename here cannot silently un-wire an option.
NVM_DIR="${NVM_DIR:-/usr/local/share/nvm}"
INSTALL_ON_CREATE="${INSTALL_ON_CREATE:-true}"
FIX_NODE_MODULES_OWNERSHIP="${FIX_NODE_MODULES_OWNERSHIP:-true}"
# ----------------------------------------------------------------------------------------

[ "$INSTALL_ON_CREATE" = true ] || exit 0

# PROJECT_PATH is devc's remoteEnv naming the container-side workspace root. A non-devc
# consumer has no such variable, so the fallback carries the weight: the devcontainer CLI runs
# every lifecycle hook — Feature-declared ones included — with cwd set to the remote workspace
# folder, falling back to the remote user's home when there is none. Both spellings therefore
# land on the workspace; see the README for how far that is verified.
cd "${PROJECT_PATH:-$PWD}"

# No .nvmrc is success, not a skip-with-noise. This Feature is meant to be safe to leave
# enabled in a repo that pins nothing, which is the whole reason it is a one-line opt-in.
[ -f .nvmrc ] || exit 0

# A missing nvm warns rather than fails. The prerequisite is documented, but failing create
# over it turns a misconfiguration into a container that cannot be opened at all — and the
# consumer still gets a message naming the directory that was searched.
if [ ! -s "$NVM_DIR/nvm.sh" ]; then
  echo "node-nvmrc: $PWD/.nvmrc found, but there is no nvm at $NVM_DIR." >&2
  echo "node-nvmrc: add a Feature that provides one (ghcr.io/devcontainers/features/node)," >&2
  echo "node-nvmrc: or set this Feature's 'nvmDir' option. Nothing was installed." >&2
  exit 0
fi

export NVM_DIR
# shellcheck source=/dev/null
. "$NVM_DIR/nvm.sh"

# devc mounts a named volume at ${containerWorkspaceFolder}/node_modules, and a named volume
# first mounts root-owned — after which an `npm ci` as the remote user cannot write into it.
# This Feature declares no such volume (devc keeps it), but the repair is portable: anyone who
# mounts a volume there hits the same thing.
#
# Deliberately narrow. Only node_modules, only when it already exists, never the workspace
# itself. `sudo -n` because an image whose sudo wants a password would otherwise hang create
# forever on a prompt nobody can answer; `id -u`/`id -g` because whoever this hook runs as is
# the right owner, whereas devc's copy hardcodes `vscode`.
if [ "$FIX_NODE_MODULES_OWNERSHIP" = true ] && [ -d node_modules ] &&
  command -v sudo > /dev/null 2>&1; then
  sudo -n chown -R "$(id -u):$(id -g)" ./node_modules 2> /dev/null || true
fi

# Fatal on purpose, unlike everything above: the .nvmrc asked for a version that could not be
# installed, and a container that silently comes up on the wrong Node is worse than one that
# fails while the consumer is still watching the log.
nvm install
