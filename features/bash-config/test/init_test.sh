#!/bin/bash
# init.sh — the whole of what a shell gets from this Feature, against temp directories.
#
#   bash features/bash-config/test/init_test.sh
#
# No Docker and no root. `_BASH_CONFIG_DIRS` redirects the one fixed path in init.sh at a
# fixture; everything else — the two prefixes, the ordering, the guard, the liveness through
# the symlink — is the shipped file running unmodified. install_options_test.sh is what pins
# that fixed path to the one install.sh and the manifest actually use.
#
# The last case runs everything again under **dash**, because the login profile this file is
# sourced from is read by dash on a Debian-derived image (`sh -l` executes the block). A
# bashism here would work in every interactive shell and break every login one.
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

# The user directory: two bashrc scripts, one profile script, and two files that are not *.sh.
echo 'ORDER="${ORDER:-} u10"; WINNER=user; USER_ONLY=1' > "$DIRS/user/bashrc_10.sh"
echo 'ORDER="${ORDER:-} u20"' > "$DIRS/user/bashrc_20.sh"
echo 'PORDER="${PORDER:-} u10"; PWINNER=user' > "$DIRS/user/profile_10.sh"
echo 'ORDER="${ORDER:-} nope"' > "$DIRS/user/bashrc_30.txt"
echo 'ORDER="${ORDER:-} nope"' > "$DIRS/user/README.md"

# The project directory: the same two kinds, plus a file with no prefix and a *directory* whose
# name matches the glob.
echo 'ORDER="${ORDER:-} p10"; WINNER=project' > "$WS/bashrc_10.sh"
echo 'PORDER="${PORDER:-} p10"; PWINNER=project' > "$WS/profile_10.sh"
echo 'ORDER="${ORDER:-} nope"' > "$WS/unprefixed.sh"
mkdir -p "$WS/bashrc_subdir.sh"
echo 'ORDER="${ORDER:-} nope"' > "$WS/bashrc_subdir.sh/bashrc_inner.sh"

# env.sh, as post-create.sh writes it: guarded, so an inherited PROJECT_PATH still wins.
printf 'export PROJECT_PATH="${PROJECT_PATH:-%s}"\n' "$WORK/ws" > "$DIRS/env.sh"

# run <shell> <kind> <snippet> — one fresh shell, init.sh sourced the way the block sources it.
# PROJECT_PATH is unset unless a case sets it: this harness runs inside a devcontainer that has
# its own, and inheriting it would silently make every case an "already set" case.
run() {
  local shell="$1" kind="$2" snippet="$3"
  env -u PROJECT_PATH _BASH_CONFIG_DIRS="$DIRS" "$shell" -c \
    "_bash_config_kind=$kind
     . '$INIT'
     $snippet"
}

echo "case 1: the kind selects the prefix — two audiences, not two layers"
check "bashrc sources every bashrc_*.sh" \
  test "$(run bash bashrc 'printf %s "${ORDER:-}"')" = ' u10 u20 p10'
check "and no profile_*.sh" \
  test "$(run bash bashrc 'printf %s "${PORDER:-none}"')" = none
check "profile sources every profile_*.sh" \
  test "$(run bash profile 'printf %s "${PORDER:-}"')" = ' u10 p10'
check "and no bashrc_*.sh" \
  test "$(run bash profile 'printf %s "${ORDER:-none}"')" = none

echo "case 2: user directory first, project second — the project wins on conflict"
check "the project's value survives" test "$(run bash bashrc 'printf %s "$WINNER"')" = project
check "and the user's own settings survive with it" \
  test "$(run bash bashrc 'printf %s "$USER_ONLY"')" = 1
check "the same order for profile_" test "$(run bash profile 'printf %s "$PWINNER"')" = project

echo "case 3: only <kind>_*.sh, and only files"
check "a .txt in the directory is ignored" \
  run bash bashrc 'case "${ORDER:-}" in *nope*) exit 1 ;; esac'
check "so is an unprefixed *.sh" \
  run bash bashrc 'case "${ORDER:-}" in *nope*) exit 1 ;; esac'
# A directory matching the glob is the one shape that would be *noisy* rather than merely
# wrong: `. some/dir` prints an error and carries on. Not descended into either.
check "a directory whose name matches the glob is skipped, quietly" bash -c \
  "out=\$(env -u PROJECT_PATH _BASH_CONFIG_DIRS='$DIRS' bash -c \
     '_bash_config_kind=bashrc; . \"$INIT\"; printf %s \"\$ORDER\"' 2>&1)
   [ \"\$out\" = ' u10 u20 p10' ]"

echo "case 4: env.sh, before anything else"
check "PROJECT_PATH reaches the shell with no remoteEnv" \
  test "$(run bash bashrc 'printf %s "${PROJECT_PATH:-none}"')" = "$WORK/ws"
check "and it is exported, not just set" \
  test "$(run bash bashrc 'bash -c "printf %s \"\${PROJECT_PATH:-none}\""')" = "$WORK/ws"
check "an inherited value still wins" bash -c \
  "[ \"\$(env _BASH_CONFIG_DIRS='$DIRS' PROJECT_PATH=/elsewhere bash -c \
     '_bash_config_kind=bashrc; . \"$INIT\"; printf %s \"\$PROJECT_PATH\"')\" = /elsewhere ]"
# Ordering: a layer script must be able to *use* PROJECT_PATH, which is only true if env.sh was
# sourced before the directories rather than alongside them.
echo 'SAW_PP="${PROJECT_PATH:-none}"' > "$WS/bashrc_05.sh"
check "a layer script can read it" \
  test "$(run bash bashrc 'printf %s "$SAW_PP"')" = "$WORK/ws"
rm -f "$WS/bashrc_05.sh"

echo "case 5: the project directory is live, because it is a symlink"
echo 'ADDED_LATER=1' > "$WS/bashrc_90.sh"
check "a file added after install is sourced by the next shell" \
  test "$(run bash bashrc 'printf %s "${ADDED_LATER:-none}"')" = 1
rm -f "$WS/bashrc_90.sh"
check "and deleting it stops it being read" \
  test "$(run bash bashrc 'printf %s "${ADDED_LATER:-none}"')" = none

echo "case 6: nothing to source is silent success, in every shape"
quiet() { # quiet <kind> — stdout+stderr of a shell that sources init.sh and nothing else
  run bash "$1" 'true' 2>&1
}
check "the fixture as it stands is silent" test -z "$(quiet bashrc)"
check "and leaves \$? at 0" run bash bashrc '[ $? -eq 0 ]'

mv "$WS" "$WORK/ws/moved"
check "a dangling project symlink is a no-op" test -z "$(quiet bashrc)"
check "  at rc 0" run bash bashrc 'true'
mv "$WORK/ws/moved" "$WS"

mkdir -p "$WORK/empty-dirs/user"
ln -sfn "$WORK/does-not-exist" "$WORK/empty-dirs/project"
check "an empty user directory is a no-op" bash -c \
  "[ -z \"\$(env -u PROJECT_PATH _BASH_CONFIG_DIRS='$WORK/empty-dirs' bash -c \
     '_bash_config_kind=bashrc; . \"$INIT\"' 2>&1)\" ]"
check "so is an absent dirs/ altogether" bash -c \
  "[ -z \"\$(env -u PROJECT_PATH _BASH_CONFIG_DIRS='$WORK/nothing-here' bash -c \
     '_bash_config_kind=bashrc; . \"$INIT\"; exit 0' 2>&1)\" ]"

echo "case 7: nothing is left behind in the shell"
check "no helper function" run bash bashrc '! declare -F _bash_config_source_dir > /dev/null'
check "no loop variable" run bash bashrc '[ -z "${_bash_config_f:-}" ]'
check "no path variable" run bash bashrc '[ -z "${_bash_config_dirs:-}${_bash_config_real:-}" ]'
# The block sets the kind and this file unsets it, so the two blocks in one login shell cannot
# leak into each other or into anything the consumer runs afterwards.
check "the kind is unset again" run bash bashrc '[ -z "${_bash_config_kind:-}" ]'

echo "case 8: sourced twice, each file runs once"
check "the same kind twice is idempotent" bash -c \
  "[ \"\$(env -u PROJECT_PATH _BASH_CONFIG_DIRS='$DIRS' bash -c \
     '_bash_config_kind=bashrc; . \"$INIT\"
      _bash_config_kind=bashrc; . \"$INIT\"
      printf %s \"\$ORDER\"')\" = ' u10 u20 p10' ]"
# The interactive login shape, and the reason the guard key carries the kind: ~/.profile sources
# ~/.bashrc partway through, so the bashrc pass runs first over these same two directories. A
# key of the path alone would mark them done and silently disable every profile_*.sh.
check "then the other kind, over the same two directories, still runs" bash -c \
  "[ \"\$(env -u PROJECT_PATH _BASH_CONFIG_DIRS='$DIRS' bash -c \
     '_bash_config_kind=bashrc; . \"$INIT\"
      _bash_config_kind=profile; . \"$INIT\"
      printf %s \"\$ORDER/\$PORDER\"')\" = ' u10 u20 p10/ u10 p10' ]"
# The same directory reached under two names is one directory — which is what makes the guard
# worth anything at all next to a shell-dirs block naming the workspace path outright.
check "the guard keys on the physical path, through the symlink" bash -c \
  "[ \"\$(env -u PROJECT_PATH _BASH_CONFIG_DIRS='$DIRS' bash -c \
     '_bash_config_kind=bashrc; . \"$INIT\"
      printf %s \"\$_BASH_CONFIG_DONE\"')\" = \
   'bashrc@$DIRS/user:bashrc@$WORK/ws/.devcontainer/shell' ]"
check "the guard is not exported — a child shell starts clean" bash -c \
  "[ \"\$(env -u PROJECT_PATH _BASH_CONFIG_DIRS='$DIRS' bash -c \
     '_bash_config_kind=bashrc; . \"$INIT\"
      bash -c \"printf %s \\\"\\\${_BASH_CONFIG_DONE:-none}\\\"\"')\" = none ]"

echo "case 9: a kind that is neither is a no-op, not a guess"
# An empty kind would glob `_*.sh` and source files nobody named.
check "no kind at all sources nothing" bash -c \
  "[ \"\$(env -u PROJECT_PATH _BASH_CONFIG_DIRS='$DIRS' bash -c \
     '. \"$INIT\"; printf %s \"\${ORDER:-none}\${PORDER:-}\"')\" = none ]"
check "and neither does a misspelled one" bash -c \
  "[ \"\$(env -u PROJECT_PATH _BASH_CONFIG_DIRS='$DIRS' bash -c \
     '_bash_config_kind=bashrcs; . \"$INIT\"; printf %s \"\${ORDER:-none}\"')\" = none ]"

echo "case 10: all of it again under dash — ~/.profile is read by dash, not by bash"
check "the profile kind works" test "$(run dash profile 'printf %s "${PORDER:-}"')" = ' u10 p10'
check "the bashrc kind works too" test "$(run dash bashrc 'printf %s "${ORDER:-}"')" = ' u10 u20 p10'
check "env.sh is sourced" test "$(run dash bashrc 'printf %s "${PROJECT_PATH:-none}"')" = "$WORK/ws"
check "it is silent" test -z "$(run dash profile 'true' 2>&1)"
check "and leaves \$? at 0" run dash profile 'exit $?'
check "no helper function survives" run dash profile \
  '! command -v _bash_config_source_dir > /dev/null'
check "no variables survive" run dash profile \
  '[ -z "${_bash_config_dirs:-}${_bash_config_real:-}${_bash_config_f:-}${_bash_config_kind:-}" ]'
check "the guard still holds" bash -c \
  "[ \"\$(env -u PROJECT_PATH _BASH_CONFIG_DIRS='$DIRS' dash -c \
     '_bash_config_kind=profile; . \"$INIT\"
      _bash_config_kind=profile; . \"$INIT\"
      printf %s \"\$PORDER\"')\" = ' u10 p10' ]"

echo
if [ "$fails" -eq 0 ]; then echo "ALL PASS"; else echo "$fails FAILED"; exit 1; fi
