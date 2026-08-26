#!/bin/bash
# agents offline harness — the ownership-repair and ~/.claude.json steps of the real
# post-create.sh, run against a temp HOME with `stat` and `sudo` stubbed on PATH. No Docker, no
# root, no network:
#
#   bash features/agents/test/claude_json_test.sh
#
# The devc:seed-link step in the middle of the same file is NOT re-tested here — that block is
# copied verbatim from devc-core/default/scripts/agents-setup.sh and is exercised by
# devc/tests/seed_link_test.sh against both copies; this file covers only the two steps that are
# this Feature's own.
#
# The real install.sh installs the real post-create.sh into a temp SHARE_DIR first (with the CLI
# installs turned off — this file is not testing those), so the hook under test cannot drift from
# what install.sh actually produces.
#
# Both paths the hook uses are now derived, not baked: CLAUDE_DIR is "$HOME/.claude", so a case
# is set up purely by pointing HOME at a temp directory. Only SEED is rewritten below, and only
# to keep a machine that really does have the Feature installed from linking its own seed in.
set -uo pipefail

FEATURE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

fails=0
check() { # check <desc> <condition-as-args...>
  local desc="$1"; shift
  if "$@"; then echo "  ok   $desc"; else echo "  FAIL $desc"; fails=$((fails + 1)); fi
}

# --- stubs -------------------------------------------------------------------------------------
STUBS="$WORK/stubs"
mkdir -p "$STUBS"

# `stat -c '%U' <path>` — reports whichever owner this case wants ($STAT_OWNER), regardless of
# the real filesystem owner (which, unprivileged, is always the test runner).
cat > "$STUBS/stat" << 'STAT'
#!/bin/sh
echo "$STAT_OWNER"
STAT
chmod +x "$STUBS/stat"

# Logs every invocation, then really runs the command (a real chown to the test runner's own
# user succeeds unprivileged, since it is a no-op chown).
cat > "$STUBS/sudo" << 'SUDO'
#!/bin/sh
echo "sudo $*" >> "$SUDO_LOG"
"$@"
SUDO
chmod +x "$STUBS/sudo"

# A PATH with no `sudo` on it at all, built from real binaries by name rather than by directory —
# the real sudo very likely shares a directory with the coreutils the hook also needs, so
# excluding a directory would take those with it. Includes the stat stub.
NOSUDO="$WORK/nosudo-path"
mkdir -p "$NOSUDO"
for tool in bash sh id chown rm ln mv cat find grep sed mkdir dirname basename readlink env \
  true false printf; do
  p="$(command -v "$tool" 2> /dev/null)" || continue
  ln -sf "$p" "$NOSUDO/$tool"
done
cp "$STUBS/stat" "$NOSUDO/stat"
chmod +x "$NOSUDO/stat"

# --- install the real hook once, CLI installs off (not what this file tests) -------------------
SHARE="$WORK/share"
env -u INSTALLCLAUDECLI -u INSTALLCOPILOTCLI \
  SHARE_DIR="$SHARE" INSTALLCLAUDECLI=false _REMOTE_USER="$(id -un)" \
  _REMOTE_USER_HOME="$WORK/dummy-home" \
  sh "$FEATURE_DIR/install.sh" > "$WORK/install.log" 2>&1 ||
  { echo "FAIL: could not install the real post-create.sh"; cat "$WORK/install.log"; exit 1; }
HOOK="$SHARE/post-create.sh"

# run_hook <case-dir> [STAT_OWNER] [no-sudo] — HOME is "$dir/home", so CLAUDE_DIR resolves to
# "$dir/home/.claude" on its own. SEED is pointed at a path that does not exist, so the
# seed-link step in the middle is a no-op for every case here.
run_hook() {
  local dir="$1" owner="${2:-}" mode="${3:-}"
  mkdir -p "$dir"
  sed -e "s#^SEED=.*#SEED=$dir/no-such-seed#" "$HOOK" > "$dir/hook.sh"
  local hook_path
  if [ "$mode" = no-sudo ]; then hook_path="$NOSUDO"; else hook_path="$STUBS:$PATH"; fi
  ( env -i HOME="$dir/home" PATH="$hook_path" STAT_OWNER="$owner" \
      SUDO_LOG="$dir/sudo.log" bash "$dir/hook.sh" ) \
    > "$dir/out.log" 2> "$dir/err.log"
  status=$?
}

echo "case 1: nothing in place yet — .claude.json seeded inside ~/.claude and symlinked"
D="$WORK/c1"; mkdir -p "$D/home"
run_hook "$D"
check "the hook exits 0" test "$status" -eq 0
check "the backing file is seeded with {}" test "$(cat "$D/home/.claude/.claude.json")" = '{}'
check "~/.claude.json is a symlink" test -L "$D/home/.claude.json"
check "it points inside ~/.claude" \
  test "$(readlink "$D/home/.claude.json")" = "$D/home/.claude/.claude.json"
check "reading through the link gives {}" test "$(cat "$D/home/.claude.json")" = '{}'

echo "case 2: a plain pre-existing ~/.claude.json is MOVED in, not deleted"
D="$WORK/c2"; mkdir -p "$D/home"
echo '{"auth":"do not lose me"}' > "$D/home/.claude.json"
run_hook "$D"
check "the hook exits 0" test "$status" -eq 0
check "it is now a symlink" test -L "$D/home/.claude.json"
check "the original content survived the move" \
  test "$(cat "$D/home/.claude/.claude.json")" = '{"auth":"do not lose me"}'
check "and reads back through the link" \
  test "$(cat "$D/home/.claude.json")" = '{"auth":"do not lose me"}'

echo "case 3: backing file already has content — not clobbered, still linked"
D="$WORK/c3"; mkdir -p "$D/home/.claude"
echo '{"auth":"token"}' > "$D/home/.claude/.claude.json"
run_hook "$D"
check "the hook exits 0" test "$status" -eq 0
check "existing content survives" \
  test "$(cat "$D/home/.claude/.claude.json")" = '{"auth":"token"}'
check "the symlink was still created" test -L "$D/home/.claude.json"

echo "case 4: idempotent — a second run does not re-link or re-seed"
D="$WORK/c4"; mkdir -p "$D/home"
run_hook "$D"
echo '{"changed":"by claude code itself"}' > "$D/home/.claude/.claude.json"
run_hook "$D"
check "the second run exits 0" test "$status" -eq 0
check "the symlink is untouched (still the same target)" \
  test "$(readlink "$D/home/.claude.json")" = "$D/home/.claude/.claude.json"
check "edits since the first run survive — not re-seeded over" \
  test "$(cat "$D/home/.claude/.claude.json")" = '{"changed":"by claude code itself"}'

echo "case 5: a link left by an older version pointing elsewhere is repointed, not kept"
D="$WORK/c5"; mkdir -p "$D/home" "$D/oldvol"
echo '{"old":"volume"}' > "$D/oldvol/claude.json"
ln -s "$D/oldvol/claude.json" "$D/home/.claude.json"
run_hook "$D"
check "the hook exits 0" test "$status" -eq 0
check "the link now points inside ~/.claude" \
  test "$(readlink "$D/home/.claude.json")" = "$D/home/.claude/.claude.json"
check "the old backing file is left on disk, not deleted" \
  test "$(cat "$D/oldvol/claude.json")" = '{"old":"volume"}'

echo "case 6: ownership repair — ~/.claude owned by someone else, sudo present"
D="$WORK/c6"; mkdir -p "$D/home/.claude"
run_hook "$D" someoneelse
check "the hook exits 0" test "$status" -eq 0
check "sudo chown was invoked" grep -q "chown $(id -un) $D/home/.claude" "$D/sudo.log"

echo "case 7: ownership repair — already owned by the current user, no chown attempted"
D="$WORK/c7"; mkdir -p "$D/home/.claude"
run_hook "$D" "$(id -un)"
check "the hook exits 0" test "$status" -eq 0
check "no sudo invocation happened" test ! -s "$D/sudo.log"

echo "case 8: owner differs, no sudo on PATH — warns, still exits 0 and still links"
D="$WORK/c8"; mkdir -p "$D/home/.claude"
run_hook "$D" someoneelse no-sudo
check "the hook still exits 0" test "$status" -eq 0
check "it warns that no sudo is available" grep -q 'no sudo is available' "$D/err.log"
check "the symlink was still created — chown is best-effort, not required" \
  test -L "$D/home/.claude.json"
check "and it reads back {}" test "$(cat "$D/home/.claude.json")" = '{}'

echo "case 9: an unwritable ~/.claude warns and still exits 0 — never aborts create"
D="$WORK/c9"; mkdir -p "$D/home/.claude"
chmod 500 "$D/home/.claude"
run_hook "$D" "$(id -un)"
chmod 700 "$D/home/.claude"
check "the hook still exits 0" test "$status" -eq 0
check "it warns rather than failing the container" grep -q 'could not' "$D/err.log"

echo "case 10: a ~/.claude.json that is a directory warns and still exits 0"
D="$WORK/c10"; mkdir -p "$D/home/.claude.json"
run_hook "$D"
check "the hook still exits 0" test "$status" -eq 0
check "the directory was not clobbered" test -d "$D/home/.claude.json"
check "no link was created inside it — ln -sfn would have done exactly that" \
  test ! -e "$D/home/.claude.json/.claude.json"
check "it warns and says why" grep -q 'is a directory' "$D/err.log"

echo
if [ "$fails" -eq 0 ]; then echo "ALL PASS"; else echo "$fails FAILED"; exit 1; fi
