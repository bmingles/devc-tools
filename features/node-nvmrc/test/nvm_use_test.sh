#!/bin/bash
# Exercises the `devc:nvm-use` block from the Feature's install.sh against temp dirs, with no
# container involved. Extracts the block from the real script so the test cannot drift from
# what actually lands in a user's ~/.bashrc — the technique devc/tests/shell_dirs_test.sh uses.
#
# The properties under test are the two places this block deliberately differs from the devc
# copy it was taken from, both forced by not knowing whose shell it is in:
#
#   1. With NO nvm anywhere, the block is inert. devc's copy redefines `cd` unconditionally,
#      which in an image without nvm leaves every directory change calling a missing command.
#   2. The block never leaves a non-zero $? behind. It is the last thing ~/.bashrc runs, and a
#      consumer's prompt may report exit status — devc's own only colors it.
#
# And the thing both copies must do: `nvm use` fires on entering a directory with a .nvmrc, and
# only then.
#
#   bash features/node-nvmrc/test/nvm_use_test.sh [path/to/install.sh]
set -uo pipefail

SCRIPT="${1:-$(cd "$(dirname "$0")/.." && pwd)/install.sh}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Pull the block out: everything strictly between the `devc:nvm-use` fence markers.
BLOCK="$WORK/block.sh"
awk '/# devc:nvm-use \(start\)/{f=1;next} /# devc:nvm-use \(end\)/{f=0} f' "$SCRIPT" > "$BLOCK"
grep -q 'builtin cd' "$BLOCK" || {
  echo "FAIL: could not extract nvm-use block from $SCRIPT"
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

# A stand-in for nvm.sh: defines `nvm` as a shell function, which is what the real one does and
# what the block's `command -v nvm` guard has to see. Every call is logged with the directory it
# was made from, so "did it fire, and where" is observable.
make_nvm() { # make_nvm <nvm-dir>
  mkdir -p "$1"
  cat > "$1/nvm.sh" << 'EOF'
nvm() { printf '%s|%s\n' "$*" "$PWD" >> "$NVM_LOG"; }
EOF
}

# Source the block in a fresh bash with NVM_DIR pointed somewhere, then run <after> in the same
# shell. Fills $WORK/{src_status,log,err,out}; sets $status to the whole run's exit code.
run() { # run <nvm-dir> <start-dir> <after>
  : > "$WORK/log"
  cat > "$WORK/harness.sh" << EOF
cd "$2" || exit 90
export NVM_LOG="$WORK/log"
NVM_DIR="$1"
. "$BLOCK"
printf '%s\n' "\$?" > "$WORK/src_status"
$3
EOF
  bash "$WORK/harness.sh" > "$WORK/out" 2> "$WORK/err"
  status=$?
}

src_status() { cat "$WORK/src_status"; }
log() { cat "$WORK/log"; }
out() { cat "$WORK/out"; }

# Two workspaces: one pinning a version, one pinning nothing.
PINNED="$WORK/pinned"
PLAIN="$WORK/plain"
mkdir -p "$PINNED" "$PLAIN"
echo '22' > "$PINNED/.nvmrc"

NVM="$WORK/nvm"
make_nvm "$NVM"
NO_NVM="$WORK/empty" # exists, but has no nvm.sh — the "image never heard of nvm" case
mkdir -p "$NO_NVM"

echo 'case 1: nvm present, shell starts in a directory with no .nvmrc'
run "$NVM" "$PLAIN" '
  cd "'"$PINNED"'"; echo "cd-into-pinned:$?"
  cd "'"$PLAIN"'";  echo "cd-into-plain:$?"
'
check 'run exits 0' test "$status" -eq 0
check '$? is 0 immediately after sourcing' test "$(src_status)" = 0
check 'nothing selected at shell start (no .nvmrc there)' \
  test "$(grep -c . "$WORK/log")" -eq 1
check 'cd into a .nvmrc directory ran `nvm use --silent` there' \
  test "$(head -1 "$WORK/log")" = "use --silent|$PINNED"
check 'cd into a directory without .nvmrc ran nothing more' \
  test "$(grep -c . "$WORK/log")" -eq 1
check 'cd into a .nvmrc directory returns 0' \
  test "$(grep -c '^cd-into-pinned:0$' "$WORK/out")" -eq 1
# The whole reason for the explicit `return 0` in the override: devc's one-liner returns 1 here,
# so `cd somewhere && make` silently stops running make.
check 'cd into a directory WITHOUT .nvmrc also returns 0' \
  test "$(grep -c '^cd-into-plain:0$' "$WORK/out")" -eq 1
check 'no stderr' test ! -s "$WORK/err"

echo 'case 2: nvm present, shell starts in a directory that has a .nvmrc'
run "$NVM" "$PINNED" ''
check 'run exits 0' test "$status" -eq 0
check '$? is 0 immediately after sourcing' test "$(src_status)" = 0
check 'the pinned version was selected at shell start' \
  test "$(log)" = "use --silent|$PINNED"
check 'no stderr' test ! -s "$WORK/err"

echo 'case 3: no nvm at all — the block is inert and cd still works'
run "$NO_NVM" "$PLAIN" '
  declare -F cd > /dev/null && echo "cd-overridden"
  cd "'"$PINNED"'"; echo "cd-status:$?"
  echo "pwd:$PWD"
'
check 'run exits 0' test "$status" -eq 0
check '$? is 0 immediately after sourcing' test "$(src_status)" = 0
check 'cd was NOT overridden' test "$(grep -c '^cd-overridden$' "$WORK/out")" -eq 0
check 'cd into a .nvmrc directory still returns 0' \
  test "$(grep -c '^cd-status:0$' "$WORK/out")" -eq 1
check 'and actually changed directory' test "$(grep '^pwd:' "$WORK/out")" = "pwd:$PINNED"
check 'nothing was logged' test ! -s "$WORK/log"
check 'no stderr' test ! -s "$WORK/err"

echo 'case 4: no nvm, shell starts in a .nvmrc directory — still silent, still 0'
run "$NO_NVM" "$PINNED" ''
check 'run exits 0' test "$status" -eq 0
check '$? is 0 immediately after sourcing' test "$(src_status)" = 0
check 'no stderr' test ! -s "$WORK/err"

echo 'case 5: a failing cd still fails, and does not select anything'
run "$NVM" "$PLAIN" '
  cd "'"$WORK"'/does-not-exist" 2>/dev/null; echo "cd-status:$?"
  echo "pwd:$PWD"
'
check 'run exits 0' test "$status" -eq 0
check 'cd into a missing directory returns non-zero' \
  test "$(grep -c '^cd-status:0$' "$WORK/out")" -eq 0
check 'and the shell stayed put' test "$(grep '^pwd:' "$WORK/out")" = "pwd:$PLAIN"
check 'nothing was selected' test ! -s "$WORK/log"

echo 'case 6: `cd` with no arguments still goes home'
run "$NVM" "$PLAIN" '
  HOME="'"$PINNED"'"
  cd; echo "cd-status:$?"
  echo "pwd:$PWD"
'
check 'cd with no args returns 0' test "$(grep -c '^cd-status:0$' "$WORK/out")" -eq 1
check 'and landed in $HOME' test "$(grep '^pwd:' "$WORK/out")" = "pwd:$PINNED"
check 'selecting fired there too' test "$(log)" = "use --silent|$PINNED"

echo 'case 7: install.sh can still bake nvmDir into the block'
# install.sh rewrites this line to the configured directory and fails the build if the rewrite
# does not take. That check only runs inside a container build, so pin the shape offline too —
# a reformat here would otherwise be found by nobody until a release.
check 'the block has an `export NVM_DIR=` line for install.sh to rewrite' \
  grep -qE '^export NVM_DIR=' "$BLOCK"
check 'and it defaults to the upstream node Feature location, not a devc path' \
  grep -qF 'export NVM_DIR="${NVM_DIR:-/usr/local/share/nvm}"' "$BLOCK"

echo
if [ "$fails" -eq 0 ]; then
  echo "all cases ok"
else
  echo "$fails check(s) FAILED"
fi
exit "$fails"
