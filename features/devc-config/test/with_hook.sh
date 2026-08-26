#!/bin/bash
# Scenario `with_hook` — a real executable .devc/devc-post-create.sh in place before this
# Feature's postCreateCommand runs, written by the scenario's own onCreateCommand (which runs
# before EVERY postCreateCommand — the only way to have a fixture in place before this Feature's
# hook looks for one, since `devcontainer features test` generates the workspace folder itself
# and copies the test directory in only after the container is created).
#
# This is what measures the lifecycle-hook cwd question that
# .plans/design/devc-feature-split.md open question 1 has only ever read from the CLI source: if
# the hook did not run with cwd at the workspace folder, ${PROJECT_PATH:-$PWD} would have
# resolved somewhere else and the marker below would be absent.
set -e

source dev-container-features-test-lib

WS="$PWD"

check "the fixture landed before create" test -x "$WS/.devc/devc-post-create.sh"
check "the marker exists — the hook ran" test -f "$WS/.devc/ran"
check "the hook's recorded cwd is the workspace folder" \
  bash -c "[ \"\$(cat '$WS/.devc/ran.pwd')\" = '$WS' ]"

reportResults
