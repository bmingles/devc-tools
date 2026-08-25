#!/bin/bash
# `devcontainer features test` default scenario — runs INSIDE a container built from this
# Feature with **no options** (`"agents": {}`).
#
# That combination is the bare-`{}` case every Feature in this collection has to survive (see
# .plans/design/devc-feature-split.md): the Claude CLI installs and nothing else — no seed
# linking (seedDir defaults empty, the Feature never invents this path), ~/.claude.json left
# completely alone, and Copilot absent (installCopilotCli defaults false).
#
# The seedDir/claudeJsonDir/installCopilotCli scenarios live in scenarios.json.
set -e

source dev-container-features-test-lib

SHARE=/usr/local/share/devc-features/agents

check "create-time script is installed" test -f "$SHARE/post-create.sh"
check "and is executable" test -x "$SHARE/post-create.sh"
check "and is owned by root" bash -c \
  "[ \"\$(stat -c '%U:%G' $SHARE/post-create.sh)\" = 'root:root' ]"

# The options cross into the create-time script at build time — the manifest's
# postCreateCommand takes no arguments — so "did the bake happen" is a real property. These are
# the defaults, since this scenario passes no options. claudeDir's empty default resolves at
# build time to $_REMOTE_USER_HOME/.claude — this scenario's remote user is $HOME here.
check "CLAUDE_DIR baked to \$HOME/.claude" \
  grep -qxF "CLAUDE_DIR=\"$HOME/.claude\"" "$SHARE/post-create.sh"
check "SEED_DIR baked empty — seed linking is off" \
  grep -qx 'SEED_DIR=""' "$SHARE/post-create.sh"
check "CLAUDE_JSON_DIR baked empty — ~/.claude.json is left alone" \
  grep -qx 'CLAUDE_JSON_DIR=""' "$SHARE/post-create.sh"

# --- the Claude CLI ------------------------------------------------------------------------
check "claude is on PATH" bash -c "command -v claude"
check "claude is executable by the remote user" test -x "$(command -v claude)"

# --- Copilot stays absent — installCopilotCli defaults false --------------------------------
check "copilot is NOT on PATH" bash -c "! command -v copilot"

# --- ~/.claude ownership ---------------------------------------------------------------------
# install.sh pre-creates it owned by the remote user at build time; post-create.sh's belt-and-
# braces chown is a no-op here either way.
check "~/.claude exists" test -d "$HOME/.claude"
check "and is owned by the remote user" bash -c \
  "[ \"\$(stat -c '%U' $HOME/.claude)\" = \"\$(id -un)\" ]"

# --- nothing linked, nothing touched ----------------------------------------------------------
check "seedDir was empty, so ~/.claude has nothing linked into it" bash -c \
  "[ -z \"\$(find \"$HOME/.claude\" -mindepth 1 -maxdepth 1 -type l)\" ]"
check "~/.claude.json is not a symlink — claudeJsonDir was empty" \
  test ! -L "$HOME/.claude.json"

reportResults
