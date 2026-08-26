#!/bin/bash
# Scenario `mounted_identity` — an identity file already in place before this Feature's
# postCreateCommand runs, standing in for what a real host bind mount would deliver (a bind mount
# is the one thing a Feature cannot declare — see README.md's Identity section). Written directly
# into the Feature's own fixed identity path by this scenario's own onCreateCommand, the same
# technique agents' with_seed scenario uses.
#
# Note what this scenario does NOT pass: any options at all. The identity path is fixed, so
# mounting something onto it is the whole configuration — that is the difference between this
# scenario and the default one.
#
# Asserts both halves of the ordering contract: the include resolves (user.email/user.name come
# through), AND a container-mandated key the identity file *also* sets (safe.directory) is won
# by the container, not the identity file — which is the whole reason include.path runs FIRST.
set -e

source dev-container-features-test-lib

IDENTITY=/usr/local/share/devc-features/git-container-config/identity/gitconfig

check "the identity file landed before create" test -f "$IDENTITY"
check "this Feature's include.path names it" bash -c \
  "[ \"\$(git config --global --get include.path)\" = '$IDENTITY' ]"
check "user.email resolves through the include" bash -c \
  "[ \"\$(git config --get user.email)\" = scenario@example.com ]"
check "user.name resolves through the include" bash -c \
  "[ \"\$(git config --get user.name)\" = 'Scenario Tester' ]"

# The identity file also sets safe.directory=/nonexistent. The container's own --replace-all
# safe.directory '*' runs AFTER the include, so it must be the one that sticks.
check "safe.directory is won by the container, not the identity file" bash -c \
  "[ \"\$(git config --global --get safe.directory)\" = '*' ]"
check "the identity file's own safe.directory value is gone" bash -c \
  "! git config --global --get-all safe.directory | grep -qx /nonexistent"

reportResults
