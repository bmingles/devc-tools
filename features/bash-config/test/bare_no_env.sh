#!/bin/bash
# Scenario `bare_no_env` — the claim the Feature is sold on, with nothing helping it.
#
# One line in `features`, no `remoteEnv`, no mounts, no options, and a real committed
# `.devcontainer/shell/` in the workspace. A fresh interactive shell must have it.
#
# The default scenario (test.sh) proves the same mechanism but has to build its fixture at a
# path it reads back out of the symlink. This one puts the files where a real project puts them
# and never looks at dirs/project to find them — if the create-time hook had resolved the wrong
# workspace folder, nothing here would fire.
set -e

source dev-container-features-test-lib

check "the fixture is a plain committed directory" test -f "$PWD/.devcontainer/shell/bashrc_10.sh"
# Nothing declared PROJECT_PATH here, so the only thing that could be exporting it is the
# create-time hook's own env.sh. (Whether the CLI's userEnvProbe picks that up into VS Code's
# process environment on a *first* create is open question 1, and deliberately not asserted.)
check "and the only source of PROJECT_PATH is the hook's env.sh" \
  grep -qxF "export PROJECT_PATH=\"\${PROJECT_PATH:-$PWD}\"" \
    /usr/local/share/devc-features/bash-config/dirs/env.sh

# PROJECT_PATH is unset in every probe. Nothing in this scenario's devcontainer.json declares
# it, but the CLI's userEnvProbe may or may not have picked env.sh up into this script's own
# environment on a first create (open question 1) — and inheriting it would make the last check
# below assert nothing.
probe() { # probe <bash flags> <snippet writing to /tmp/probe>
  rm -f /tmp/probe
  env -u PROJECT_PATH bash "$1" "$2" > /dev/null 2>&1
  cat /tmp/probe 2> /dev/null
}

check "a fresh interactive shell has the project directory" \
  test "$(probe -ic 'printf %s "${BASH_CONFIG_MARKER:-none}" > /tmp/probe')" = project

# And it keeps working in a shell that starts somewhere else — dirs/project is an absolute
# symlink, so what is sourced does not depend on where you happen to be.
check "from any directory" bash -c \
  "cd /tmp && rm -f /tmp/probe
   bash -ic 'printf %s \"\${BASH_CONFIG_MARKER:-none}\" > /tmp/probe' > /dev/null 2>&1
   [ \"\$(cat /tmp/probe)\" = project ]"

# PROJECT_PATH comes from dirs/env.sh, written by the create-time hook — so a project script
# can use it even though this scenario's devcontainer.json never mentions it.
check "and PROJECT_PATH is exported without anyone declaring it" \
  test "$(probe -ic 'printf %s "${PROJECT_PATH:-none}" > /tmp/probe')" = "$PWD"

reportResults
