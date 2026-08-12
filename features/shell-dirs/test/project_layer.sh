#!/bin/bash
# Scenario `project_layer` — the layer coming from the real workspace, with `PROJECT_PATH` set
# as `remoteEnv` the way a consumer's devcontainer.json sets it.
#
# test.sh proves the same code path against a fixture it builds itself, because the default
# scenario has no remoteEnv. This one is the honest version: nothing here writes PROJECT_PATH,
# and the *.sh files were written into the container workspace by the scenario's own
# onCreateCommand (which runs before every postCreateCommand — the only way to have a workspace
# fixture in place, since `devcontainer features test` generates the workspace folder itself).
set -e

source dev-container-features-test-lib

check "PROJECT_PATH is set by remoteEnv" test -n "$PROJECT_PATH"
check "the fixture landed in the workspace" test -f "$PROJECT_PATH/.devcontainer/shell/10-a.sh"

# The result goes through a file rather than stdout: `bash -i` without a tty warns about job
# control, and any other ~/.bashrc line is free to print.
probe() { # probe <shell snippet writing to /tmp/probe>
  rm -f /tmp/probe
  bash -ic "$1" > /dev/null 2>&1
  cat /tmp/probe 2> /dev/null
}

check "a fresh interactive shell exports the project marker" \
  test "$(probe 'printf %s "${SHELL_DIRS_MARKER:-}" > /tmp/probe')" = project
check "in glob order, *.sh only" \
  test "$(probe 'printf %s "${ORDER:-}" > /tmp/probe')" = ' p10 p20'
check "an alias defined by a layer survives into the shell" \
  test "$(probe 'alias projalias > /tmp/probe 2>&1 || true')" != ''

# Live, not baked: the block sources the directory at shell time, so a file added after the
# container was built is picked up by the next shell with no rebuild and no recreate.
echo 'export ADDED_LATER=1' > "$PROJECT_PATH/.devcontainer/shell/30-c.sh"
check "a file added after create is picked up by the next shell" \
  test "$(probe 'printf %s "${ADDED_LATER:-}" > /tmp/probe')" = 1
rm -f "$PROJECT_PATH/.devcontainer/shell/30-c.sh"
check "and deleting it stops it being read" \
  test "$(probe 'printf %s "${ADDED_LATER:-}" > /tmp/probe')" = ''

# The user layer was not asked for, so it must not exist as anything.
check "userDir is off — no second layer" grep -qxF 'USER_SHELL_DIR=""' "$HOME/.bashrc"

reportResults
