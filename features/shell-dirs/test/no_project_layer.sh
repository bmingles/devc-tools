#!/bin/bash
# Scenario `no_project_layer` — `"projectDir": ""` switches the layer off.
#
# An empty option must disable, not fall back to the default. That is the difference between
# `${VAR-default}` and `${VAR:-default}` in install.sh, and it is invisible until someone sets
# an option to "" and gets .devcontainer/shell anyway. The workspace fixture is present and
# would be sourced if the option had not taken.
set -e

source dev-container-features-test-lib

check "the fixture exists and would have been sourced" \
  test -f "$PROJECT_PATH/.devcontainer/shell/10-a.sh"
check "but the project layer is empty, not the default" \
  grep -qxF 'PROJECT_SHELL_DIR=""' "$HOME/.bashrc"
# Only the assignment — the block's own comments name the default while explaining it.
check "the default did not sneak back into the assignment" bash -c \
  "! grep -q '^PROJECT_SHELL_DIR=.*\.devcontainer' $HOME/.bashrc"

probe() { # probe <shell snippet writing to /tmp/probe>
  rm -f /tmp/probe
  bash -ic "$1" > /dev/null 2>&1
  cat /tmp/probe 2> /dev/null
}

check "a fresh interactive shell sources nothing" \
  test "$(probe 'printf %s "${SHELL_DIRS_MARKER:-}" > /tmp/probe')" = ''

# Both layers off is still a well-formed, silent block — it is what a consumer who wants only
# the user layer sets, before they have added the mount.
check "and the block is still silent" bash -c \
  "out=\$(bash -ic 'true' 2>&1 >/dev/null); ! echo \"\$out\" | grep -q shell-dirs"

reportResults
