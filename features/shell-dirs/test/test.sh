#!/bin/bash
# `devcontainer features test` default scenario — runs INSIDE a container built from this
# Feature with **no options** (`"shell-dirs": {}`), no mounts, and no devc anywhere.
#
# That is the case this file exists to prove. `.plans/design/devc-feature-split.md` requires a
# bare `{}` to install cleanly and do something useful on its own, and for this Feature that
# something is the *project* layer: the repo's own .devcontainer/shell/. The scenarios in
# scenarios.json cover the rest — a real workspace with PROJECT_PATH set, the optional user
# layer, and switching the project layer off.
#
# The one thing the default scenario cannot show is the layer firing from the workspace, since
# the command generates the workspace folder itself and this scenario declares no remoteEnv. So
# PROJECT_PATH is pointed at a fixture built here, which exercises the same code path.
set -e

source dev-container-features-test-lib

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

# The defaults, since this scenario passes no options. The project layer keeps its
# ${PROJECT_PATH:+...} guard because the default projectDir is relative.
check "projectDir defaults to .devcontainer/shell, resolved via PROJECT_PATH" \
  grep -qxF 'PROJECT_SHELL_DIR="${PROJECT_PATH:+$PROJECT_PATH/.devcontainer/shell}"' \
  "$HOME/.bashrc"
check "userDir defaults to empty — that layer is off" \
  grep -qxF 'USER_SHELL_DIR=""' "$HOME/.bashrc"
# A userDir defaulted to a devc path would bind nothing for everyone else while looking like
# devc plumbing. It must never appear unless the consumer asked for it.
check "no devc path was defaulted in" bash -c \
  "! grep -q '/usr/local/share/devc/shell' $HOME/.bashrc"

# --- the block as it actually landed ------------------------------------------------------
#
# Sourced directly rather than through `bash -i`, which without a tty writes its own job-control
# noise to stderr and would swamp what is being asserted. The interactive path is checked once,
# at the end.
BLOCK=/tmp/shell-dirs-block.sh
awk '/# devc:shell-dirs \(start\)/{f=1;next} /# devc:shell-dirs \(end\)/{f=0} f' \
  "$HOME/.bashrc" > "$BLOCK"

WS=/tmp/fixture-workspace
mkdir -p "$WS/.devcontainer/shell"
echo 'ORDER="${ORDER:-} p10"; MARKER=project' > "$WS/.devcontainer/shell/10-a.sh"
echo 'ORDER="${ORDER:-} p20"' > "$WS/.devcontainer/shell/20-b.sh"
echo 'ORDER="${ORDER:-} nope"' > "$WS/.devcontainer/shell/README.md"

check "with PROJECT_PATH set, the project layer is sourced" bash -c \
  "export PROJECT_PATH=$WS; . $BLOCK; [ \"\${MARKER:-}\" = project ]"
check "in glob order" bash -c \
  "export PROJECT_PATH=$WS; . $BLOCK; [ \"\${ORDER:-}\" = ' p10 p20' ]"
check "and only *.sh" bash -c \
  "export PROJECT_PATH=$WS; . $BLOCK; case \"\${ORDER:-}\" in *nope*) exit 1 ;; esac"

# The same caveat devc/README.md documents: without a workspace root there is nothing to
# resolve the relative path against, and guessing $PWD would source whatever repo a shell
# happens to open in.
check "with PROJECT_PATH unset, the project layer is a silent no-op" bash -c \
  "unset PROJECT_PATH; out=\$(. $BLOCK 2>&1); [ -z \"\$out\" ] && [ -z \"\${MARKER:-}\" ]"
check "sourcing it is silent either way" bash -c \
  "export PROJECT_PATH=$WS; [ -z \"\$(. $BLOCK 2>&1)\" ]"
check "and leaves \$? at 0" bash -c \
  "unset PROJECT_PATH; . $BLOCK; [ \$? -eq 0 ]"

check "an absent directory is a no-op, not an error" bash -c \
  "export PROJECT_PATH=/tmp/no-such-workspace; out=\$(. $BLOCK 2>&1); [ -z \"\$out\" ]"
check "an empty directory is a no-op too" bash -c \
  "mkdir -p /tmp/empty-ws/.devcontainer/shell
   export PROJECT_PATH=/tmp/empty-ws; out=\$(. $BLOCK 2>&1); [ -z \"\$out\" ]"

check "the block leaves no helper function or variables behind" bash -c \
  "export PROJECT_PATH=$WS; . $BLOCK
   ! declare -F _devc_source_shell_dir > /dev/null &&
   [ -z \"\${USER_SHELL_DIR:-}\${PROJECT_SHELL_DIR:-}\" ]"

# The _DEVC_SHELL_DIRS_DONE guard. It is what makes the interim safe when a devc container also
# enables this Feature and ends up with two copies of the block in one ~/.bashrc.
check "sourcing the block twice sources each file once" bash -c \
  "export PROJECT_PATH=$WS; . $BLOCK; . $BLOCK; [ \"\${ORDER:-}\" = ' p10 p20' ]"
check "the guard is not exported — a child shell re-sources" bash -c \
  "export PROJECT_PATH=$WS; . $BLOCK
   child=\$(bash -c '. $BLOCK; printf %s \"\${ORDER:-}\"')
   [ \"\$child\" = ' p10 p20' ]"

# --- one real interactive shell -----------------------------------------------------------
#
# Everything above sources the extracted block. This is the whole of ~/.bashrc, which is what a
# user actually gets. The result goes through a file rather than stdout: `bash -i` without a tty
# warns about job control on stderr, and any other ~/.bashrc line is free to print.
check "a fresh interactive shell picks the layer up" bash -c \
  "rm -f /tmp/interactive-marker
   export PROJECT_PATH=$WS
   bash -ic 'printf %s \"\${MARKER:-}\" > /tmp/interactive-marker' > /dev/null 2>&1
   [ \"\$(cat /tmp/interactive-marker)\" = project ]"

reportResults
