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
SHARE=/usr/local/share/devc-features/node-nvmrc

check ".nvmrc is where the hook would have looked" test -f "$PWD/.nvmrc"

check "the pinned major is installed under nvm" bash -c \
  "ls -d \"\${NVM_DIR:-/usr/local/share/nvm}\"/versions/node/v$PINNED.* > /dev/null"

check "pin/bin points into that version" bash -c \
  "case \"\$(readlink -f $SHARE/pin/bin)\" in */versions/node/v$PINNED.*/bin) exit 0 ;;
     *) exit 1 ;; esac"

# The assertion that matters, and the whole reason 0.2.0 exists. In 0.1.0 the pin lived in a
# ~/.bashrc block, so only `bash -lic` could see it; these three shapes all got whatever the
# node Feature installed. Now the pin is a PATH entry in PID 1's environment.
check "a plain non-interactive bash reports the pinned major" bash -c \
  "[ \"\$(bash -c 'node -v' | tr -d '\r' | cut -d. -f1)\" = 'v$PINNED' ]"
check "so does sh — no bash, no startup file, nothing" bash -c \
  "[ \"\$(sh -c 'node -v' | tr -d '\r' | cut -d. -f1)\" = 'v$PINNED' ]"
check "and a login shell agrees" bash -c \
  "[ \"\$(bash -lc 'node -v' | tr -d '\r' | cut -d. -f1)\" = 'v$PINNED' ]"

# `env -i` keeps only what the caller passes: this is the pin reaching a process that inherited
# nothing but PATH, which is as close as a scenario gets to `docker exec`.
check "and a process given nothing but PATH" bash -c \
  "[ \"\$(env -i PATH=\"\$PATH\" node -v | tr -d '\r' | cut -d. -f1)\" = 'v$PINNED' ]"

# Directory-independence is now a property, not a limitation: the pin is one version for the
# whole container, so leaving the workspace changes nothing.
check "the version does not depend on the cwd" bash -c \
  "[ \"\$(cd /tmp && bash -c 'node -v' | tr -d '\r' | cut -d. -f1)\" = 'v$PINNED' ]"

# The mechanism, stated as a check so a future refactor cannot quietly move it back into a
# startup file.
check "no node-nvmrc block was appended to ~/.bashrc" bash -c \
  "! grep -qF '# >>> node-nvmrc >>>' '$HOME/.bashrc' 2> /dev/null"
check "and no cd override exists in an interactive shell" bash -c \
  "! bash -ic 'declare -F cd' > /dev/null 2>&1"

# nvm's own state agrees with PATH, so `nvm use default` in a terminal lands on the pin too.
check "nvm's default alias names the pinned version" bash -c \
  ". \"\${NVM_DIR:-/usr/local/share/nvm}/nvm.sh\" &&
   [ \"\$(nvm version default | cut -d. -f1)\" = 'v$PINNED' ]"

reportResults
