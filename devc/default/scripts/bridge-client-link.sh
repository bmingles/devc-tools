#!/bin/bash
# Put the mounted devc-bridge client on PATH.
#
# The client itself arrives by read-only bind mount from the host
# (~/.config/devc-bridge/client → /usr/local/share/devc/bridge-client), so nothing is built
# here and this repo is not special: every devc container gets the same treatment.
#
# The link is unconditional — made even when the target does not exist yet. The mount is a
# *directory*, so it is live: a link made before the host has installed the client starts
# working the moment it does, with nothing to re-run in the container. Healing on shell init
# instead would not work, since devc's ~/.bashrc additions sit after Ubuntu's
# non-interactive early return and `devc claude` runs `bash -lc`. A host-side placeholder
# (written by initialize-command.sh) keeps the meanwhile-dangling link self-explanatory.
#
# There is deliberately no guard against an existing non-symlink at the link path: step order
# settles every create-time case, because post-create.sh runs scripts/project-hook.sh *after*
# this, so a project installing its own client there still wins.
# devc:bridge-client-link (start)
set -e
BRIDGE_CLIENT="${BRIDGE_CLIENT:-/usr/local/share/devc/bridge-client/devc-bridge}"
BRIDGE_LINK="${BRIDGE_LINK:-/usr/local/bin/devc-bridge}"

# /usr/local/bin is root-owned and post-create runs as vscode, so the container path needs
# sudo. Reach for it only when the link's dir is not ours to write, so the block stays
# unprivileged wherever it can be.
if [ -w "$(dirname "$BRIDGE_LINK")" ]; then
  ln -sfn "$BRIDGE_CLIENT" "$BRIDGE_LINK"
else
  sudo ln -sfn "$BRIDGE_CLIENT" "$BRIDGE_LINK"
fi
# devc:bridge-client-link (end)
