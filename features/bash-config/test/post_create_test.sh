#!/bin/bash
# post-create.sh — the two things in this Feature that are not constants: the dirs/project
# symlink, and dirs/env.sh.
#
#   bash features/bash-config/test/post_create_test.sh
#
# Offline: the real install.sh installs into a temp SHARE_DIR and a temp HOME, and the real
# post-create.sh runs against it with the cwd the devcontainer CLI would hand it. Nothing here
# is a stand-in — the last case starts a real interactive shell and a real login shell and asks
# what they got.
set -uo pipefail

FEATURE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

fails=0
check() { # check <desc> <condition-as-args...>
  local desc="$1"; shift
  if "$@"; then echo "  ok   $desc"; else echo "  FAIL $desc"; fails=$((fails + 1)); fi
}

# setup <name> [PROJECTDIR=...] — a temp HOME with the Feature installed into it, and a
# workspace holding one script of each kind.
setup() {
  NAME="$1"; shift
  H="$WORK/$NAME/home"; SHARE="$WORK/$NAME/share"; WS="$WORK/$NAME/ws"
  rm -rf "$WORK/$NAME"
  mkdir -p "$H" "$WS/.devcontainer/shell"
  : > "$H/.bashrc"
  echo 'export BASHRC_MARKER=project' > "$WS/.devcontainer/shell/bashrc_10.sh"
  env -u PROJECTDIR SHARE_DIR="$SHARE" _REMOTE_USER_HOME="$H" "$@" \
    sh "$FEATURE_DIR/install.sh" > "$WORK/install.log" 2>&1
  HOOK="$SHARE/post-create.sh"
  DIRS="$SHARE/dirs"
}

# run_hook <cwd> [ENV=val ...] — the hook as the CLI runs it: as the remote user, with the
# workspace folder as its cwd. PROJECT_PATH is unset unless a case sets it, because this
# harness runs inside a devcontainer that has one and inheriting it would silently make every
# case an "already set" case.
run_hook() {
  local cwd="$1"; shift
  ( cd "$cwd" && env -u PROJECT_PATH HOME="$H" SHARE_DIR="$SHARE" "$@" \
      sh "$HOOK" ) > "$WORK/hook.log" 2>&1
  status=$?
}

# probe <bash flags> <var> — what a real shell gets, through a file: `bash -i` without a tty
# writes job-control noise to stderr, and any other startup line is free to print.
probe() {
  rm -f "$WORK/probe"
  env -u PROJECT_PATH _BASH_CONFIG_DIRS="$DIRS" HOME="$H" \
    bash "$1" "printf %s \"\${$2:-none}\" > $WORK/probe" > /dev/null 2>&1
  cat "$WORK/probe" 2> /dev/null
}

echo "case 1: no PROJECT_PATH — the workspace comes from the hook's own cwd"
setup c1
check "before the hook, there is no project directory" test ! -e "$DIRS/project"
check "and a shell gets nothing from it" test "$(probe -ic BASHRC_MARKER)" = none
run_hook "$WS"
check "the hook succeeds" test "$status" -eq 0
check "dirs/project is a symlink" test -L "$DIRS/project"
check "pointing at the workspace's projectDir" \
  test "$(readlink "$DIRS/project")" = "$WS/.devcontainer/shell"
check "and it says where" grep -qF "linked to $WS/.devcontainer/shell" "$WORK/hook.log"
# This is the whole point of the create-time hook: a bare `{}` with no remoteEnv works.
check "a fresh interactive shell now has the bashrc_ file" \
  test "$(probe -ic BASHRC_MARKER)" = project
# The Feature's ceiling: a login shell gets nothing from this Feature at all — no block is
# appended to a login profile.
check "a login shell has none of it" test "$(probe -lc BASHRC_MARKER)" = none

echo "case 2: env.sh — PROJECT_PATH without a remoteEnv, and the guard that keeps one"
check "env.sh was written" test -f "$DIRS/env.sh"
check "with the resolved workspace, guarded" \
  grep -qx "export PROJECT_PATH=\"\${PROJECT_PATH:-$WS}\"" "$DIRS/env.sh"
check "a shell with no PROJECT_PATH gets it" bash -c \
  "[ \"\$(env -u PROJECT_PATH _BASH_CONFIG_DIRS='$DIRS' HOME='$H' \
      bash -ic 'printf %s \"\$PROJECT_PATH\" > $WORK/probe' > /dev/null 2>&1
      cat '$WORK/probe')\" = '$WS' ]"
# An inherited value wins: a consumer who already declared remoteEnv is not overridden by a
# path this hook happened to resolve.
check "an inherited value still wins" bash -c \
  "[ \"\$(env _BASH_CONFIG_DIRS='$DIRS' HOME='$H' PROJECT_PATH=/elsewhere \
      bash -ic 'printf %s \"\$PROJECT_PATH\" > $WORK/probe' > /dev/null 2>&1
      cat '$WORK/probe')\" = /elsewhere ]"

echo "case 3: PROJECT_PATH wins over the cwd when it is set"
setup c3
OTHER="$WORK/c3/other"; mkdir -p "$OTHER/.devcontainer/shell"
echo 'export BASHRC_MARKER=other' > "$OTHER/.devcontainer/shell/bashrc_10.sh"
run_hook "$WS" PROJECT_PATH="$OTHER"
check "the variable is preferred over the cwd" \
  test "$(readlink "$DIRS/project")" = "$OTHER/.devcontainer/shell"
check "and that is what a shell sources" test "$(probe -ic BASHRC_MARKER)" = other
check "env.sh records it too" \
  grep -qx "export PROJECT_PATH=\"\${PROJECT_PATH:-$OTHER}\"" "$DIRS/env.sh"

echo "case 4: cwd is the home folder — decline, do not link \$HOME"
# runLifecycleHook computes `remoteWorkspaceFolder || homeFolder` once for every lifecycle
# command, so this cwd is exactly the branch where there was no workspace folder to be given.
setup c4
run_hook "$H"
check "the hook still exits 0" test "$status" -eq 0
check "nothing was linked" test ! -e "$DIRS/project"
check "and no env.sh claims a workspace that does not exist" test ! -e "$DIRS/env.sh"
check "it says which of the two things to set" bash -c \
  "grep -q 'PROJECT_PATH as remoteEnv' '$WORK/hook.log' &&
   grep -q 'absolute container path' '$WORK/hook.log'"
# The user half is unaffected — dirs/user exists from build time and needs no workspace.
echo 'export USER_MARKER=yes' > "$DIRS/user/bashrc_10.sh"
check "the user directory still works" test "$(probe -ic USER_MARKER)" = yes
# And the documented fix actually fixes it.
run_hook "$H" PROJECT_PATH="$WS"
check "setting PROJECT_PATH resolves it" \
  test "$(readlink "$DIRS/project")" = "$WS/.devcontainer/shell"

echo "case 5: an absolute projectDir needs no workspace at all"
setup c5 PROJECTDIR=/opt/shell.d
run_hook "$H" # the home-folder cwd, i.e. no workspace to be found
check "the hook exits 0" test "$status" -eq 0
check "linked as-is" test "$(readlink "$DIRS/project")" = /opt/shell.d
check "it does not complain" bash -c "! grep -q 'cannot be resolved' '$WORK/hook.log'"
# A path that does not exist yet is a dangling symlink, which init.sh treats as an empty
# directory — and which heals the moment something creates it, with no rebuild.
check "a dangling link is not an error" bash -c \
  "[ -z \"\$(env -u PROJECT_PATH _BASH_CONFIG_DIRS='$DIRS' HOME='$H' bash -lc true 2>&1)\" ]"

echo "case 6: an empty projectDir links nothing, and un-links what was there"
setup c6
run_hook "$WS"
check "the symlink exists to begin with" test -L "$DIRS/project"
# The option is flipped off and the image rebuilt: install.sh rewrites config.sh, and the hook
# has to remove the stale symlink rather than leave the old workspace wired up.
env -u PROJECTDIR SHARE_DIR="$SHARE" _REMOTE_USER_HOME="$H" PROJECTDIR= \
  sh "$FEATURE_DIR/install.sh" > "$WORK/install.log" 2>&1
run_hook "$WS"
check "the hook exits 0" test "$status" -eq 0
check "and the symlink is gone" test ! -e "$DIRS/project"
check "it says so" grep -q 'projectDir is empty' "$WORK/hook.log"
check "a shell sources nothing from the project" test "$(probe -ic BASHRC_MARKER)" = none
# env.sh is not part of the project layer and is written regardless: PROJECT_PATH is useful to
# a user-directory script too.
check "env.sh is still written" test -f "$DIRS/env.sh"

echo "case 7: running it twice changes nothing the second time"
setup c7
run_hook "$WS"
cp "$DIRS/env.sh" "$WORK/c7/env-after-first"
first_link="$(readlink "$DIRS/project")"
run_hook "$WS"
check "the hook exits 0 again" test "$status" -eq 0
check "the symlink is the same" test "$(readlink "$DIRS/project")" = "$first_link"
check "env.sh is byte-identical" cmp -s "$WORK/c7/env-after-first" "$DIRS/env.sh"
check "and dirs/ holds exactly the three expected entries" bash -c \
  "[ \"\$(ls -A '$DIRS' | sort | tr '\\n' ' ')\" = 'env.sh project user ' ]"

echo "case 8: the project directory is live — it is a symlink, not a copy"
setup c8
run_hook "$WS"
echo 'export ADDED_LATER=1' > "$WS/.devcontainer/shell/bashrc_90.sh"
check "a file added after create is picked up by the next shell" \
  test "$(probe -ic ADDED_LATER)" = 1
rm -f "$WS/.devcontainer/shell/bashrc_90.sh"
check "and deleting it stops it being read" test "$(probe -ic ADDED_LATER)" = none
# The hook does not have to run again for either, which is what a copy would have cost.
check "the hook was not re-run" test "$(readlink "$DIRS/project")" = "$WS/.devcontainer/shell"

echo "case 9: nothing here touches the startup files"
# They are static by construction. If this ever stops being true, the whole reason this Feature
# exists in place of shell-dirs has gone with it.
setup c9
cp "$H/.bashrc" "$WORK/c9/bashrc-before"
run_hook "$WS"
check "~/.bashrc is byte-identical after the hook" cmp -s "$WORK/c9/bashrc-before" "$H/.bashrc"
check "and init.sh was not rewritten either" \
  cmp -s "$FEATURE_DIR/init.sh" "$SHARE/init.sh"

echo
if [ "$fails" -eq 0 ]; then echo "ALL PASS"; else echo "$fails FAILED"; exit 1; fi
