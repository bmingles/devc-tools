#!/bin/bash
# Scenario `devcontainer_dir_hook` — the same measurement as with_hook, with the fixture at the
# second candidate path instead of the first: .devcontainer/devc-post-create.sh, with no
# .devc/ at all. Proves the second candidate is actually reachable in a real container, not just
# in the offline harness.
set -e

source dev-container-features-test-lib

WS="$PWD"

check "no .devc/ fixture exists in this scenario" test ! -e "$WS/.devc/devc-post-create.sh"
check "the .devcontainer/ fixture landed before create" \
  test -x "$WS/.devcontainer/devc-post-create.sh"
check "the marker exists — the hook ran" test -f "$WS/.devcontainer/ran"
check "the hook's recorded cwd is the workspace folder" \
  bash -c "[ \"\$(cat '$WS/.devcontainer/ran.pwd')\" = '$WS' ]"

reportResults
