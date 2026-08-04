#!/bin/bash
# Exercises the ~/.claude seed prune+link block from agents-setup.sh against temp dirs,
# with no container involved. Extracts the block from the real script so the test cannot
# drift from the implementation.
set -euo pipefail

SCRIPT="${1:?usage: seed_link_test.sh /path/to/agents-setup.sh}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Pull the block out: everything strictly between the `devc:seed-link` fence markers.
BLOCK="$WORK/block.sh"
awk '/# devc:seed-link \(start\)/{f=1;next} /# devc:seed-link \(end\)/{f=0} f' "$SCRIPT" > "$BLOCK"
grep -q 'ln -sfn' "$BLOCK" || { echo "FAIL: could not extract link block"; exit 1; }

fails=0
check() { # check <desc> <condition-as-args...>
  local desc="$1"; shift
  if "$@"; then echo "  ok   $desc"; else echo "  FAIL $desc"; fails=$((fails + 1)); fi
}

run_block() {
  # Re-point the two paths the block uses, then run it in a subshell.
  ( SEED="$1" CLAUDE_DIR="$2"
    # shellcheck disable=SC1090
    sed -e "s#^SEED=.*#SEED=$1#" -e "s#^CLAUDE_DIR=.*#CLAUDE_DIR=$2#" "$BLOCK" > "$WORK/run.sh"
    bash "$WORK/run.sh" >"$WORK/out.log" 2>&1 ) || {
      echo "  FAIL block exited nonzero"; cat "$WORK/out.log"; fails=$((fails + 1)); }
}

echo "case 1: top-level files linked, directories ignored"
S="$WORK/c1/seed"; C="$WORK/c1/claude"; mkdir -p "$S/skills" "$C"
echo "# md" > "$S/CLAUDE.md"
echo '{}' > "$S/settings.json"
printf '#!/bin/sh\n' > "$S/statusline.sh"; chmod 755 "$S/statusline.sh"
echo "a skill" > "$S/skills/inner.md"
run_block "$S" "$C"
check "CLAUDE.md is a symlink into the seed" test "$(readlink "$C/CLAUDE.md")" = "$S/CLAUDE.md"
check "settings.json linked" test -L "$C/settings.json"
check "statusline.sh readable through the link" test -r "$C/statusline.sh"
check "statusline.sh executable through the link" test -x "$C/statusline.sh"
check "seed directory NOT linked" test ! -e "$C/skills"

echo "case 2: removed seed file is pruned on the next run"
rm "$S/statusline.sh"
run_block "$S" "$C"
check "stale link removed" test ! -e "$C/statusline.sh"
check "surviving link intact" test -L "$C/CLAUDE.md"

echo "case 3: non-seed state survives the prune"
S="$WORK/c3/seed"; C="$WORK/c3/claude"; mkdir -p "$S" "$C/projects" "$WORK/c3/elsewhere"
echo "keep" > "$WORK/c3/elsewhere/target"
ln -s "$WORK/c3/elsewhere/target" "$C/unrelated-link"
echo '{"k":1}' > "$C/.credentials.json"
echo "# md" > "$S/CLAUDE.md"
run_block "$S" "$C"
check "unrelated symlink survives" test -L "$C/unrelated-link"
check "volume dir survives" test -d "$C/projects"
check "dotfile survives" test -f "$C/.credentials.json"
check "seed file linked" test -L "$C/CLAUDE.md"

echo "case 4: pre-existing plain file at the destination is replaced"
S="$WORK/c4/seed"; C="$WORK/c4/claude"; mkdir -p "$S" "$C"
echo "host wins" > "$S/settings.json"
echo "volume loses" > "$C/settings.json"
run_block "$S" "$C"
check "destination is now a link" test -L "$C/settings.json"
check "content comes from the seed" test "$(cat "$C/settings.json")" = "host wins"
check "replacement was logged" grep -q "replacing volume-local settings.json" "$WORK/out.log"

echo "case 5: dotfiles in the seed are linked, empty seed is a no-op"
S="$WORK/c5/seed"; C="$WORK/c5/claude"; mkdir -p "$S" "$C"
run_block "$S" "$C"
check "empty seed leaves claude dir empty" test -z "$(ls -A "$C")"
echo "{}" > "$S/.mcp.json"
run_block "$S" "$C"
check "dotfile linked" test -L "$C/.mcp.json"

echo "case 6: destination that is a directory (skills mountpoint shape) is skipped"
S="$WORK/c6/seed"; C="$WORK/c6/claude"; mkdir -p "$S" "$C/notes"
echo "file" > "$S/notes"   # seed has a FILE where the volume has a DIRECTORY
run_block "$S" "$C"
check "existing directory not clobbered" test -d "$C/notes"
check "skip was logged" grep -q "is not a regular file" "$WORK/out.log"

echo
if [ "$fails" -eq 0 ]; then echo "ALL PASS"; else echo "$fails FAILED"; exit 1; fi
