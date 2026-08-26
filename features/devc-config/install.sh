#!/bin/sh
# devc-config Feature install — place the create-time script. Nothing else.
#
# Runs as root at image *build* time. The workspace is not mounted yet, so there is nothing here
# to read from it and nothing to resolve — the fenced devc:config block in post-create.sh does
# all of that itself, at create time, from PROJECT_PATH or $PWD.
#
# There are no options: the two candidate paths are hardcoded inside the fenced block, and
# rewriting either would mean baking a value into the fence — see post-create.sh's header for
# why the fence is written the way it is.
#
# devc contributes this Feature to every container it starts, dynamically, via
# `devcontainer up --additional-features` — see devc-core/overlay.ts's DEVC_CONFIG_FEATURE and
# withBaselineFeatures. It is not also declared in devc's bundled devcontainer.json: this
# Feature's behavior (running a devc-post-create.sh a project committed for devc specifically)
# is devc-specific, so it is fine — deliberately — that a `devc init`-scaffolded project run
# with `devcontainer up` and no `devc` installed does not get it. A consumer who wants that
# without devc can still declare "devc-config": {} themselves.
#
# No network, so nothing to verify and no DEVC_TOOLS_RELEASE to pin: this Feature fetches no
# release asset (see features/README.md).
set -e

# /usr/local/share/devc-features/<id>/ is the Feature namespace. /usr/local/share/devc/ is
# devc's own baseline namespace and no Feature writes into it — not sharing the prefix is what
# keeps "did devc put this here, or a Feature?" answerable. Overridable for the test harness.
SHARE_DIR="${SHARE_DIR:-/usr/local/share/devc-features/devc-config}"

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

echo "devc-config: create-time script installed at $SHARE_DIR/post-create.sh"
