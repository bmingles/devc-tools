#!/bin/bash
# Scenario `with_seed_and_json` — a seed directory and a claude.json directory already in place
# before this Feature's postCreateCommand runs, standing in for what a real host mount would
# deliver (a bind mount is the one thing a Feature cannot declare — see README.md). Written
# directly into a fixed container path by this scenario's own onCreateCommand, the same
# technique git-container-config's mounted_identity scenario and shell-dirs' both_layers
# scenario use.
#
# Covers both halves the plan's validation calls out: top-level seed files land as symlinks and
# a seed subdirectory does NOT get linked, and claudeJsonDir turns ~/.claude.json into a symlink
# that reads back the seeded {}.
set -e

source dev-container-features-test-lib

SEED=/usr/local/share/claude-config-test/seed
JSON_DIR=/usr/local/share/claude-config-test/claude-json

check "the seed landed before create" test -f "$SEED/CLAUDE.md"

check "CLAUDE.md is a symlink into the seed" \
  test "$(readlink "$HOME/.claude/CLAUDE.md")" = "$SEED/CLAUDE.md"
check "settings.json is linked too" test -L "$HOME/.claude/settings.json"
check "the seed's skills/ subdirectory is NOT linked" test ! -e "$HOME/.claude/skills"

check "~/.claude.json is a symlink" test -L "$HOME/.claude.json"
check "it resolves into claudeJsonDir" \
  test "$(readlink -f "$HOME/.claude.json")" = "$(readlink -f "$JSON_DIR/claude.json")"
check "it reads back the seeded {}" test "$(cat "$HOME/.claude.json")" = '{}'

reportResults
