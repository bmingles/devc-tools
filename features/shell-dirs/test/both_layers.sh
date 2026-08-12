#!/bin/bash
# Scenario `both_layers` — the ordering contract: user layer first, project layer second, so a
# project's committed settings win on conflict (the same system → global → local order git uses).
#
# `userDir` is /tmp/myshell rather than a bind-mounted /usr/local/share/... because what is
# being tested is the *ordering*, and a bind mount is the one thing a Feature cannot declare —
# it belongs to the consumer's devcontainer.json (see README.md). Any absolute container path
# behaves identically here; only who creates it differs.
set -e

source dev-container-features-test-lib

check "the userDir option reached the block" \
  grep -qxF 'USER_SHELL_DIR="/tmp/myshell"' "$HOME/.bashrc"
check "and the project layer is still on" \
  grep -qxF 'PROJECT_SHELL_DIR="${PROJECT_PATH:+$PROJECT_PATH/.devcontainer/shell}"' \
  "$HOME/.bashrc"

probe() { # probe <shell snippet writing to /tmp/probe>
  rm -f /tmp/probe
  bash -ic "$1" > /dev/null 2>&1
  cat /tmp/probe 2> /dev/null
}

check "both layers ran, user before project" \
  test "$(probe 'printf %s "${ORDER:-}" > /tmp/probe')" = ' user proj'
check "the project layer wins on conflict" \
  test "$(probe 'printf %s "${WINNER:-}" > /tmp/probe')" = project
check "and the user layer's own settings survive" \
  test "$(probe 'printf %s "${USER_LAYER:-}" > /tmp/probe')" = 1

# The user layer is at a fixed container path, so it does not need PROJECT_PATH — that is the
# whole asymmetry between the two options.
check "the user layer alone works with no PROJECT_PATH" \
  test "$(env -u PROJECT_PATH bash -ic 'printf %s "${ORDER:-}" > /tmp/probe' \
    > /dev/null 2>&1; cat /tmp/probe)" = ' user'

reportResults
