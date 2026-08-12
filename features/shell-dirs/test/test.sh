#!/bin/bash
# `devcontainer features test` default scenario — runs INSIDE a container built from this
# Feature with **no options** (`"shell-dirs": {}`), no mounts, no remoteEnv, and no devc.
#
# That is the case this file exists to prove. `.plans/design/devc-feature-split.md` requires a
# bare `{}` to install cleanly and do something useful on its own, and for this Feature that
# something is the project layer: the repo's own .devcontainer/shell/, with nothing else in the
# devcontainer.json at all.
#
# It is also the scenario that **measures open question 1** — the cwd of a Feature-declared
# postCreateCommand. The hook resolves the workspace-relative projectDir against its own cwd,
# so "the assignment is now an absolute path" is a direct read of what cwd the CLI handed it.
# If the cwd were the home folder, the hook declines and the assignment stays deferred, and
# these checks fail saying so.
set -e

source dev-container-features-test-lib

SHARE=/usr/local/share/devc-features/shell-dirs

check "the ~/.bashrc block was appended" grep -qF '# >>> shell-dirs >>>' "$HOME/.bashrc"
check "exactly once" bash -c \
  "[ \"\$(grep -cF '# >>> shell-dirs >>>' $HOME/.bashrc)\" = 1 ]"
check "and is closed" grep -qF '# <<< shell-dirs <<<' "$HOME/.bashrc"

# The fence markers are a contract, not decoration: devc/tests/shell_dirs_test.sh finds the
# block by them, in devc's copy and in this Feature's, which is what keeps the two from drifting.
check "the devc:shell-dirs fence markers are preserved" bash -c \
  "grep -qF '# devc:shell-dirs (start)' $HOME/.bashrc &&
   grep -qF '# devc:shell-dirs (end)' $HOME/.bashrc"

check "~/.bashrc is still writable by the remote user" test -w "$HOME/.bashrc"

check "the create-time script is installed" test -f "$SHARE/post-create.sh"
check "and is executable" test -x "$SHARE/post-create.sh"
check "and is owned by root" bash -c \
  "[ \"\$(stat -c '%U:%G' $SHARE/post-create.sh)\" = 'root:root' ]"
check "with the default projectDir baked in" \
  grep -qx 'PROJECT_DIR=".devcontainer/shell"' "$SHARE/post-create.sh"

check "userDir defaults to empty — that layer is off" \
  grep -qxF 'USER_SHELL_DIR=""' "$HOME/.bashrc"
# A userDir defaulted to a devc path would bind nothing for everyone else while looking like
# devc plumbing. It must never appear unless the consumer asked for it.
check "no devc path was defaulted in" bash -c \
  "! grep -q '/usr/local/share/devc/shell' $HOME/.bashrc"

# --- what the create-time hook did ---------------------------------------------------------

ASSIGNED="$(grep -m1 '^PROJECT_SHELL_DIR=' "$HOME/.bashrc")"
BAKED="$(printf '%s' "$ASSIGNED" | sed 's/^PROJECT_SHELL_DIR="//; s/"$//')"

# The measurement. Both halves matter: an absolute path proves the hook ran AND that its cwd
# was a real workspace folder, and the absence of the deferred form proves it rewrote rather
# than appended.
check "the project layer was resolved to an absolute path at create time" \
  bash -c "case '$BAKED' in /*) exit 0 ;; *) exit 1 ;; esac"
check "and it is the workspace's .devcontainer/shell" bash -c \
  "case '$BAKED' in */.devcontainer/shell) exit 0 ;; *) exit 1 ;; esac"
check "the \${PROJECT_PATH:+...} deferral is gone" bash -c \
  "! grep -q 'PROJECT_SHELL_DIR=\"\${PROJECT_PATH' $HOME/.bashrc"
check "it did not resolve to the home folder" bash -c "[ '$BAKED' != '$HOME/.devcontainer/shell' ]"

# --- the block as it actually landed ------------------------------------------------------
#
# Sourced directly rather than through `bash -i`, which without a tty writes its own job-control
# noise to stderr and would swamp what is being asserted. The interactive path is checked once,
# at the end. PROJECT_PATH is unset throughout: not needing it is the point of the whole hook.
BLOCK=/tmp/shell-dirs-block.sh
awk '/# devc:shell-dirs \(start\)/{f=1;next} /# devc:shell-dirs \(end\)/{f=0} f' \
  "$HOME/.bashrc" > "$BLOCK"

mkdir -p "$BAKED"
echo 'ORDER="${ORDER:-} p10"; MARKER=project' > "$BAKED/10-a.sh"
echo 'ORDER="${ORDER:-} p20"' > "$BAKED/20-b.sh"
echo 'ORDER="${ORDER:-} nope"' > "$BAKED/README.md"

run() { env -u PROJECT_PATH bash -c ". $BLOCK; $1"; }

check "with no PROJECT_PATH at all, the project layer is sourced" \
  run '[ "${MARKER:-}" = project ]'
check "in glob order" run '[ "${ORDER:-}" = " p10 p20" ]'
check "and only *.sh" run 'case "${ORDER:-}" in *nope*) exit 1 ;; esac'
check "sourcing it is silent" bash -c \
  "[ -z \"\$(env -u PROJECT_PATH bash -c '. $BLOCK' 2>&1)\" ]"
check "and leaves \$? at 0" run '[ $? -eq 0 ]'

check "the block leaves no helper function or variables behind" run \
  '! declare -F _devc_source_shell_dir > /dev/null &&
   [ -z "${USER_SHELL_DIR:-}${PROJECT_SHELL_DIR:-}" ]'

# The _DEVC_SHELL_DIRS_DONE guard. It is what makes the interim safe when a devc container also
# enables this Feature and ends up with two copies of the block in one ~/.bashrc.
check "sourcing the block twice sources each file once" bash -c \
  "env -u PROJECT_PATH bash -c '. $BLOCK; . $BLOCK; [ \"\${ORDER:-}\" = \" p10 p20\" ]'"
check "the guard is not exported — a child shell re-sources" bash -c \
  "env -u PROJECT_PATH bash -c '. $BLOCK
     child=\$(bash -c \". $BLOCK; printf %s \\\"\\\${ORDER:-}\\\"\")
     [ \"\$child\" = \" p10 p20\" ]'"

# Live, not baked: only the *path* was resolved at create time. The directory is still read by
# every shell, so adding a file needs no rebuild.
echo 'ADDED_LATER=1' > "$BAKED/30-c.sh"
check "a file added after create is picked up" run '[ "${ADDED_LATER:-}" = 1 ]'
rm -f "$BAKED/30-c.sh"
check "and deleting it stops it being read" run '[ -z "${ADDED_LATER:-}" ]'

# Everything, not just *.sh — the README.md fixture above would otherwise keep the rmdir below
# from succeeding, and `set -e` would end the scenario there.
rm -f "$BAKED"/*
check "an empty directory is a no-op, not an error" bash -c \
  "[ -z \"\$(env -u PROJECT_PATH bash -c '. $BLOCK' 2>&1)\" ]"
rmdir "$BAKED"
check "an absent directory is a no-op too" bash -c \
  "[ -z \"\$(env -u PROJECT_PATH bash -c '. $BLOCK' 2>&1)\" ]"

# --- one real interactive shell -----------------------------------------------------------
#
# Everything above sources the extracted block. This is the whole of ~/.bashrc, which is what a
# user actually gets. The result goes through a file rather than stdout: `bash -i` without a tty
# warns about job control on stderr, and any other ~/.bashrc line is free to print.
mkdir -p "$BAKED"
echo 'export MARKER=project' > "$BAKED/10-a.sh"
check "a fresh interactive shell picks the layer up, with no PROJECT_PATH" bash -c \
  "rm -f /tmp/interactive-marker
   env -u PROJECT_PATH bash -ic 'printf %s \"\${MARKER:-}\" > /tmp/interactive-marker' \
     > /dev/null 2>&1
   [ \"\$(cat /tmp/interactive-marker)\" = project ]"

reportResults
