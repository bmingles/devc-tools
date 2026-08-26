#!/bin/bash
# Exercises the devc:bashrc-additions fence from the devc-config Feature's post-create.sh
# against a temp $HOME, with no container involved. Extracts the block from the real script so
# the test cannot drift from the implementation — same shape as devc_config_test.sh.
#
# Fence extraction alone cannot catch the `exit 0` class of bug (an `exit` inside a fence run in
# its own process looks harmless) or verify that the devc:devc-config and devc:bashrc-additions
# fences actually run in the intended order in *one* process — see the last case below, which
# runs the whole installed post-create.sh instead, the way
# features/git-container-config/test/git_config_test.sh runs the real installed hook.
set -uo pipefail

SCRIPT="${1:?usage: bashrc_additions_test.sh /path/to/post-create.sh}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Pull the block out: everything strictly between the `devc:bashrc-additions` fence markers.
BLOCK="$WORK/block.sh"
awk '/# devc:bashrc-additions \(start\)/{f=1;next} /# devc:bashrc-additions \(end\)/{f=0} f' \
  "$SCRIPT" > "$BLOCK"
grep -q 'devc bashrc-additions' "$BLOCK" || {
  echo "FAIL: could not extract bashrc-additions block"
  exit 1
}

fails=0
check() { # check <desc> <condition-as-args...>
  local desc="$1"
  shift
  if "$@"; then echo "  ok   $desc"; else
    echo "  FAIL $desc"
    fails=$((fails + 1))
  fi
}

MARKER="# >>> devc bashrc-additions >>>"

# Run the fence against $HOME=$1, re-pointing BASHRC= the same way seed_link_test.sh re-points
# SEED=/CLAUDE_DIR= — it must stay a bare assignment at the start of a line for this to work.
run_block() {
  sed -e "s#^BASHRC=.*#BASHRC=$1/.bashrc#" "$BLOCK" > "$WORK/run.sh"
  set +e
  out="$(HOME="$1" bash "$WORK/run.sh" 2>&1)"
  status=$?
  set -e
}

echo "case 1: a fresh \$HOME with no ~/.bashrc gets the block appended"
H="$WORK/c1"
mkdir -p "$H"
run_block "$H"
check "exit 0" test "$status" -eq 0
check "marker present" grep -qF "$MARKER" "$H/.bashrc"
check "PS1 export present" grep -q 'export PS1=' "$H/.bashrc"

echo "case 2: existing ~/.bashrc content is preserved, block appended after it"
H="$WORK/c2"
mkdir -p "$H"
echo "# my own stuff" > "$H/.bashrc"
run_block "$H"
check "exit 0" test "$status" -eq 0
check "original content survives" grep -qF "# my own stuff" "$H/.bashrc"
check "marker present" grep -qF "$MARKER" "$H/.bashrc"

echo "case 3: re-running is idempotent — no double append"
run_block "$H"
check "exit 0" test "$status" -eq 0
check "marker appears exactly once" \
  test "$(grep -cF "$MARKER" "$H/.bashrc")" -eq 1

echo "case 4: DEVC_ATTACH first-prompt-clear guard is carried into the block"
H="$WORK/c4"
mkdir -p "$H"
run_block "$H"
check "exit 0" test "$status" -eq 0
check "DEVC_ATTACH guard present" grep -q 'DEVC_ATTACH' "$H/.bashrc"
check "terminal title trap dropped" grep -q 'trap - DEBUG' "$H/.bashrc"

# --- the one case fence extraction cannot cover -------------------------------------------
#
# Runs the *whole* installed post-create.sh (install.sh's real output, the way
# git_config_test.sh runs the real installed hook), so both fences execute in one process —
# proving they run in the intended order (project hook first, bashrc-additions last) and that
# the devc:bashrc-additions fence's `if` guard (not an `exit 0`) does not cut the file short.
echo "case 5: the whole installed post-create.sh runs both fences, project hook first"
FEATURE_DIR="$(cd "$(dirname "$SCRIPT")" && pwd)"
SHARE_DIR="$WORK/share"
SHARE_DIR="$SHARE_DIR" sh "$FEATURE_DIR/install.sh" > "$WORK/install.log" 2>&1 || {
  echo "  FAIL install.sh failed"
  cat "$WORK/install.log"
  fails=$((fails + 1))
}
INSTALLED="$SHARE_DIR/post-create.sh"

H="$WORK/c5"
PROJECT="$WORK/c5-project"
mkdir -p "$H" "$PROJECT/.devc"
# The hook checks the bashrc marker is NOT yet present when it runs — the only way to observe
# "project hook first" from outside the process.
cat > "$PROJECT/.devc/devc-post-create.sh" <<HOOK
#!/bin/bash
if grep -qF "$MARKER" "$H/.bashrc" 2>/dev/null; then
  echo "bashrc block already present — ran out of order" >&2
  exit 1
fi
touch "$WORK/hook-ran"
HOOK
chmod 755 "$PROJECT/.devc/devc-post-create.sh"

set +e
out="$(HOME="$H" PROJECT_PATH="$PROJECT" bash "$INSTALLED" 2>&1)"
status=$?
set -e
check "exit 0" test "$status" -eq 0
check "project hook ran" test -f "$WORK/hook-ran"
check "bashrc block landed" grep -qF "$MARKER" "$H/.bashrc"

echo
if [ "$fails" -eq 0 ]; then
  echo "all cases ok"
else
  echo "$fails check(s) FAILED"
fi
exit "$fails"
