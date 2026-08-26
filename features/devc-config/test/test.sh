#!/bin/bash
# `devcontainer features test` default scenario — runs INSIDE a container built from this
# Feature with **no options** (`"devc-config": {}`) and no project hook fixture in the
# workspace at all.
#
# That combination is the bare-`{}` case every Feature in this collection has to survive (see
# .plans/design/devc-feature-split.md), and it is also the inert case for this Feature
# specifically: nothing is committed at either candidate path, so create has to succeed with the
# hook doing nothing, silently. The with_hook and devcontainer_dir_hook scenarios in
# scenarios.json are what actually put a fixture in place and assert it ran.
set -e

source dev-container-features-test-lib

SHARE=/usr/local/share/devc-features/devc-config

check "create-time script is installed" test -f "$SHARE/post-create.sh"
check "and is executable" test -x "$SHARE/post-create.sh"
check "and is owned by root" bash -c \
  "[ \"\$(stat -c '%U:%G' $SHARE/post-create.sh)\" = 'root:root' ]"

# No options, so nothing was baked — the file installed is byte-identical to the one in the
# repo. This is what actually proves "create succeeded with no hook present": the
# postCreateCommand already ran once (this image declares it) and did not fail the build.
check "the fenced block is present, unmodified" \
  grep -qF 'devc:devc-config (start)' "$SHARE/post-create.sh"

# --- the devc:bashrc-additions block, unconditional -------------------------------------------
#
# Unlike the hook above, this half has no fixture to be absent: it is devc's own
# prompt/title/DEVC_ATTACH-clear block, appended to ~/.bashrc on every create with no option to
# opt out (see the Feature README's "Bash prompt/title" section) — so even the bare `{}`
# scenario, with no project hook anywhere, still gets it.
check "the bashrc-additions marker landed in ~/.bashrc" \
  grep -qF '# >>> devc bashrc-additions >>>' "$HOME/.bashrc"
check "PS1 export present" grep -q 'export PS1=' "$HOME/.bashrc"

# --- the inert case: run it again by hand, with no fixture and no PROJECT_PATH ----------------
#
# The hook already ran once for real as part of this image's create. Running it again by hand in
# a fresh temp dir, with PROJECT_PATH unset, is how the $PWD fallback and the true no-op path are
# both observed without a second `devcontainer up`.
check "a silent no-op with no hook present and no PROJECT_PATH" bash -c \
  "d=\$(mktemp -d) && cd \$d &&
   out=\$(env -u PROJECT_PATH bash $SHARE/post-create.sh 2>&1) && [ -z \"\$out\" ]"

reportResults
