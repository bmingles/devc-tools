#!/bin/bash
# Scenario `bare_no_env` — the claim the Feature is sold on, with nothing helping it.
#
# One line in `features`, no `remoteEnv`, no mounts, no options, and a real committed
# `.devcontainer/shell/` in the workspace. A fresh interactive shell must have it.
#
# The default scenario (test.sh) proves the same mechanism but has to build its own fixture at
# a path it reads back out of ~/.bashrc. This one puts the files where a real project puts them
# and never looks at ~/.bashrc to find them — if the create-time resolution picked the wrong
# workspace folder, nothing here would fire.
set -e

source dev-container-features-test-lib

check "the consumer set no PROJECT_PATH" test -z "${PROJECT_PATH:-}"
check "and the fixture is a plain committed directory" \
  test -f "$PWD/.devcontainer/shell/10-a.sh"

probe() { # probe <shell snippet writing to /tmp/probe>
  rm -f /tmp/probe
  bash -ic "$1" > /dev/null 2>&1
  cat /tmp/probe 2> /dev/null
}

check "a fresh interactive shell has the project layer" \
  test "$(probe 'printf %s "${SHELL_DIRS_MARKER:-}" > /tmp/probe')" = project

# And it keeps working in a shell that starts somewhere else — the resolved path is absolute,
# so the layer does not depend on where you happen to be.
check "from any directory" bash -c \
  "cd /tmp && rm -f /tmp/probe
   bash -ic 'printf %s \"\${SHELL_DIRS_MARKER:-}\" > /tmp/probe' > /dev/null 2>&1
   [ \"\$(cat /tmp/probe)\" = project ]"

reportResults
