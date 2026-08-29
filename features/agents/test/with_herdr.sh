#!/bin/bash
# Scenario `with_herdr` — installHerdr: true. The default scenario (test.sh) already asserts
# Herdr stays absent when the option is left at its default; this is the other half.
set -e

source dev-container-features-test-lib

check "herdr is on PATH" bash -c "command -v herdr"
check "herdr is executable by the remote user" test -x "$(command -v herdr)"
check "herdr landed in ~/.local/bin — a static binary, no node prelude involved" \
  test -x "$HOME/.local/bin/herdr"
check "and that is the herdr the remote user's PATH resolves" \
  test "$(command -v herdr)" = "$HOME/.local/bin/herdr"
check "herdr --version succeeds" bash -c "herdr --version"

# The Claude CLI still installs alongside it — installHerdr does not turn installClaudeCli off,
# the options are independent.
check "claude is still on PATH too" bash -c "command -v claude"

reportResults
