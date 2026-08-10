#!/bin/bash
# Exercises the project-hook discovery block from project-hook.sh against temp dirs, with
# no container involved. Extracts the block from the real script so the test cannot drift
# from the implementation.
set -uo pipefail

SCRIPT="${1:?usage: project_hook_test.sh /path/to/project-hook.sh}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Pull the block out: everything strictly between the `devc:project-hook` fence markers.
BLOCK="$WORK/block.sh"
awk '/# devc:project-hook \(start\)/{f=1;next} /# devc:project-hook \(end\)/{f=0} f' \
  "$SCRIPT" > "$BLOCK"
grep -q 'devc-post-create.sh' "$BLOCK" || {
  echo "FAIL: could not extract hook block"
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

# Run the block against project root $1. Sets $status, $out. The block reads PROJECT_ROOT,
# which it derives from PROJECT_PATH — so pointing PROJECT_PATH at the temp root is enough,
# and the real derivation is exercised rather than patched out.
run_block() {
  set +e
  out="$(PROJECT_PATH="$1" bash "$BLOCK" 2>&1)"
  status=$?
  set -e
}

# Write an executable hook at $1 that touches marker $2 and records its cwd.
make_hook() {
  mkdir -p "$(dirname "$1")"
  printf '#!/bin/bash\ntouch "%s"\npwd > "%s.pwd"\n' "$2" "$2" > "$1"
  chmod 755 "$1"
}

echo "case 1: .devc/ hook runs"
R="$WORK/c1"
mkdir -p "$R"
make_hook "$R/.devc/devc-post-create.sh" "$R/ran-devc"
run_block "$R"
check "exit 0" test "$status" -eq 0
check "hook ran" test -f "$R/ran-devc"

echo "case 2: .devcontainer/ hook runs when .devc/ is absent"
R="$WORK/c2"
mkdir -p "$R"
make_hook "$R/.devcontainer/devc-post-create.sh" "$R/ran-dc"
run_block "$R"
check "exit 0" test "$status" -eq 0
check "hook ran" test -f "$R/ran-dc"

echo "case 3: both present and executable — only .devc/ runs"
R="$WORK/c3"
mkdir -p "$R"
make_hook "$R/.devc/devc-post-create.sh" "$R/ran-devc"
make_hook "$R/.devcontainer/devc-post-create.sh" "$R/ran-dc"
run_block "$R"
check "exit 0" test "$status" -eq 0
check ".devc/ ran" test -f "$R/ran-devc"
check ".devcontainer/ did NOT run" test ! -f "$R/ran-dc"

echo "case 4: non-executable .devc/ fails — no fall-through to .devcontainer/"
R="$WORK/c4"
mkdir -p "$R/.devc"
printf '#!/bin/bash\ntouch "%s"\n' "$R/ran-devc" > "$R/.devc/devc-post-create.sh"
chmod 644 "$R/.devc/devc-post-create.sh"
make_hook "$R/.devcontainer/devc-post-create.sh" "$R/ran-dc"
run_block "$R"
check "exit nonzero" test "$status" -ne 0
check "names the offending path" grep -q '\.devc/devc-post-create\.sh' <<< "$out"
check "says not executable" grep -q 'not executable' <<< "$out"
check ".devc/ hook did not run" test ! -f "$R/ran-devc"
check ".devcontainer/ hook did NOT run (no fall-through)" test ! -f "$R/ran-dc"

echo "case 5: dangling symlink is a failure, not an absence"
R="$WORK/c5"
mkdir -p "$R/.devc"
ln -s "$R/.devc/nonexistent-target.sh" "$R/.devc/devc-post-create.sh"
make_hook "$R/.devcontainer/devc-post-create.sh" "$R/ran-dc"
run_block "$R"
check "exit nonzero" test "$status" -ne 0
check ".devcontainer/ hook did NOT run" test ! -f "$R/ran-dc"

echo "case 6: neither present — no-op"
R="$WORK/c6"
mkdir -p "$R"
run_block "$R"
check "exit 0" test "$status" -eq 0
check "no output" test -z "$out"

echo "case 7: a hook that fails fails the block"
R="$WORK/c7"
mkdir -p "$R/.devc"
printf '#!/bin/bash\nexit 1\n' > "$R/.devc/devc-post-create.sh"
chmod 755 "$R/.devc/devc-post-create.sh"
run_block "$R"
check "exit nonzero" test "$status" -ne 0

echo "case 8: the hook runs with cwd = project root, whatever the caller's cwd"
R="$WORK/c8"
mkdir -p "$R/sub"
make_hook "$R/.devc/devc-post-create.sh" "$R/ran-devc"
# Invoke from an unrelated cwd: the block must establish the project cwd itself rather
# than inheriting it (each post-create.sh step is a separate `bash` process).
set +e
out="$(cd "$R/sub" && PROJECT_PATH="$R" bash "$BLOCK" 2>&1)"
status=$?
set -e
check "exit 0" test "$status" -eq 0
check "hook ran" test -f "$R/ran-devc"
check "hook's cwd is the project root" test "$(cat "$R/ran-devc.pwd")" = "$R"

echo
if [ "$fails" -eq 0 ]; then
  echo "all cases ok"
else
  echo "$fails check(s) FAILED"
fi
exit "$fails"
