#!/bin/bash
# Scenario `both_layers` — the ordering contract: user layer first, project layer second, so a
# project's committed settings win on conflict (the same system → global → local order git uses).
#
# The user layer's fixture is written straight into
# /usr/local/share/devc-features/shell-dirs/user by this scenario's own onCreateCommand rather
# than through a real bind mount, because a bind mount is the one thing a Feature cannot declare
# — it belongs to the consumer's devcontainer.json (see README.md). What is being tested is the
# *ordering*, and a directory populated in-container behaves identically to one arriving via
# mount; only who creates it differs.
set -e

source dev-container-features-test-lib

check "the user layer's fixed path reached the block" \
  grep -qxF 'USER_SHELL_DIR=/usr/local/share/devc-features/shell-dirs/user' "$HOME/.bashrc"
check "and the project layer is still on, resolved at create time" \
  grep -qxF "PROJECT_SHELL_DIR=\"$PROJECT_PATH/.devcontainer/shell\"" "$HOME/.bashrc"

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

# Both assignments are absolute container paths by the time any shell runs — the user layer
# always was, and the project layer was resolved at create time — so neither depends on the
# variable.
check "both layers still fire with no PROJECT_PATH in the shell" \
  test "$(env -u PROJECT_PATH bash -ic 'printf %s "${ORDER:-}" > /tmp/probe' \
    > /dev/null 2>&1; cat /tmp/probe)" = ' user proj'

reportResults
