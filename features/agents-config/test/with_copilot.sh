#!/bin/bash
# Scenario `with_copilot` — installCopilotCli: true. The default scenario (test.sh) already
# asserts Copilot stays absent when the option is left at its default; this is the other half.
set -e

source dev-container-features-test-lib

check "copilot is on PATH" bash -c "command -v copilot"
check "copilot is executable by the remote user" test -x "$(command -v copilot)"
# The Claude CLI still installs alongside it — installCopilotCli does not turn installClaudeCli
# off, the two options are independent.
check "claude is still on PATH too" bash -c "command -v claude"

reportResults
