#!/bin/bash
# Scenario `with_git_lfs` — the git-lfs Feature installs the `git-lfs` binary at build time, as
# root, so the whole point of this Feature's step 2 is exercised here: the filters must land in
# the REMOTE USER's ~/.gitconfig, not root's, and --skip-smudge must actually be there.
set -e

source dev-container-features-test-lib

check "git-lfs is on PATH" bash -c "command -v git-lfs"
check "filter.lfs.clean is set for the remote user" bash -c \
  "[ -n \"\$(git config --global --get filter.lfs.clean)\" ]"
check "filter.lfs.smudge carries --skip" bash -c \
  "git config --global --get filter.lfs.smudge | grep -q -- '--skip'"
check "filter.lfs.process carries --skip too" bash -c \
  "git config --global --get filter.lfs.process | grep -q -- '--skip'"

# The other two container-scope settings still apply alongside LFS — nothing about git-lfs
# being present changes the rest of the hook.
check "worktree.useRelativePaths still applied" bash -c \
  "[ \"\$(git config --global --get worktree.useRelativePaths)\" = true ]"
check "safe.directory still applied" bash -c \
  "[ \"\$(git config --global --get safe.directory)\" = '*' ]"

reportResults
