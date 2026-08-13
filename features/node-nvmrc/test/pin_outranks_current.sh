#!/bin/bash
# Scenario: **the ordering test, and the only one that can isolate it.**
#
# This Feature's containerEnv adds `<share>/pin/bin` to PATH; the upstream node Feature's adds
# `$NVM_DIR/current/bin`. Which of the two ends up in front is decided by the order the CLI
# merges Feature `ENV` lines, which `installsAfter` is supposed to settle and which nothing
# offline can measure. Every other scenario in this collection would pass even if this Feature's
# entry landed *behind* the node Feature's — because `nvm install` runs `nvm use` implicitly,
# leaving `$NVM_DIR/current` on the pinned version at create time, so both entries agree.
#
# So this one makes them disagree. `$NVM_DIR/current` is container-global mutable state: with
# NVM_SYMLINK_CURRENT=true (which the node Feature sets), *any* `nvm use` in *any* shell
# rewrites it for every other process. This scenario does exactly that — moves it to the node
# Feature's `lts` — and then asks a fresh, unrelated shell what `node -v` says. If the pin is
# ahead, it still says 20. If it is behind, it now says whatever lts is, and the create-time
# agreement was hiding it all along.
#
# That is also the day-to-day failure the plan is about: a human runs `nvm use` in one terminal,
# and every other process in the container silently changes Node version.
set -e

source dev-container-features-test-lib

PINNED=20
SHARE=/usr/local/share/devc-features/node-nvmrc
NVMD="${NVM_DIR:-/usr/local/share/nvm}"

check ".nvmrc pins the version this scenario is about" \
  bash -c "[ \"\$(tr -dc '0-9' < $PWD/.nvmrc)\" = '$PINNED' ]"
check "and the node Feature installed a different one as well" bash -c \
  "[ \"\$(ls -1 $NVMD/versions/node | wc -l)\" -ge 2 ]"

# Precondition, asserted rather than assumed: without it the rest of this file would pass
# vacuously, which is the one way an ordering test can lie.
check "nvm's global current symlink starts on the pinned version" bash -c \
  "case \"\$(readlink -f $NVMD/current)\" in */v$PINNED.*) exit 0 ;; *) exit 1 ;; esac"

OTHER="$(ls -1 "$NVMD/versions/node" | grep -v "^v$PINNED\." | head -n1)"
check "there is another installed version to move it to" test -n "$OTHER"

# The measurement of container-global state, in the form a human produces it: one subshell,
# one `nvm use`.
bash -c ". $NVMD/nvm.sh && nvm use --silent '$OTHER'" || true

check "the global symlink really moved" bash -c \
  "case \"\$(readlink -f $NVMD/current)\" in */$OTHER/*) exit 0 ;; *) exit 1 ;; esac"
check "and this Feature's own symlink did not" bash -c \
  "case \"\$(readlink -f $SHARE/pin/bin)\" in */v$PINNED.*/bin) exit 0 ;; *) exit 1 ;; esac"

# The assertion. A fresh process, inheriting PID 1's PATH, with nvm's global pointer now on the
# wrong version.
check "a fresh bash -c still reports the pinned major" bash -c \
  "[ \"\$(bash -c 'node -v' | tr -d '\r' | cut -d. -f1)\" = 'v$PINNED' ]"
check "so does sh -c" bash -c \
  "[ \"\$(sh -c 'node -v' | tr -d '\r' | cut -d. -f1)\" = 'v$PINNED' ]"
check "and node resolves through this Feature's pin, not nvm's current" bash -c \
  "[ \"\$(bash -c 'command -v node')\" = '$SHARE/pin/bin/node' ]"

# The other half of the precedence story: inside one shell, a human's `nvm use` still wins,
# because it prepends the *versioned* directory ahead of everything else in that shell's PATH.
check "a shell that runs nvm use itself still gets what it asked for" bash -c \
  "[ \"\$(bash -c \". $NVMD/nvm.sh && nvm use --silent '$OTHER' && node -v\" | tr -d '\r')\" = '$OTHER' ]"

reportResults
