#!/bin/bash
# `devcontainer features test` default scenario — runs INSIDE a container built from this
# Feature with **no options** (`"bash-config": {}`), no mounts, no remoteEnv, and no devc.
#
# That is the case this file exists to prove. `.plans/design/devc-feature-split.md` requires a
# bare `{}` to install cleanly and do something useful on its own, and here that something is
# the project directory: a symlink into the repo's own .devcontainer/shell, with nothing else in
# the devcontainer.json at all.
#
# It also measures the two things the offline harnesses cannot:
#
#   * the cwd of a Feature-declared postCreateCommand — the hook resolves the workspace from it,
#     so "dirs/project points at an absolute path under the workspace" is a direct read of what
#     the CLI handed it. If the cwd were the home folder, the hook declines and there is no
#     symlink at all, and these checks fail saying so;
#   * the chown of dirs/ to $_REMOTE_USER, which is what lets a hook running as that user create
#     the symlink in a root-owned /usr/local/share at all.
set -e

source dev-container-features-test-lib

SHARE=/usr/local/share/devc-features/bash-config
DIRS="$SHARE/dirs"

# --- what install.sh left behind ------------------------------------------------------------

check "the ~/.bashrc block was appended" grep -qF '# >>> bash-config >>>' "$HOME/.bashrc"
check "exactly once" bash -c \
  "[ \"\$(grep -cF '# >>> bash-config >>>' $HOME/.bashrc)\" = 1 ]"
check "and is closed" grep -qF '# <<< bash-config <<<' "$HOME/.bashrc"

# The block is a constant. No option, no workspace path, no ${PROJECT_PATH} deferral, nothing
# for a create-time hook to come back and patch — that is the whole reason this Feature exists
# in place of shell-dirs, so it is asserted literally rather than by grep.
check "it is the static one line, naming the fixed path" bash -c \
  "[ \"\$(sed -n '/^# >>> bash-config >>>\$/,/^# <<< bash-config <<<\$/p' $HOME/.bashrc)\" = \
'# >>> bash-config >>>
. $SHARE/init.sh
# <<< bash-config <<<' ]"

# No login profile is touched at all — this Feature's whole audience is ~/.bashrc. This image
# ships ~/.profile (unrelated to this Feature); the point is that nothing appended a block to
# it, not that the file is absent.
check "~/.profile has no bash-config block" bash -c \
  "! grep -qF '# >>> bash-config >>>' '$HOME/.profile' 2> /dev/null"
check "no ~/.bash_profile was created" test ! -e "$HOME/.bash_profile"
check "no ~/.bash_login was created" test ! -e "$HOME/.bash_login"

check "~/.bashrc is still writable by the remote user" test -w "$HOME/.bashrc"

check "init.sh is installed" test -f "$SHARE/init.sh"
check "and is owned by root" bash -c "[ \"\$(stat -c '%U' $SHARE/init.sh)\" = root ]"
check "post-create.sh is installed and executable" test -x "$SHARE/post-create.sh"
check "config.sh carries the default projectDir" \
  grep -qx 'PROJECT_DIR=".devcontainer/shell"' "$SHARE/config.sh"

# The published surface. Created empty and never written to by this Feature — a consumer mounts
# onto it or copies into it, and the Feature never learns which.
check "dirs/user exists and is empty" bash -c \
  "[ -d $DIRS/user ] && [ -z \"\$(ls -A $DIRS/user)\" ]"
# Open question 2: /usr/local/share is root-owned and the create-time hook runs as the remote
# user, so without this chown it could not have created the symlink below.
check "dirs/ is owned by the remote user" bash -c \
  "[ \"\$(stat -c '%U' $DIRS)\" = \"\$(id -un)\" ] &&
   [ \"\$(stat -c '%U' $DIRS/user)\" = \"\$(id -un)\" ]"
check "and it is writable by them" test -w "$DIRS/user"

# --- what the create-time hook did ------------------------------------------------------------

check "dirs/project is a symlink" test -L "$DIRS/project"
TARGET="$(readlink "$DIRS/project")"

# The measurement. An absolute path under a real workspace folder is only possible if the CLI
# gave the hook that folder as its cwd — nothing else here knows it.
check "it points at an absolute path" bash -c "case '$TARGET' in /*) exit 0 ;; *) exit 1 ;; esac"
check "ending in the default projectDir" bash -c \
  "case '$TARGET' in */.devcontainer/shell) exit 0 ;; *) exit 1 ;; esac"
check "and not at the home folder" bash -c "[ '$TARGET' != '$HOME/.devcontainer/shell' ]"
check "it is the workspace this test is running in" bash -c \
  "[ '$TARGET' = '$PWD/.devcontainer/shell' ]"

check "env.sh records the same workspace, guarded" \
  grep -qxF "export PROJECT_PATH=\"\${PROJECT_PATH:-$PWD}\"" "$DIRS/env.sh"

# --- what a shell actually gets ---------------------------------------------------------------
#
# Through a file rather than stdout: `bash -i` without a tty writes job-control noise to stderr,
# and any other startup line is free to print. PROJECT_PATH is unset throughout — not needing it
# is the point of the create-time hook.
mkdir -p "$TARGET"
echo 'ORDER="${ORDER:-} p10"; export MARKER=project' > "$TARGET/bashrc_10.sh"
echo 'ORDER="${ORDER:-} p20"' > "$TARGET/bashrc_20.sh"
echo 'ORDER="${ORDER:-} nope"' > "$TARGET/bashrc_30.txt"
echo 'ORDER="${ORDER:-} nope"' > "$TARGET/unprefixed.sh"
echo 'export PROFILE_MARKER=project' > "$TARGET/profile_10.sh"

probe() { # probe <bash flags> <snippet writing to /tmp/probe>
  rm -f /tmp/probe
  env -u PROJECT_PATH bash "$1" "$2" > /dev/null 2>&1
  cat /tmp/probe 2> /dev/null
}

check "a fresh interactive shell sources the project directory" \
  test "$(probe -ic 'printf %s "${MARKER:-none}" > /tmp/probe')" = project
check "in glob order" test "$(probe -ic 'printf %s "${ORDER:-}" > /tmp/probe')" = ' p10 p20'
check "only bashrc_*.sh" \
  bash -c "case '$(probe -ic 'printf %s "${ORDER:-}" > /tmp/probe')' in *nope*) exit 1 ;; esac"
# profile_10.sh is just an ignored file now — no prefix routes to it from anywhere.
check "the profile_ file is never sourced, by any shell" \
  test "$(probe -ic 'printf %s "${PROFILE_MARKER:-none}" > /tmp/probe')" = none

# The Feature's ceiling: a login shell gets nothing from this Feature at all — no block is
# appended to a login profile.
check "a login shell gets nothing from this Feature" \
  test "$(probe -lc 'printf %s "${MARKER:-none}" > /tmp/probe')" = none
check "PROJECT_PATH reaches a shell with no remoteEnv at all" \
  test "$(probe -ic 'printf %s "${PROJECT_PATH:-none}" > /tmp/probe')" = "$PWD"

check "no helper function or loop variable is left behind" \
  test "$(probe -ic 'declare -F _bash_config_source_dir > /dev/null && printf leak > /tmp/probe
    [ -n "${_bash_config_dirs:-}" ] && printf leak > /tmp/probe
    printf %s "${_x:-clean}" >> /tmp/probe')" = clean
check "both startup files are silent" bash -c \
  "[ -z \"\$(env -u PROJECT_PATH bash -lc true 2>&1)\" ]"

# Live, not baked: dirs/project is a symlink, so the workspace is still the source of truth and
# nothing was copied at create time.
echo 'export ADDED_LATER=1' > "$TARGET/bashrc_90.sh"
check "a file added after create is picked up" \
  test "$(probe -ic 'printf %s "${ADDED_LATER:-none}" > /tmp/probe')" = 1
rm -f "$TARGET/bashrc_90.sh"
check "and deleting it stops it being read" \
  test "$(probe -ic 'printf %s "${ADDED_LATER:-none}" > /tmp/probe')" = none

# Everything, not just <kind>_*.sh — the .txt fixture would otherwise keep the rmdir below from
# succeeding, and `set -e` would end the scenario there.
rm -f "$TARGET"/*
# Through a login shell rather than an interactive one: `bash -i` without a tty writes its own
# job-control complaints to stderr, which would swamp what is being asserted. It reaches the
# same two directories.
check "an empty directory is a no-op, not an error" bash -c \
  "[ -z \"\$(env -u PROJECT_PATH bash -lc true 2>&1)\" ]"
rmdir "$TARGET"
check "and a dangling symlink is a no-op too" bash -c \
  "[ -z \"\$(env -u PROJECT_PATH bash -lc true 2>&1)\" ]"

reportResults
