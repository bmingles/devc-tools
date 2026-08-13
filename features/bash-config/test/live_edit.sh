#!/bin/bash
# Scenario `live_edit` — a file added after the container was created is sourced by the next
# shell, with no rebuild, no recreate and no re-run of the create-time hook.
#
# This is why `dirs/project` is a **symlink** rather than a copy. A copy would have made the
# create-time hook the moment the project's scripts were frozen, and every edit afterwards would
# need a recreate to take. A symlinked directory globs live, so the workspace stays the source
# of truth while the block in ~/.bashrc stays a constant.
#
# It also carries the non-default `projectDir`, since something has to: `"shell.d"` proves the
# option reaches config.sh through the CLI's own option plumbing rather than only through the
# offline harness.
set -e

source dev-container-features-test-lib

DIRS=/usr/local/share/devc-features/bash-config/dirs

check "the option reached config.sh" \
  grep -qx 'PROJECT_DIR="shell.d"' /usr/local/share/devc-features/bash-config/config.sh
check "and the symlink was resolved against the workspace" \
  bash -c "[ \"\$(readlink $DIRS/project)\" = '$PROJECT_PATH/shell.d' ]"

probe() { # probe <var>
  rm -f /tmp/probe
  bash -ic "printf %s \"\${$1:-none}\" > /tmp/probe" > /dev/null 2>&1
  cat /tmp/probe 2> /dev/null
}

check "the file written at create time is sourced" test "$(probe AT_CREATE)" = 1

BEFORE="$(readlink "$DIRS/project")"

echo 'export ADDED_LATER=1' > "$PROJECT_PATH/shell.d/bashrc_90.sh"
check "a file added afterwards is sourced by the next shell" test "$(probe ADDED_LATER)" = 1
rm -f "$PROJECT_PATH/shell.d/bashrc_90.sh"
check "and deleting it stops it being read" test "$(probe ADDED_LATER)" = none

# Nothing was re-run and nothing was rewritten to make that work — which is the difference
# between a symlink and a copy, and between a static block and one a hook patches.
check "the symlink was not touched" bash -c "[ \"\$(readlink $DIRS/project)\" = '$BEFORE' ]"
check "and ~/.bashrc still names only the fixed path" bash -c \
  "! grep -q 'shell.d' $HOME/.bashrc"

# Emptying the directory entirely is a silent no-op, not an error — the Feature has to be safe
# to leave enabled in a project that ships nothing.
rm -f "$PROJECT_PATH/shell.d"/*.sh
check "an emptied directory is silent" bash -c \
  "[ -z \"\$(bash -lc true 2>&1)\" ]"
rmdir "$PROJECT_PATH/shell.d"
check "and so is a dangling symlink" bash -c \
  "[ -z \"\$(bash -lc true 2>&1)\" ]"

reportResults
