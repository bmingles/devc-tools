#!/bin/bash
# `devcontainer features test` default scenario — runs INSIDE a container built from this
# Feature with **no options** (`"project-hook": {}`) and no project hook fixture in the
# workspace at all.
#
# That combination is the bare-`{}` case every Feature in this collection has to survive (see
# .plans/design/devc-feature-split.md), and it is also the inert case for this Feature
# specifically: nothing is committed at either candidate path, so create has to succeed with the
# hook doing nothing, silently. The with_hook and devcontainer_dir_hook scenarios in
# scenarios.json are what actually put a fixture in place and assert it ran.
set -e

source dev-container-features-test-lib

SHARE=/usr/local/share/devc-features/project-hook

check "create-time script is installed" test -f "$SHARE/post-create.sh"
check "and is executable" test -x "$SHARE/post-create.sh"
check "and is owned by root" bash -c \
  "[ \"\$(stat -c '%U:%G' $SHARE/post-create.sh)\" = 'root:root' ]"

# No options, so nothing was baked — the file installed is byte-identical to the one in the
# repo. This is what actually proves "create succeeded with no hook present": the
# postCreateCommand already ran once (this image declares it) and did not fail the build.
check "the fenced block is present, unmodified" \
  grep -qF 'devc:project-hook (start)' "$SHARE/post-create.sh"

# --- nothing was appended to any startup file ------------------------------------------------
#
# This Feature is create-time only; it has no shell-integration half at all, unlike
# node-nvmrc/bash-config/shell-dirs.
check "no project-hook block in ~/.bashrc" bash -c \
  "[ ! -e '$HOME/.bashrc' ] || ! grep -qF 'project-hook' '$HOME/.bashrc'"

# --- the inert case: run it again by hand, with no fixture and no PROJECT_PATH ----------------
#
# The hook already ran once for real as part of this image's create. Running it again by hand in
# a fresh temp dir, with PROJECT_PATH unset, is how the $PWD fallback and the true no-op path are
# both observed without a second `devcontainer up`.
check "a silent no-op with no hook present and no PROJECT_PATH" bash -c \
  "d=\$(mktemp -d) && cd \$d &&
   out=\$(env -u PROJECT_PATH bash $SHARE/post-create.sh 2>&1) && [ -z \"\$out\" ]"

reportResults
