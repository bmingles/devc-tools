#!/bin/bash
# Scenario `with_pi` — installPiCli: true. The default scenario (test.sh) already asserts pi
# stays absent when the option is left at its default; this is the other half.
set -e

source dev-container-features-test-lib

check "pi is on PATH" bash -c "command -v pi"
check "pi is executable by the remote user" test -x "$(command -v pi)"
# The Claude CLI still installs alongside it — installPiCli does not turn installClaudeCli off,
# the two options are independent.
check "claude is still on PATH too" bash -c "command -v claude"

reportResults
