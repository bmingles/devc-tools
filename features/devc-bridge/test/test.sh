#!/bin/bash
# `devcontainer features test` scenario — runs INSIDE a container built from this Feature.
#
# What this Feature does is now entirely self-contained: download the matching Linux client
# and put it on PATH. It declares no mounts, so there is nothing here about `${localEnv:HOME}`
# substitution or `readonly` survival — the assertions this file used to carry. The token
# mount belongs to the consumer's devcontainer.json (where `readonly` is in the published
# schema), and devc's copy of that guarantee is pinned by devc/tests/default_config_test.ts.
#
# The property worth pinning here is the one that replaced `readonly` on the client: the
# binary is a root-owned file in an image layer, so a non-root container user cannot rewrite
# what the container executes, and — unlike the old shared host file — there is no copy any
# *other* container can reach at all.
#
# No host prerequisite: nothing is mounted, so this needs only Docker and a network.
set -e

source dev-container-features-test-lib

# The version the Feature bakes in — read from its own manifest so this cannot drift.
EXPECTED_VERSION="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
  /usr/local/devcontainer-features/*/devcontainer-feature.json 2>/dev/null | head -1)"

check "client is installed and executable" \
  test -x /usr/local/share/devc-bridge/client/devc-bridge

# Ownership and mode rather than an effective-write test: deterministic whichever user the
# scenario runs as, and it is the actual property — root-owned, no group/other write bit.
check "client is owned by root" bash -c \
  '[ "$(stat -c "%U:%G" /usr/local/share/devc-bridge/client/devc-bridge)" = "root:root" ]'
check "client is not group/world writable" bash -c \
  '[ "$(stat -c "%a" /usr/local/share/devc-bridge/client/devc-bridge)" = "755" ]'

check "devc-bridge is on PATH" bash -c 'command -v devc-bridge'
check "and is a symlink to the installed client" bash -c \
  '[ "$(readlink /usr/local/bin/devc-bridge)" = /usr/local/share/devc-bridge/client/devc-bridge ]'

# Proves the *right* asset was fetched for this architecture and that it actually runs:
# `version` is answered by the client itself, never forwarded to the host, so it works with
# no bridge and no token.
check "client runs and reports a version" bash -c 'devc-bridge version'
if [ -n "$EXPECTED_VERSION" ]; then
  check "client version matches the Feature" bash -c \
    "[ \"\$(devc-bridge version)\" = \"devc-bridge $EXPECTED_VERSION\" ]"
fi

# Not asserted here: `devc-bridge ping test` → `pong`, and anything about the token. Both
# need the host bridge running and the consumer's mount in place — live-host checks, not
# container ones.

reportResults
