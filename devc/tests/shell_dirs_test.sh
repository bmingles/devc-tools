#!/bin/bash
# Exercises the two-layer shell customization block from bashrc-additions.sh against temp
# dirs, with no container involved. Extracts the block from the real script so the test
# cannot drift from the implementation.
set -euo pipefail

SCRIPT="${1:?usage: shell_dirs_test.sh /path/to/bashrc-additions.sh}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Pull the block out: everything strictly between the `devc:shell-dirs` fence markers.
BLOCK="$WORK/block.sh"
awk '/# devc:shell-dirs \(start\)/{f=1;next} /# devc:shell-dirs \(end\)/{f=0} f' "$SCRIPT" \
  > "$BLOCK"
grep -q '_devc_source_shell_dir' "$BLOCK" || {
  echo "FAIL: could not extract shell-dirs block"; exit 1; }

fails=0
check() { # check <desc> <condition-as-args...>
  local desc="$1"; shift
  if "$@"; then echo "  ok   $desc"; else echo "  FAIL $desc"; fails=$((fails + 1)); fi
}

# Run the block with both layers re-pointed at temp dirs, capturing what the sourced files
# did. ORDER accumulates a marker per sourced file so ordering is observable; RESULT holds the
# final value of anything the layers assigned.
run_block() { # run_block <user-dir> <project-dir>
  ( sed -e "s#^USER_SHELL_DIR=.*#USER_SHELL_DIR='$1'#" \
        -e "s#^PROJECT_SHELL_DIR=.*#PROJECT_SHELL_DIR='$2'#" "$BLOCK" > "$WORK/run.sh"
    cat > "$WORK/harness.sh" <<'EOF'
ORDER=""
. "$WORK/run.sh"
printf '%s\n' "$ORDER" > "$WORK/order.txt"
printf '%s\n' "${RESULT:-<unset>}" > "$WORK/result.txt"
declare -F _devc_source_shell_dir >/dev/null && echo "leaked-fn" >> "$WORK/leaks.txt"
[ -n "${USER_SHELL_DIR:-}${PROJECT_SHELL_DIR:-}" ] && echo "leaked-var" >> "$WORK/leaks.txt"
exit 0
EOF
    WORK="$WORK" bash "$WORK/harness.sh" >"$WORK/out.log" 2>&1 ) || {
      echo "  FAIL block exited nonzero"; cat "$WORK/out.log"; fails=$((fails + 1)); }
}

order() { cat "$WORK/order.txt"; }
result() { cat "$WORK/result.txt"; }

echo "case 1: both layers sourced, user before project"
U="$WORK/c1/user"; P="$WORK/c1/proj"; mkdir -p "$U" "$P"
echo 'ORDER="$ORDER user"; RESULT=user' > "$U/10-a.sh"
echo 'ORDER="$ORDER proj"; RESULT=project' > "$P/10-a.sh"
run_block "$U" "$P"
check "user layer ran, then project layer" test "$(order)" = " user proj"
check "project wins on conflict" test "$(result)" = "project"

echo "case 2: multiple files in a layer run in name order"
U="$WORK/c2/user"; P="$WORK/c2/proj"; mkdir -p "$U" "$P"
echo 'ORDER="$ORDER u20"' > "$U/20-second.sh"
echo 'ORDER="$ORDER u10"' > "$U/10-first.sh"
echo 'ORDER="$ORDER p05"' > "$P/05-only.sh"
run_block "$U" "$P"
check "sorted within a layer, layers still ordered" test "$(order)" = " u10 u20 p05"

echo "case 3: non-.sh files are ignored"
U="$WORK/c3/user"; P="$WORK/c3/proj"; mkdir -p "$U" "$P"
echo 'ORDER="$ORDER yes"' > "$U/10-yes.sh"
echo 'ORDER="$ORDER no"' > "$U/README.md"
echo 'ORDER="$ORDER no"' > "$U/notes.txt"
run_block "$U" "$P"
check "only *.sh sourced" test "$(order)" = " yes"

echo "case 4: empty and missing directories are no-ops"
U="$WORK/c4/user"; P="$WORK/c4/proj"; mkdir -p "$U"   # P deliberately absent
run_block "$U" "$P"
check "empty user dir + missing project dir is silent" test "$(order)" = ""
check "no error output" test ! -s "$WORK/out.log"

echo "case 5: unset project layer (no PROJECT_PATH) is a no-op"
U="$WORK/c5/user"; mkdir -p "$U"
echo 'ORDER="$ORDER user"' > "$U/10-a.sh"
run_block "$U" ""
check "empty PROJECT_SHELL_DIR skipped, user layer still runs" test "$(order)" = " user"
check "no error output" test ! -s "$WORK/out.log"

echo "case 6: a subdirectory in a layer is not sourced"
U="$WORK/c6/user"; P="$WORK/c6/proj"; mkdir -p "$U/nested.sh" "$P"
echo 'ORDER="$ORDER real"' > "$U/10-real.sh"
run_block "$U" "$P"
check "directory named *.sh skipped" test "$(order)" = " real"

echo "case 7: the block leaves no helper function or vars behind"
U="$WORK/c7/user"; P="$WORK/c7/proj"; mkdir -p "$U" "$P"
rm -f "$WORK/leaks.txt"
run_block "$U" "$P"
check "no leaked function or variables" test ! -f "$WORK/leaks.txt"

echo
if [ "$fails" -eq 0 ]; then echo "ALL PASS"; else echo "$fails FAILED"; exit 1; fi
