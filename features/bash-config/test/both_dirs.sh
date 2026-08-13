#!/bin/bash
# Scenario `both_dirs` — the ordering contract: user directory first, project second, so a
# project's committed settings win on conflict (the same system → global → local order git uses).
#
# The user fixture is written by the scenario's own `onCreateCommand` straight into
# `dirs/user/`, which is also the check that matters most here: that directory is root-created
# at build time under a root-owned /usr/local/share, and a lifecycle command running as the
# remote user can only write into it because install.sh chowned it. A real consumer bind-mounts
# onto the same path instead — a mount is the one thing a Feature cannot declare, and it belongs
# in the consumer's devcontainer.json (see README.md). Only who fills the directory differs.
set -e

source dev-container-features-test-lib

DIRS=/usr/local/share/devc-features/bash-config/dirs

check "the user fixture landed in the fixed directory" test -f "$DIRS/user/bashrc_10.sh"
check "which the remote user owns" bash -c \
  "[ \"\$(stat -c '%U' $DIRS/user)\" = \"\$(id -un)\" ]"
check "and the project directory is a symlink into the workspace" \
  bash -c "[ \"\$(readlink $DIRS/project)\" = '$PWD/.devcontainer/shell' ]"

probe() { # probe <var>
  rm -f /tmp/probe
  bash -ic "printf %s \"\${$1:-none}\" > /tmp/probe" > /dev/null 2>&1
  cat /tmp/probe 2> /dev/null
}

check "both directories ran, user before project" test "$(probe ORDER)" = ' user proj'
check "the project wins on conflict" test "$(probe WINNER)" = project
check "and the user directory's own settings survive with it" test "$(probe USER_ONLY)" = 1

# Neither directory is found through an environment variable — both are fixed paths, and the
# project one is a symlink resolved at create time — so neither depends on PROJECT_PATH.
check "both still fire with no PROJECT_PATH in the shell" bash -c \
  "rm -f /tmp/probe
   env -u PROJECT_PATH bash -ic 'printf %s \"\${ORDER:-none}\" > /tmp/probe' > /dev/null 2>&1
   [ \"\$(cat /tmp/probe)\" = ' user proj' ]"

reportResults
