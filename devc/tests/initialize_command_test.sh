#!/bin/bash
# Exercises the devc-bridge mount-source block from initialize-command.sh against a temp
# HOME, with no container involved. Extracts the block from the real script so the test
# cannot drift from the implementation.
#
# The property under test is create-if-missing. This script runs on the host before *every*
# `up`, so an unconditional write would clobber the real client the bridge installed into
# the mounted dir — the placeholder exists only to keep the container's PATH symlink
# resolving while there is no client yet.
set -uo pipefail

SCRIPT="${1:?usage: initialize_command_test.sh /path/to/initialize-command.sh}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Pull the block out: everything strictly between the `devc:bridge-placeholder` fence markers.
BLOCK="$WORK/block.sh"
awk '/# devc:bridge-placeholder \(start\)/{f=1;next} /# devc:bridge-placeholder \(end\)/{f=0} f' \
  "$SCRIPT" > "$BLOCK"
grep -q 'devc-bridge/client' "$BLOCK" || {
  echo "FAIL: could not extract bridge-placeholder block"
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

# Run the block against a temp HOME. Sets $status, $out. The block derives every path from
# $HOME, so overriding that is enough — the real derivation is exercised, not patched out.
run_block() { # run_block <home>
  set +e
  out="$(HOME="$1" bash "$BLOCK" 2>&1)"
  status=$?
  set -e
}

echo "case 1: a host that has never installed the bridge gets both mount sources"
H="$WORK/c1"
mkdir -p "$H"
run_block "$H"
PLACEHOLDER="$H/.config/devc-bridge/client/devc-bridge"
check "exit 0" test "$status" -eq 0
check "run/ created (the token mount source)" test -d "$H/.config/devc-bridge/run"
check "client/ created (the client mount source)" test -d "$H/.config/devc-bridge/client"
check "placeholder created" test -f "$PLACEHOLDER"
check "placeholder is mode 0755" test "$(stat -c '%a' "$PLACEHOLDER" 2>/dev/null ||
  stat -f '%Lp' "$PLACEHOLDER")" = "755"

echo "case 2: the placeholder is a runnable command-not-found stand-in"
set +e
pout="$(sh "$PLACEHOLDER" 2>&1 >/dev/null)"
pstatus=$?
pstdout="$(sh "$PLACEHOLDER" 2>/dev/null)"
set -e
check "exits 127 (the shell's own command-not-found code)" test "$pstatus" -eq 127
check "explains itself on stderr" grep -q 'no client binary' <<< "$pout"
check "writes nothing to stdout" test -z "$pstdout"

echo "case 3: an existing client is NOT touched (this runs before every \`up\`)"
H="$WORK/c3"
CLIENT="$H/.config/devc-bridge/client/devc-bridge"
mkdir -p "$H/.config/devc-bridge/client"
printf 'REAL CLIENT BINARY\n' > "$CLIENT"
chmod 700 "$CLIENT"
before="$(cksum < "$CLIENT")"
before_mode="$(stat -c '%a' "$CLIENT" 2>/dev/null || stat -f '%Lp' "$CLIENT")"
run_block "$H"
check "exit 0" test "$status" -eq 0
check "contents unchanged" test "$(cksum < "$CLIENT")" = "$before"
check "mode unchanged (not re-chmodded)" \
  test "$(stat -c '%a' "$CLIENT" 2>/dev/null || stat -f '%Lp' "$CLIENT")" = "$before_mode"

echo "case 4: idempotent — a second run on a placeholder-only host changes nothing"
H="$WORK/c4"
mkdir -p "$H"
run_block "$H"
P="$H/.config/devc-bridge/client/devc-bridge"
before="$(cksum < "$P")"
run_block "$H"
check "exit 0" test "$status" -eq 0
check "placeholder unchanged" test "$(cksum < "$P")" = "$before"

echo
if [ "$fails" -eq 0 ]; then
  echo "all cases ok"
else
  echo "$fails check(s) FAILED"
fi
exit "$fails"
