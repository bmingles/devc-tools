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
# It is also where the **inert** case is asserted: with nothing to pin, `pin/bin` is never
# created, and a PATH entry naming a directory that does not exist has to be a silent no-op for
# every lookup rather than something a shell complains about.
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
check "projectDir baked empty — the workspace root" \
  grep -qx 'PROJECT_DIR=""' "$SHARE/post-create.sh"
check "installOnCreate baked true" \
  grep -qx 'INSTALL_ON_CREATE="true"' "$SHARE/post-create.sh"
check "fixNodeModulesOwnership baked true" \
  grep -qx 'FIX_NODE_MODULES_OWNERSHIP="true"' "$SHARE/post-create.sh"
check "SHARE_DIR baked to where the manifest calls it from" \
  grep -qxF "SHARE_DIR=\"$SHARE\"" "$SHARE/post-create.sh"

# /usr/local/share is root-owned and the create-time hook runs as the remote user, so without
# this non-recursive chown it could not create the symlink — while post-create.sh has to stay
# root-owned. Only a real container can exercise that split.
check "pin/ exists" test -d "$SHARE/pin"
check "and is owned by the remote user" bash -c \
  "[ \"\$(stat -c '%U' $SHARE/pin)\" = \"\$(id -un)\" ]"
check "and is writable by them" test -w "$SHARE/pin"

# --- nothing was written to any startup file ---------------------------------------------------
#
# This is what 0.2.0 removed. The block it used to append reached only interactive bash, which
# is measurably not the audience; if one ever comes back, it comes back here first.
check "no node-nvmrc block in ~/.bashrc" bash -c \
  "! grep -qF '# >>> node-nvmrc >>>' '$HOME/.bashrc' 2> /dev/null"
check "and no devc:nvm-use fence either" bash -c \
  "! grep -rqF 'devc:nvm-use' '$HOME' 2> /dev/null"
check "no cd override in an interactive shell" bash -c \
  "! bash -ic 'declare -F cd' > /dev/null 2>&1"
check "~/.bashrc is still writable by the remote user" bash -c \
  "[ ! -e '$HOME/.bashrc' ] || [ -w '$HOME/.bashrc' ]"

# --- the inert case ---------------------------------------------------------------------------
#
# No .nvmrc anywhere and no nvm, so the create-time hook created no symlink. The containerEnv
# PATH entry therefore names a directory that does not exist, and every lookup has to fall
# straight through it.
check "PATH carries the Feature's pin directory" bash -c \
  "case \":\$PATH:\" in *\":$SHARE/pin/bin:\"*) exit 0 ;; *) exit 1 ;; esac"
check "which does not exist, because nothing was pinned" test ! -e "$SHARE/pin/bin"
check "a non-interactive shell is unbothered by it" bash -c \
  "[ \"\$(bash -c 'echo ok' 2>&1)\" = ok ]"
check "so is sh" bash -c "[ \"\$(sh -c 'echo ok' 2>&1)\" = ok ]"
check "and lookup still finds things further down PATH" bash -c \
  "[ \"\$(bash -c 'command -v env')\" = \"\$(command -v env)\" ]"
check "a login shell is silent" bash -c "[ -z \"\$(bash -lc true 2>&1)\" ]"

# The create-time hook already ran once (this image declares it); run it again by hand to pin
# both no-op paths, which is cheap here and needs no workspace fixture. `env -u PROJECT_PATH`
# because the hook prefers that variable over $PWD, and nothing here should depend on whether
# the consumer happens to set it.
check "the hook is a silent no-op where there is no .nvmrc" bash -c \
  "d=\$(mktemp -d) && cd \$d &&
   out=\$(env -u PROJECT_PATH bash $SHARE/post-create.sh 2>&1) && [ -z \"\$out\" ]"

# A .nvmrc with no nvm to satisfy it is the misconfiguration case: warn, name the directory
# that was searched, exit 0 anyway, and leave the PATH entry inert.
check "with a .nvmrc but no nvm it warns and still succeeds" bash -c \
  "d=\$(mktemp -d) && echo 20 > \$d/.nvmrc && cd \$d &&
   err=\$(env -u PROJECT_PATH bash $SHARE/post-create.sh 2>&1 >/dev/null) &&
   echo \"\$err\" | grep -q 'no nvm at /usr/local/share/nvm'"
check "and still creates no symlink" test ! -e "$SHARE/pin/bin"

reportResults
