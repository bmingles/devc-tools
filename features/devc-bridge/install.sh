#!/bin/sh
# devc-bridge Feature install — put the mounted devc-bridge client on PATH.
#
# The client itself arrives by read-only bind mount from the host
# (~/.config/devc-bridge/client → /usr/local/share/devc-bridge/client), declared in this
# Feature's devcontainer-feature.json. Nothing is built or downloaded here.
#
# The link is unconditional — made even when the target does not exist yet. Feature install
# scripts run at *image build time*, which is before any mount exists, so a guard would never
# fire and the link would never be made. That is fine, and in fact the same property the devc
# copy of this block relied on: the mount is a *directory*, so it is live, and a link made
# before the host installed a client starts working the moment it does, with nothing to re-run
# in the container. Healing on shell init instead would not work, since devc's ~/.bashrc
# additions sit after Ubuntu's non-interactive early return and `devc claude` runs `bash -lc`.
#
# There is deliberately no guard against an existing non-symlink at the link path: this runs at
# build time, so anything a project installs there afterwards (a postCreateCommand, devc's
# scripts/project-hook.sh) still wins.
#
# Feature install scripts run as root, so — unlike the devc post-create step this replaces —
# there is no sudo branch.
# devc:bridge-client-link (start)
set -e
BRIDGE_CLIENT="${BRIDGE_CLIENT:-/usr/local/share/devc-bridge/client/devc-bridge}"
BRIDGE_LINK="${BRIDGE_LINK:-/usr/local/bin/devc-bridge}"

mkdir -p "$(dirname "$BRIDGE_LINK")"
ln -sfn "$BRIDGE_CLIENT" "$BRIDGE_LINK"
# devc:bridge-client-link (end)
