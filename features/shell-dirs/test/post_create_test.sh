#!/bin/bash
# post-create.sh — resolving the workspace-relative projectDir into the ~/.bashrc block.
#
#   bash features/shell-dirs/test/post_create_test.sh
#
# This is the step that removes $PROJECT_PATH as a *prerequisite*: install.sh cannot know the
# workspace path at image build time, so it writes a block that defers to that variable, and
# this hook replaces the deferral with a real path at create time. Offline — the real
# install.sh writes a real ~/.bashrc into a temp HOME, and the real post-create.sh rewrites it.
set -uo pipefail

FEATURE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

fails=0
check() { # check <desc> <condition-as-args...>
  local desc="$1"; shift
  if "$@"; then echo "  ok   $desc"; else echo "  FAIL $desc"; fails=$((fails + 1)); fi
}

# setup <name> [PROJECTDIR=... ] — a fresh temp HOME with the Feature installed into it, and
# post-create.sh staged the way install.sh stages it (options baked in).
setup() {
  NAME="$1"; shift
  H="$WORK/$NAME/home"; SHARE="$WORK/$NAME/share"; WS="$WORK/$NAME/ws"
  rm -rf "$WORK/$NAME"; mkdir -p "$H" "$WS/.devcontainer/shell"; : > "$H/.bashrc"
  echo 'export MARKER=project' > "$WS/.devcontainer/shell/10-a.sh"
  env -u PROJECTDIR -u USERDIR SHARE_DIR="$SHARE" _REMOTE_USER_HOME="$H" "$@" \
    sh "$FEATURE_DIR/install.sh" > "$WORK/install.log" 2>&1
  HOOK="$SHARE/post-create.sh"
}

# run_hook <cwd> [ENV=val ...] — the hook as the CLI runs it: cwd is the workspace folder.
# PROJECT_PATH is unset unless a case sets it. This harness runs inside a devcontainer that has
# its own PROJECT_PATH, and inheriting it would silently make every case a "variable is set" case.
run_hook() {
  local cwd="$1"; shift
  ( cd "$cwd" && env -u PROJECT_PATH HOME="$H" _SHELL_DIRS_BASHRC="$H/.bashrc" "$@" \
      bash "$HOOK" ) > "$WORK/hook.log" 2>&1
  status=$?
}

assigned() { grep -m1 '^PROJECT_SHELL_DIR=' "$H/.bashrc"; }

# sourced <extra-env...> — what a shell gets from the block as it now stands.
sourced() {
  awk '/# devc:shell-dirs \(start\)/{f=1;next} /# devc:shell-dirs \(end\)/{f=0} f' \
    "$H/.bashrc" > "$WORK/block.sh"
  env -u PROJECT_PATH "$@" bash -c ". '$WORK/block.sh'; printf %s \"\${MARKER:-}\""
}

echo "case 1: the hook installs, and is the file the manifest names"
setup c1
check "install.sh placed post-create.sh" test -f "$HOOK"
check "and made it executable" test -x "$HOOK"
check "with projectDir baked in" grep -qx 'PROJECT_DIR=".devcontainer/shell"' "$HOOK"
# The manifest calls an absolute path, so the two must agree or the hook silently never runs.
check "the manifest's postCreateCommand names where install.sh puts it" bash -c \
  "grep -q '/usr/local/share/devc-features/shell-dirs/post-create.sh' \
     '$FEATURE_DIR/devcontainer-feature.json'"

echo "case 2: no PROJECT_PATH — the workspace comes from the hook's cwd"
setup c2
check "before: the block defers to PROJECT_PATH" \
  test "$(assigned)" = 'PROJECT_SHELL_DIR="${PROJECT_PATH:+$PROJECT_PATH/.devcontainer/shell}"'
check "a shell with no PROJECT_PATH gets nothing" test "$(sourced)" = ''
run_hook "$WS"
check "the hook succeeds" test "$status" -eq 0
check "after: an absolute path, resolved from the cwd" \
  test "$(assigned)" = "PROJECT_SHELL_DIR=\"$WS/.devcontainer/shell\""
# This is the whole point of the change: a bare `{}` with no remoteEnv now works.
check "and a shell with no PROJECT_PATH now sources the layer" test "$(sourced)" = project
check "the hook says what it resolved" grep -q "resolved to $WS/.devcontainer/shell" \
  "$WORK/hook.log"

echo "case 3: PROJECT_PATH still wins when it is set"
setup c3
OTHER="$WORK/c3/other"; mkdir -p "$OTHER/.devcontainer/shell"
echo 'export MARKER=other' > "$OTHER/.devcontainer/shell/10-a.sh"
run_hook "$WS" PROJECT_PATH="$OTHER"
check "the variable is preferred over the cwd" \
  test "$(assigned)" = "PROJECT_SHELL_DIR=\"$OTHER/.devcontainer/shell\""
check "and that is the layer a shell gets" test "$(sourced)" = other

echo "case 4: cwd is the home folder — decline, do not bake \$HOME"
# runLifecycleHook uses `remoteWorkspaceFolder || homeFolder`, so this cwd is exactly the
# branch where there is no workspace folder. Baking it would point the layer at ~/.
setup c4
run_hook "$H"
check "the hook still exits 0" test "$status" -eq 0
check "the block is left deferring to PROJECT_PATH" \
  test "$(assigned)" = 'PROJECT_SHELL_DIR="${PROJECT_PATH:+$PROJECT_PATH/.devcontainer/shell}"'
check "nothing under \$HOME was baked in" bash -c "! grep -q \"^PROJECT_SHELL_DIR=\\\"$H\" '$H/.bashrc'"
check "and it says which of the two things to set" bash -c \
  "grep -q 'PROJECT_PATH as remoteEnv' '$WORK/hook.log' &&
   grep -q 'absolute container path' '$WORK/hook.log'"
check "PROJECT_PATH still works at shell time" test "$(sourced PROJECT_PATH="$WS")" = project

echo "case 5: an absolute projectDir is left alone"
setup c5 PROJECTDIR=/opt/shell.d
run_hook "$WS"
check "the hook exits 0" test "$status" -eq 0
check "the assignment is untouched" test "$(assigned)" = 'PROJECT_SHELL_DIR="/opt/shell.d"'
check "and it stays quiet about it" test ! -s "$WORK/hook.log"

echo "case 6: an empty projectDir is left alone"
setup c6 PROJECTDIR=
run_hook "$WS"
check "the hook exits 0" test "$status" -eq 0
check "the layer stays disabled" test "$(assigned)" = 'PROJECT_SHELL_DIR=""'
check "and it stays quiet about it" test ! -s "$WORK/hook.log"

echo "case 7: running it twice changes nothing the second time"
setup c7
run_hook "$WS"
cp "$H/.bashrc" "$WORK/c7/after-first"
run_hook "$WS"
check "the hook exits 0 again" test "$status" -eq 0
check "~/.bashrc is byte-identical" cmp -s "$WORK/c7/after-first" "$H/.bashrc"

echo "case 8: only this Feature's block is rewritten"
# The interim case: a devc container carries devc's own devc:shell-dirs block too, and it is
# not ours to edit. An unscoped /^PROJECT_SHELL_DIR=/ would rewrite both.
setup c8
DEVC_LINE='PROJECT_SHELL_DIR="${PROJECT_PATH:+$PROJECT_PATH/.devcontainer/shell}"'
{ echo '# devc:shell-dirs (start)'
  echo 'USER_SHELL_DIR=/usr/local/share/devc/shell'
  echo "$DEVC_LINE"
  echo '# devc:shell-dirs (end)'
} > "$WORK/c8/devc-block"
cat "$H/.bashrc" >> "$WORK/c8/devc-block"
cp "$WORK/c8/devc-block" "$H/.bashrc"
run_hook "$WS"
check "the hook succeeds" test "$status" -eq 0
check "devc's copy still defers to PROJECT_PATH" test "$(assigned)" = "$DEVC_LINE"
check "and the Feature's copy was resolved" bash -c \
  "[ \"\$(grep -c '^PROJECT_SHELL_DIR=' '$H/.bashrc')\" = 2 ] &&
   grep -qxF 'PROJECT_SHELL_DIR=\"$WS/.devcontainer/shell\"' '$H/.bashrc'"

echo "case 9: no block in ~/.bashrc is a silent no-op"
setup c9
: > "$H/.bashrc"
run_hook "$WS"
check "the hook exits 0" test "$status" -eq 0
check "and wrote nothing" test ! -s "$H/.bashrc"

echo "case 10: ~/.bashrc keeps its identity across the rewrite"
# The hook runs as the remote user on their own file; a replaced file would be theirs by luck.
setup c10
before_inode="$(stat -c '%i' "$H/.bashrc")"
before_mode="$(stat -c '%a' "$H/.bashrc")"
run_hook "$WS"
check "same inode" test "$(stat -c '%i' "$H/.bashrc")" = "$before_inode"
check "same mode" test "$(stat -c '%a' "$H/.bashrc")" = "$before_mode"
check "no temp file left behind" bash -c "! ls '$H'/.bashrc.shell-dirs.* > /dev/null 2>&1"

echo
if [ "$fails" -eq 0 ]; then echo "ALL PASS"; else echo "$fails FAILED"; exit 1; fi
