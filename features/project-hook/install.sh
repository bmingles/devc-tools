#!/bin/sh
# project-hook Feature install — place the create-time script. Nothing else.
#
# Runs as root at image *build* time. The workspace is not mounted yet, so there is nothing here
# to read from it and nothing to resolve — the fenced devc:project-hook block in post-create.sh
# does all of that itself, at create time, from PROJECT_PATH or $PWD.
#
# There are no options: the two candidate paths are hardcoded inside the fenced block, and
# rewriting either would break byte-identity with devc's own copy — see post-create.sh's header
# and the plan's Contracts section for why that identity is the point.
#
# Copied out of devc-core/default/scripts/project-hook.sh, which keeps running exactly as it
# does today, per this collection's copy-don't-move rule.
#
# No network, so nothing to verify and no DEVC_TOOLS_RELEASE to pin: this Feature fetches no
# release asset (see features/README.md).
set -e

# /usr/local/share/devc-features/<id>/ is the Feature namespace. /usr/local/share/devc/ is
# devc's own baseline namespace and no Feature writes into it — not sharing the prefix is what
# keeps "did devc put this here, or a Feature?" answerable. Overridable for the test harness.
SHARE_DIR="${SHARE_DIR:-/usr/local/share/devc-features/project-hook}"

FEATURE_DIR="$(cd "$(dirname "$0")" && pwd)"

mkdir -p "$SHARE_DIR"
# Plain cp rather than `install -o root`: this runs as root, so the copy is root-owned either
# way, and no ownership flag means the script still runs unprivileged in the test harness.
#
# No chown of anything, here or after. The create-time hook runs as the remote user but only
# ever *reads* $SHARE_DIR — nothing is written there at create time, so there is no dirs/-style
# handover to make, unlike bash-config or node-nvmrc.
cp "$FEATURE_DIR/post-create.sh" "$SHARE_DIR/post-create.sh"
chmod 0755 "$SHARE_DIR/post-create.sh"

echo "project-hook: create-time script installed at $SHARE_DIR/post-create.sh"
