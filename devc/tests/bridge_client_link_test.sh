#!/bin/bash
# Exercises the PATH-symlink block from bridge-client-link.sh against temp dirs, with no
# container involved. Extracts the block from the real script so the test cannot drift from
# the implementation.
#
# The property under test is that the link is made *unconditionally* — including when the
# mounted client does not exist yet — and that it therefore starts working the moment the
# host installs one, with nothing re-run in the container.
set -uo pipefail

SCRIPT="${1:?usage: bridge_client_link_test.sh /path/to/bridge-client-link.sh}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Pull the block out: everything strictly between the `devc:bridge-client-link` fence markers.
BLOCK="$WORK/block.sh"
awk '/# devc:bridge-client-link \(start\)/{f=1;next} /# devc:bridge-client-link \(end\)/{f=0} f' \
  "$SCRIPT" > "$BLOCK"
grep -q 'ln -sfn' "$BLOCK" || {
  echo "FAIL: could not extract link block"
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

# Run the block with the client/link paths pointed at temp dirs. Sets $status, $out.
# Both are the block's own env overrides, so the real defaults stay in the script.
run_block() { # run_block <client> <link>
  set +e
  out="$(BRIDGE_CLIENT="$1" BRIDGE_LINK="$2" bash "$BLOCK" 2>&1)"
  status=$?
  set -e
}

# A stand-in for the mounted client: a script that prints a known word.
make_client() { # make_client <path> <word>
  mkdir -p "$(dirname "$1")"
  printf '#!/bin/sh\necho %s\n' "$2" > "$1"
  chmod 755 "$1"
}

echo "case 1: link is created even though the client does not exist yet"
R="$WORK/c1"
mkdir -p "$R/bin" "$R/mount"
run_block "$R/mount/devc-bridge" "$R/bin/devc-bridge"
check "exit 0" test "$status" -eq 0
check "symlink exists" test -L "$R/bin/devc-bridge"
check "and it dangles (target absent)" test ! -e "$R/bin/devc-bridge"
check "points at the mounted client path" \
  test "$(readlink "$R/bin/devc-bridge")" = "$R/mount/devc-bridge"

echo "case 2: the dangling link heals when the client appears — no re-run"
# This is the whole reason the link is unconditional: the mount is live, so the host
# installing a client is enough on its own.
make_client "$R/mount/devc-bridge" "pong"
check "link now resolves" test -e "$R/bin/devc-bridge"
check "and executes the client" test "$("$R/bin/devc-bridge")" = "pong"

echo "case 3: idempotent — a second run leaves the same link"
run_block "$R/mount/devc-bridge" "$R/bin/devc-bridge"
check "exit 0" test "$status" -eq 0
check "still a symlink (not a link *inside* the old one)" test -L "$R/bin/devc-bridge"
check "same target" test "$(readlink "$R/bin/devc-bridge")" = "$R/mount/devc-bridge"
check "still executes" test "$("$R/bin/devc-bridge")" = "pong"

echo "case 4: a stale symlink is repointed"
R="$WORK/c4"
mkdir -p "$R/bin" "$R/mount"
make_client "$R/old-client" "stale"
ln -s "$R/old-client" "$R/bin/devc-bridge"
make_client "$R/mount/devc-bridge" "fresh"
run_block "$R/mount/devc-bridge" "$R/bin/devc-bridge"
check "exit 0" test "$status" -eq 0
check "retargeted at the mount" \
  test "$(readlink "$R/bin/devc-bridge")" = "$R/mount/devc-bridge"
check "runs the new client" test "$("$R/bin/devc-bridge")" = "fresh"

echo "case 5: an existing regular file is replaced (no guard, by design)"
# post-create.sh runs the project hook *after* this step, so a project that wants its own
# client at this path still wins on every create — a guard here would only serve a hand
# re-run inside an already running container.
R="$WORK/c5"
mkdir -p "$R/bin" "$R/mount"
make_client "$R/bin/devc-bridge" "project-own"
make_client "$R/mount/devc-bridge" "mounted"
run_block "$R/mount/devc-bridge" "$R/bin/devc-bridge"
check "exit 0" test "$status" -eq 0
check "now a symlink" test -L "$R/bin/devc-bridge"
check "runs the mounted client" test "$("$R/bin/devc-bridge")" = "mounted"

echo
if [ "$fails" -eq 0 ]; then
  echo "all cases ok"
else
  echo "$fails check(s) FAILED"
fi
exit "$fails"
