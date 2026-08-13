#!/bin/bash
# init.sh — the whole of what a shell gets from this Feature, against temp directories.
#
#   bash features/bash-config/test/init_test.sh
#
# No Docker and no root. `_BASH_CONFIG_DIRS` redirects the one fixed path in init.sh at a
# fixture; everything else — the ordering, the guard, the liveness through the symlink — is the
# shipped file running unmodified. install_options_test.sh is what pins that fixed path to the
# one install.sh and the manifest actually use.
set -uo pipefail

FEATURE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
INIT="$FEATURE_DIR/init.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

fails=0
check() { # check <desc> <condition-as-args...>
  local desc="$1"; shift
  if "$@"; then echo "  ok   $desc"; else echo "  FAIL $desc"; fails=$((fails + 1)); fi
}

DIRS="$WORK/dirs"
WS="$WORK/ws/.devcontainer/shell"
mkdir -p "$DIRS/user" "$WS"
# The project directory is reached through a **symlink**, exactly as post-create.sh leaves it.
# That is not a detail of the fixture: a symlinked directory globs live, which is what lets the
# block in ~/.bashrc be a constant and still track the workspace.
ln -sfn "$WORK/ws/.devcontainer/shell" "$DIRS/project"

# The user directory: two bashrc scripts, a profile-prefixed one (no longer meaningful — it must
# be ignored like any other non-matching file), and two files that are not *.sh.
echo 'ORDER="${ORDER:-} u10"; WINNER=user; USER_ONLY=1' > "$DIRS/user/bashrc_10.sh"
echo 'ORDER="${ORDER:-} u20"' > "$DIRS/user/bashrc_20.sh"
echo 'PORDER="${PORDER:-} u10"; PWINNER=user' > "$DIRS/user/profile_10.sh"
echo 'ORDER="${ORDER:-} nope"' > "$DIRS/user/bashrc_30.txt"
echo 'ORDER="${ORDER:-} nope"' > "$DIRS/user/README.md"

# The project directory: the same shape, plus a file with no prefix and a *directory* whose name
# matches the glob.
echo 'ORDER="${ORDER:-} p10"; WINNER=project' > "$WS/bashrc_10.sh"
echo 'PORDER="${PORDER:-} p10"; PWINNER=project' > "$WS/profile_10.sh"
echo 'ORDER="${ORDER:-} nope"' > "$WS/unprefixed.sh"
mkdir -p "$WS/bashrc_subdir.sh"
echo 'ORDER="${ORDER:-} nope"' > "$WS/bashrc_subdir.sh/bashrc_inner.sh"

# env.sh, as post-create.sh writes it: guarded, so an inherited PROJECT_PATH still wins.
printf 'export PROJECT_PATH="${PROJECT_PATH:-%s}"\n' "$WORK/ws" > "$DIRS/env.sh"

# run <shell> <snippet> — one fresh shell, init.sh sourced the way the block sources it.
# PROJECT_PATH is unset unless a case sets it: this harness runs inside a devcontainer that has
# its own, and inheriting it would silently make every case an "already set" case.
run() {
  local shell="$1" snippet="$2"
  env -u PROJECT_PATH _BASH_CONFIG_DIRS="$DIRS" "$shell" -c ". '$INIT'; $snippet"
}

echo "case 1: every bashrc_*.sh, in both directories"
check "sources every bashrc_*.sh" test "$(run bash 'printf %s "${ORDER:-}"')" = ' u10 u20 p10'
check "and ignores profile_*.sh — it is just a file with an unmatched name now" \
  test "$(run bash 'printf %s "${PORDER:-none}"')" = none

echo "case 2: user directory first, project second — the project wins on conflict"
check "the project's value survives" test "$(run bash 'printf %s "$WINNER"')" = project
check "and the user's own settings survive with it" \
  test "$(run bash 'printf %s "$USER_ONLY"')" = 1

echo "case 3: only bashrc_*.sh, and only files"
check "a .txt in the directory is ignored" \
  run bash 'case "${ORDER:-}" in *nope*) exit 1 ;; esac'
check "so is an unprefixed *.sh" \
  run bash 'case "${ORDER:-}" in *nope*) exit 1 ;; esac'
# A directory matching the glob is the one shape that would be *noisy* rather than merely
# wrong: `. some/dir` prints an error and carries on. Not descended into either.
check "a directory whose name matches the glob is skipped, quietly" bash -c \
  "out=\$(env -u PROJECT_PATH _BASH_CONFIG_DIRS='$DIRS' bash -c \
     '. \"$INIT\"; printf %s \"\$ORDER\"' 2>&1)
   [ \"\$out\" = ' u10 u20 p10' ]"

echo "case 4: env.sh, before anything else"
check "PROJECT_PATH reaches the shell with no remoteEnv" \
  test "$(run bash 'printf %s "${PROJECT_PATH:-none}"')" = "$WORK/ws"
check "and it is exported, not just set" \
  test "$(run bash 'bash -c "printf %s \"\${PROJECT_PATH:-none}\""')" = "$WORK/ws"
check "an inherited value still wins" bash -c \
  "[ \"\$(env _BASH_CONFIG_DIRS='$DIRS' PROJECT_PATH=/elsewhere bash -c \
     '. \"$INIT\"; printf %s \"\$PROJECT_PATH\"')\" = /elsewhere ]"
# Ordering: a layer script must be able to *use* PROJECT_PATH, which is only true if env.sh was
# sourced before the directories rather than alongside them.
echo 'SAW_PP="${PROJECT_PATH:-none}"' > "$WS/bashrc_05.sh"
check "a layer script can read it" \
  test "$(run bash 'printf %s "$SAW_PP"')" = "$WORK/ws"
rm -f "$WS/bashrc_05.sh"

echo "case 5: the project directory is live, because it is a symlink"
echo 'ADDED_LATER=1' > "$WS/bashrc_90.sh"
check "a file added after install is sourced by the next shell" \
  test "$(run bash 'printf %s "${ADDED_LATER:-none}"')" = 1
rm -f "$WS/bashrc_90.sh"
check "and deleting it stops it being read" \
  test "$(run bash 'printf %s "${ADDED_LATER:-none}"')" = none

echo "case 6: nothing to source is silent success, in every shape"
quiet() { # quiet — stdout+stderr of a shell that sources init.sh and nothing else
  run bash 'true' 2>&1
}
check "the fixture as it stands is silent" test -z "$(quiet)"
check "and leaves \$? at 0" run bash '[ $? -eq 0 ]'

mv "$WS" "$WORK/ws/moved"
check "a dangling project symlink is a no-op" test -z "$(quiet)"
check "  at rc 0" run bash 'true'
mv "$WORK/ws/moved" "$WS"

mkdir -p "$WORK/empty-dirs/user"
ln -sfn "$WORK/does-not-exist" "$WORK/empty-dirs/project"
check "an empty user directory is a no-op" bash -c \
  "[ -z \"\$(env -u PROJECT_PATH _BASH_CONFIG_DIRS='$WORK/empty-dirs' bash -c \
     '. \"$INIT\"' 2>&1)\" ]"
check "so is an absent dirs/ altogether" bash -c \
  "[ -z \"\$(env -u PROJECT_PATH _BASH_CONFIG_DIRS='$WORK/nothing-here' bash -c \
     '. \"$INIT\"; exit 0' 2>&1)\" ]"

echo "case 7: nothing is left behind in the shell"
check "no helper function" run bash '! declare -F _bash_config_source_dir > /dev/null'
check "no loop variable" run bash '[ -z "${_bash_config_f:-}" ]'
check "no path variable" run bash '[ -z "${_bash_config_dirs:-}${_bash_config_real:-}" ]'

echo "case 8: sourced twice, each file runs once"
check "the same directories twice are idempotent" bash -c \
  "[ \"\$(env -u PROJECT_PATH _BASH_CONFIG_DIRS='$DIRS' bash -c \
     '. \"$INIT\"
      . \"$INIT\"
      printf %s \"\$ORDER\"')\" = ' u10 u20 p10' ]"
# The same directory reached under two names is one directory — which is what makes the guard
# worth anything at all next to a shell-dirs block naming the workspace path outright.
check "the guard keys on the physical path, through the symlink" bash -c \
  "[ \"\$(env -u PROJECT_PATH _BASH_CONFIG_DIRS='$DIRS' bash -c \
     '. \"$INIT\"
      printf %s \"\$_BASH_CONFIG_DONE\"')\" = \
   '$DIRS/user:$WORK/ws/.devcontainer/shell' ]"
check "the guard is not exported — a child shell starts clean" bash -c \
  "[ \"\$(env -u PROJECT_PATH _BASH_CONFIG_DIRS='$DIRS' bash -c \
     '. \"$INIT\"
      bash -c \"printf %s \\\"\\\${_BASH_CONFIG_DONE:-none}\\\"\"')\" = none ]"

echo
if [ "$fails" -eq 0 ]; then echo "ALL PASS"; else echo "$fails FAILED"; exit 1; fi
