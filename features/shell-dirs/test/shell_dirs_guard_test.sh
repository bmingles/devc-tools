#!/bin/bash
# The `_DEVC_SHELL_DIRS_DONE` skip-guard — the one behavior this Feature's copy of the
# `devc:shell-dirs` block has that devc's copy does not.
#
#   bash features/shell-dirs/test/shell_dirs_guard_test.sh
#
# A sibling of devc/tests/shell_dirs_test.sh rather than a case inside it, deliberately: that
# harness runs against *both* copies unmodified — which is what stops them drifting — and devc's
# copy has no guard, so a case added there would fail by design. Everything the two copies share
# is tested there; only the difference is tested here.
#
# Why the guard exists: during the interim, a devc container that opts into this Feature via
# additionalFeatures has both blocks in its ~/.bashrc, and the project layer is sourced twice.
# That is idempotent for aliases and `export`, and not for PATH=...:$PATH.
set -euo pipefail

FEATURE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="${1:-$FEATURE_DIR/install.sh}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Extracted from the real install.sh, the same way devc/tests/shell_dirs_test.sh does it, so
# this test cannot drift from what lands in ~/.bashrc either.
BLOCK="$WORK/block.sh"
awk '/# devc:shell-dirs \(start\)/{f=1;next} /# devc:shell-dirs \(end\)/{f=0} f' "$SCRIPT" \
  > "$BLOCK"
grep -q '_DEVC_SHELL_DIRS_DONE' "$BLOCK" || {
  echo "FAIL: no _DEVC_SHELL_DIRS_DONE guard in the block extracted from $SCRIPT"; exit 1; }

fails=0
check() { # check <desc> <condition-as-args...>
  local desc="$1"; shift
  if "$@"; then echo "  ok   $desc"; else echo "  FAIL $desc"; fails=$((fails + 1)); fi
}

# Point the block at temp dirs exactly as the sibling harness does, then source the result
# `$1` times in ONE shell — which is what two copies of the block in one ~/.bashrc amounts to.
run_block_n() { # run_block_n <times> <user-dir> <project-dir>
  local times="$1"
  sed -e "s#^USER_SHELL_DIR=.*#USER_SHELL_DIR='$2'#" \
      -e "s#^PROJECT_SHELL_DIR=.*#PROJECT_SHELL_DIR='$3'#" "$BLOCK" > "$WORK/run.sh"
  cat > "$WORK/harness.sh" <<EOF
ORDER=""
for _i in \$(seq 1 $times); do . "\$WORK/run.sh"; done
printf '%s\n' "\$ORDER" > "\$WORK/order.txt"
printf '%s\n' "\${_DEVC_SHELL_DIRS_DONE:-<unset>}" > "\$WORK/done.txt"
exit 0
EOF
  WORK="$WORK" bash "$WORK/harness.sh" > "$WORK/out.log" 2>&1 || {
    echo "  FAIL block exited nonzero"; cat "$WORK/out.log"; fails=$((fails + 1)); }
}

order() { cat "$WORK/order.txt"; }

echo "case 1: sourcing the block twice sources each file once"
U="$WORK/c1/user"; P="$WORK/c1/proj"; mkdir -p "$U" "$P"
echo 'ORDER="$ORDER u"; PATH="/first:$PATH"' > "$U/10-a.sh"
echo 'ORDER="$ORDER p"' > "$P/10-a.sh"
run_block_n 2 "$U" "$P"
check "each layer ran exactly once across two sourcings" test "$(order)" = " u p"
check "no error output" test ! -s "$WORK/out.log"
check "both directories recorded in the guard" \
  grep -qxF "$U:$P" "$WORK/done.txt"

echo "case 2: one sourcing is unaffected by the guard"
run_block_n 1 "$U" "$P"
check "still sources both layers, in order" test "$(order)" = " u p"

echo "case 3: five sourcings are still one each"
run_block_n 5 "$U" "$P"
check "idempotent beyond the two-block case" test "$(order)" = " u p"

echo "case 4: a directory not yet seen is still sourced"
U2="$WORK/c4/user"; P2="$WORK/c4/proj"; mkdir -p "$U2" "$P2"
echo 'ORDER="$ORDER u2"' > "$U2/10-a.sh"
echo 'ORDER="$ORDER p2"' > "$P2/10-a.sh"
cat > "$WORK/harness.sh" <<EOF
ORDER=""
sed -e "s#^USER_SHELL_DIR=.*#USER_SHELL_DIR='$U'#" \
    -e "s#^PROJECT_SHELL_DIR=.*#PROJECT_SHELL_DIR='$P'#" "\$WORK/block.sh" > "\$WORK/a.sh"
sed -e "s#^USER_SHELL_DIR=.*#USER_SHELL_DIR='$U2'#" \
    -e "s#^PROJECT_SHELL_DIR=.*#PROJECT_SHELL_DIR='$P2'#" "\$WORK/block.sh" > "\$WORK/b.sh"
. "\$WORK/a.sh"
. "\$WORK/b.sh"
. "\$WORK/a.sh"
printf '%s\n' "\$ORDER" > "\$WORK/order.txt"
exit 0
EOF
WORK="$WORK" bash "$WORK/harness.sh" > "$WORK/out.log" 2>&1
check "the guard skips by path, not by having run before" test "$(order)" = " u p u2 p2"
check "no error output" test ! -s "$WORK/out.log"

echo "case 5: the guard is per-shell, not inherited"
# Not exported on purpose: a subshell that legitimately re-sources ~/.bashrc must start clean,
# or `bash -l` inside a devc shell would silently get none of its layers.
check "the block never exports the guard" \
  bash -c "! grep -qE '^[[:space:]]*export[[:space:]]+_DEVC_SHELL_DIRS_DONE' '$BLOCK'"
cat > "$WORK/harness.sh" <<EOF
ORDER=""
sed -e "s#^USER_SHELL_DIR=.*#USER_SHELL_DIR='$U'#" \
    -e "s#^PROJECT_SHELL_DIR=.*#PROJECT_SHELL_DIR=''#" "\$WORK/block.sh" > "\$WORK/run.sh"
. "\$WORK/run.sh"
bash -c '. "\$0/run.sh"; printf "%s\n" "\$ORDER" > "\$0/child.txt"' "\$WORK"
printf '%s\n' "\$ORDER" > "\$WORK/order.txt"
exit 0
EOF
WORK="$WORK" bash "$WORK/harness.sh" > "$WORK/out.log" 2>&1
check "a child shell re-sources the same directory" test "$(cat "$WORK/child.txt")" = " u"

echo
if [ "$fails" -eq 0 ]; then echo "ALL PASS"; else echo "$fails FAILED"; exit 1; fi
