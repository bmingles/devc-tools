#!/bin/bash
# Scenario: the upstream node Feature provides nvm, this Feature drives it, and the workspace
# pins a version the node Feature did NOT install (`.nvmrc` says 20, the node Feature installed
# `lts`). That gap is deliberate — it is what makes "the pinned version won" observable rather
# than a coincidence.
#
# The `.nvmrc` is written by the scenario's own `onCreateCommand`, which runs before *any*
# postCreateCommand, this Feature's included. `devcontainer features test` generates the
# workspace folder itself and copies the test directory in only after the container is created,
# so there is no committed fixture that could be in place at create time — the onCreateCommand
# is the only way to have a `.nvmrc` there when the hook looks for one.
#
# This is also the scenario that answers the question the plan refused to assume: if a
# Feature-declared postCreateCommand did NOT run with cwd at the workspace folder, the hook
# would have found no `.nvmrc` and installed nothing, and the first check below fails.
set -e

source dev-container-features-test-lib

PINNED=20

check ".nvmrc is where the hook would have looked" test -f "$PWD/.nvmrc"

# Every shell assertion below goes through `bash -lic`: the block lands in ~/.bashrc, so only an
# interactive shell reads it. stderr is deliberately discarded rather than asserted empty —
# `bash -i` without a tty writes its own job-control warning there.

check "the pinned major is installed under nvm" bash -c \
  "ls -d \"\${NVM_DIR:-/usr/local/share/nvm}\"/versions/node/v$PINNED.* > /dev/null"

check "an interactive shell reports the pinned major, not the node Feature's lts" bash -c \
  "[ \"\$(bash -lic 'node -v' 2>/dev/null | tr -d '\r' | cut -d. -f1)\" = 'v$PINNED' ]"

# The `cd` override is the other half of the Feature, and the half a plain `node -v` cannot
# distinguish from the shell-start `nvm use`. Leaving the workspace and coming back has to
# re-select it — including when the shell was started somewhere with no .nvmrc at all.
check "cd out of the workspace and back re-selects the pinned version" bash -c \
  "[ \"\$(cd /tmp && bash -lic 'cd \"$PWD\" && node -v' 2>/dev/null | tr -d '\r' | cut -d. -f1)\" = 'v$PINNED' ]"

check "and a cd into a directory with no .nvmrc still succeeds" bash -c \
  "bash -lic 'cd /tmp && echo ok' 2>/dev/null | grep -q ok"

reportResults
