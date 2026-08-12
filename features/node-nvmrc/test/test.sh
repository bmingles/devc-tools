#!/bin/bash
# `devcontainer features test` default scenario — runs INSIDE a container built from this
# Feature with **no options** (`"node-nvmrc": {}`) on the command's default base image, which
# has no nvm and no Node in it at all.
#
# That combination is the point of this file. It is the bare-`{}` case every Feature in this
# collection has to survive (see .plans/design/devc-feature-split.md), and it is also the
# hostile one: a Feature whose whole job is to drive nvm, installed somewhere nvm does not
# exist. It must install cleanly, leave a working shell, and say something useful rather than
# failing the create — that last part is what turns a misconfiguration into a container you can
# still open and fix.
#
# The scenarios in scenarios.json cover the other half, where nvm is actually present.
set -e

source dev-container-features-test-lib

SHARE=/usr/local/share/devc-features/node-nvmrc

check "create-time script is installed" test -f "$SHARE/post-create.sh"
check "and is executable" test -x "$SHARE/post-create.sh"
check "and is owned by root" bash -c \
  "[ \"\$(stat -c '%U:%G' $SHARE/post-create.sh)\" = 'root:root' ]"

# The options cross into the create-time script at build time — the manifest's
# postCreateCommand takes no arguments — so "did the bake happen" is a real property, not an
# implementation detail. These are the defaults, since this scenario passes no options.
check "nvmDir baked to the upstream node Feature's location" \
  grep -qx 'NVM_DIR="/usr/local/share/nvm"' "$SHARE/post-create.sh"
check "installOnCreate baked true" \
  grep -qx 'INSTALL_ON_CREATE="true"' "$SHARE/post-create.sh"
check "fixNodeModulesOwnership baked true" \
  grep -qx 'FIX_NODE_MODULES_OWNERSHIP="true"' "$SHARE/post-create.sh"

check "the ~/.bashrc block was appended" grep -qF '# >>> node-nvmrc >>>' "$HOME/.bashrc"
check "exactly once" bash -c \
  "[ \"\$(grep -cF '# >>> node-nvmrc >>>' $HOME/.bashrc)\" = 1 ]"

# Source the block as it actually landed in ~/.bashrc rather than an interactive shell: `bash
# -i` without a tty writes its own noise to stderr, which would swamp the thing being asserted.
BLOCK=/tmp/nvm-use-block.sh
awk '/# devc:nvm-use \(start\)/{f=1;next} /# devc:nvm-use \(end\)/{f=0} f' \
  "$HOME/.bashrc" > "$BLOCK"

check "sourcing the block leaves \$? at 0" bash -c \
  ". $BLOCK; [ \$? -eq 0 ]"
check "with no nvm present, cd is NOT overridden" bash -c \
  ". $BLOCK; ! declare -F cd > /dev/null"
check "and cd still works" bash -c \
  ". $BLOCK; cd /tmp && [ \"\$PWD\" = /tmp ]"
check "sourcing the block is silent" bash -c \
  "[ -z \"\$(. $BLOCK 2>&1)\" ]"

# The create-time hook already ran once (this image declares it); run it again by hand to pin
# both no-op paths, which is cheap here and needs no workspace fixture. `env -u PROJECT_PATH`
# because the hook prefers that variable over $PWD, and nothing here should depend on whether
# the consumer happens to set it.
check "the hook is a silent no-op where there is no .nvmrc" bash -c \
  "d=\$(mktemp -d) && cd \$d &&
   out=\$(env -u PROJECT_PATH bash $SHARE/post-create.sh 2>&1) && [ -z \"\$out\" ]"

# A .nvmrc with no nvm to satisfy it is the misconfiguration case: warn, name the directory
# that was searched, and exit 0 anyway.
check "with a .nvmrc but no nvm it warns and still succeeds" bash -c \
  "d=\$(mktemp -d) && echo 20 > \$d/.nvmrc && cd \$d &&
   err=\$(env -u PROJECT_PATH bash $SHARE/post-create.sh 2>&1 >/dev/null) &&
   echo \"\$err\" | grep -q 'no nvm at /usr/local/share/nvm'"

reportResults
