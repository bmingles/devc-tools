#!/bin/bash
# Scenario: nvm is present (the upstream node Feature) but the workspace pins nothing. The
# Feature has to be a no-op — the container creates, the hook exits 0, and the shell is exactly
# the shell the node Feature left behind.
#
# This is the case that decides whether the Feature is safe to leave enabled everywhere, which
# is the only reason a one-line opt-in is worth anything. If a missing `.nvmrc` were a failure,
# or even a warning, nobody could put this in a shared base config.
set -e

source dev-container-features-test-lib

check "the workspace really has no .nvmrc" test ! -f "$PWD/.nvmrc"

# Reaching this file at all means the create succeeded, so the interesting part is that the hook
# is *silently* fine on a second run — the same thing that happens on a rebuild.
check "the hook exits 0 and says nothing" bash -c \
  "out=\$(bash /usr/local/share/devc-features/node-nvmrc/post-create.sh 2>&1) && [ -z \"\$out\" ]"

check "an interactive shell still has the node Feature's Node" bash -c \
  "bash -lic 'node -v' 2>/dev/null | grep -q '^v'"

check "cd still works in a workspace that pins nothing" bash -c \
  "bash -lic 'cd /tmp && echo \$PWD' 2>/dev/null | grep -q '^/tmp'"

# The wart this Feature deliberately does not inherit from devc's copy: there, cd into a
# directory without a .nvmrc returns 1, so the second half of `cd x && y` never runs.
check "and a successful cd still returns 0, so \`cd x && y\` works" bash -c \
  "bash -lic 'cd /tmp && echo second-half-ran' 2>/dev/null | grep -q second-half-ran"

reportResults
