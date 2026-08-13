#!/bin/bash
# Scenario: nvm is present (the upstream node Feature) but the workspace pins nothing. The
# Feature has to be a no-op — the container creates, the hook exits 0, no symlink is written,
# and Node is exactly the Node the node Feature left behind.
#
# This is the case that decides whether the Feature is safe to leave enabled everywhere, which
# is the only reason a one-line opt-in is worth anything. If a missing `.nvmrc` were a failure,
# or even a warning, nobody could put this in a shared base config.
#
# In 0.2.0 it carries a second job: this Feature's containerEnv PATH entry is on PATH whether or
# not anything was pinned, so "a PATH entry naming a directory that does not exist is silently
# skipped" has to be true in a container where something else really does provide `node`.
set -e

source dev-container-features-test-lib

SHARE=/usr/local/share/devc-features/node-nvmrc

check "the workspace really has no .nvmrc" test ! -f "$PWD/.nvmrc"

# Reaching this file at all means the create succeeded, so the interesting part is that the hook
# is *silently* fine on a second run — the same thing that happens on a rebuild.
check "the hook exits 0 and says nothing" bash -c \
  "out=\$(bash $SHARE/post-create.sh 2>&1) && [ -z \"\$out\" ]"

check "pin/ exists but pin/bin was never created" bash -c \
  "[ -d $SHARE/pin ] && [ ! -e $SHARE/pin/bin ]"
check "and PATH names it anyway" bash -c \
  "case \":\$PATH:\" in *\":$SHARE/pin/bin:\"*) exit 0 ;; *) exit 1 ;; esac"

# The inert case, in a container that has a real Node to fall through to. A dangling PATH entry
# must not shadow, break or slow anything.
check "a non-interactive bash still has the node Feature's Node" bash -c \
  "bash -c 'node -v' | grep -q '^v'"
check "so does sh" bash -c "sh -c 'node -v' | grep -q '^v'"
check "and it resolves through nvm's own current symlink" bash -c \
  "case \"\$(bash -c 'command -v node')\" in */nvm/*) exit 0 ;; *) exit 1 ;; esac"
check "every shell is silent" bash -c "[ -z \"\$(bash -lc true 2>&1)\" ]"

check "no node-nvmrc block was appended to ~/.bashrc" bash -c \
  "! grep -qF '# >>> node-nvmrc >>>' '$HOME/.bashrc' 2> /dev/null"
check "and cd is not overridden anywhere" bash -c \
  "! bash -ic 'declare -F cd' > /dev/null 2>&1"

reportResults
