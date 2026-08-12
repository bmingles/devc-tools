#!/bin/bash
# install.sh end to end, offline — the half neither block harness reaches: how the two options
# become the two *_SHELL_DIR assignments, and how the append behaves on a rebuild.
#
#   bash features/shell-dirs/test/install_options_test.sh
#
# No Docker and no root: _REMOTE_USER_HOME points at a temp dir, which is the only thing
# install.sh writes to. _REMOTE_USER is left unset so the chown is skipped.
set -uo pipefail

FEATURE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
INSTALL="$FEATURE_DIR/install.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

fails=0
check() { # check <desc> <condition-as-args...>
  local desc="$1"; shift
  if "$@"; then echo "  ok   $desc"; else echo "  FAIL $desc"; fails=$((fails + 1)); fi
}

# run_install <home> [VAR=value ...] — a fresh ~/.bashrc unless the caller made one first.
run_install() { # sets rc / status / out
  local home="$1"; shift
  mkdir -p "$home"
  [ -f "$home/.bashrc" ] || : > "$home/.bashrc"
  env -u PROJECTDIR -u USERDIR _REMOTE_USER_HOME="$home" "$@" \
    sh "$INSTALL" > "$WORK/out.log" 2>&1
  status=$?
  rc="$home/.bashrc"
}

# The line the block ends up carrying, read back out of the ~/.bashrc that was actually
# written — not out of a variable this test computed the same way install.sh does.
assigned() { # assigned <bashrc> <VAR>
  grep -m1 "^$2=" "$1"
}

echo "case 1: bare {} — the project layer, workspace-relative, user layer off"
H="$WORK/c1"
run_install "$H"
check "install.sh succeeds" test "$status" -eq 0
check "the block is appended" grep -qF '# >>> shell-dirs >>>' "$rc"
check "and closed" grep -qF '# <<< shell-dirs <<<' "$rc"
check "the fence markers are preserved verbatim" \
  grep -qF '# devc:shell-dirs (start)' "$rc"
check "projectDir defaults to .devcontainer/shell, behind the PROJECT_PATH guard" \
  test "$(assigned "$rc" PROJECT_SHELL_DIR)" = \
    'PROJECT_SHELL_DIR="${PROJECT_PATH:+$PROJECT_PATH/.devcontainer/shell}"'
check "userDir defaults to empty — the layer is off" \
  test "$(assigned "$rc" USER_SHELL_DIR)" = 'USER_SHELL_DIR=""'

echo "case 2: the appended block is what the harnesses run"
# Sourcing what actually landed in ~/.bashrc, with PROJECT_PATH pointing at a fixture.
mkdir -p "$WORK/c2/ws/.devcontainer/shell"
echo 'MARKER=project' > "$WORK/c2/ws/.devcontainer/shell/10-a.sh"
awk '/# devc:shell-dirs \(start\)/{f=1;next} /# devc:shell-dirs \(end\)/{f=0} f' "$rc" \
  > "$WORK/c2/block.sh"
check "PROJECT_PATH set — the project layer is sourced" bash -c \
  "PROJECT_PATH='$WORK/c2/ws'; . '$WORK/c2/block.sh'; [ \"\${MARKER:-}\" = project ]"
check "PROJECT_PATH unset — nothing is sourced" bash -c \
  "unset PROJECT_PATH; . '$WORK/c2/block.sh'; [ -z \"\${MARKER:-}\" ]"
check "sourcing it is silent" bash -c \
  "[ -z \"\$(PROJECT_PATH='$WORK/c2/ws'; . '$WORK/c2/block.sh' 2>&1)\" ]"
check "and leaves \$? at 0" bash -c \
  "unset PROJECT_PATH; . '$WORK/c2/block.sh'; [ \$? -eq 0 ]"

echo "case 3: userDir — an absolute container path, sourced before the project layer"
H="$WORK/c3"
run_install "$H" USERDIR=/usr/local/share/myshell
check "install.sh succeeds" test "$status" -eq 0
check "userDir is used verbatim" \
  test "$(assigned "$rc" USER_SHELL_DIR)" = 'USER_SHELL_DIR="/usr/local/share/myshell"'
check "the project layer is untouched by it" \
  test "$(assigned "$rc" PROJECT_SHELL_DIR)" = \
    'PROJECT_SHELL_DIR="${PROJECT_PATH:+$PROJECT_PATH/.devcontainer/shell}"'
check "no devc path is ever defaulted in" bash -c \
  "! grep -q '/usr/local/share/devc/shell' '$rc'"

echo "case 4: an absolute projectDir bypasses the PROJECT_PATH guard"
H="$WORK/c4"
run_install "$H" PROJECTDIR=/opt/shell.d
check "install.sh succeeds" test "$status" -eq 0
check "used as-is, with no \${PROJECT_PATH:+...} wrapper" \
  test "$(assigned "$rc" PROJECT_SHELL_DIR)" = 'PROJECT_SHELL_DIR="/opt/shell.d"'
awk '/# devc:shell-dirs \(start\)/{f=1;next} /# devc:shell-dirs \(end\)/{f=0} f' "$rc" \
  > "$WORK/c4/block.sh"
check "so it works with no PROJECT_PATH at all" bash -c \
  "sed 's#^PROJECT_SHELL_DIR=.*#PROJECT_SHELL_DIR=\"$WORK/c4/d\"#' '$WORK/c4/block.sh' \
     > '$WORK/c4/run.sh'
   mkdir -p '$WORK/c4/d' && echo 'MARKER=abs' > '$WORK/c4/d/10-a.sh'
   unset PROJECT_PATH; . '$WORK/c4/run.sh'; [ \"\${MARKER:-}\" = abs ]"

echo "case 5: an empty projectDir disables the layer"
H="$WORK/c5"
run_install "$H" PROJECTDIR=
check "install.sh succeeds" test "$status" -eq 0
# `${VAR-default}`, not `${VAR:-default}`: an explicitly empty option must not fall back.
check "empty, not the default" \
  test "$(assigned "$rc" PROJECT_SHELL_DIR)" = 'PROJECT_SHELL_DIR=""'
check "and both layers off is still a valid, silent block" bash -c \
  "awk '/# devc:shell-dirs \(start\)/{f=1;next} /# devc:shell-dirs \(end\)/{f=0} f' '$rc' \
     > '$WORK/c5/block.sh'
   out=\$(PROJECT_PATH=/nowhere; . '$WORK/c5/block.sh' 2>&1); [ -z \"\$out\" ]"

echo "case 6: a rebuild does not double-append"
H="$WORK/c6"
run_install "$H"
first="$(wc -l < "$rc")"
run_install "$H"
check "the second run succeeds" test "$status" -eq 0
check "and says it left the file alone" \
  grep -q 'already has the block' "$WORK/out.log"
check "exactly one start marker" bash -c \
  "[ \"\$(grep -cF '# >>> shell-dirs >>>' '$rc')\" = 1 ]"
check "the file did not grow" test "$(wc -l < "$rc")" -eq "$first"

echo "case 7: the block is appended, not inserted — it can override what came before"
H="$WORK/c7"
mkdir -p "$H"
printf '%s\n' 'alias existing=1' > "$H/.bashrc"
run_install "$H"
check "existing content is kept" grep -qxF 'alias existing=1' "$rc"
check "and comes first" bash -c \
  "[ \"\$(grep -n 'alias existing=1' '$rc' | cut -d: -f1)\" -lt \
     \"\$(grep -n '# >>> shell-dirs >>>' '$rc' | cut -d: -f1)\" ]"

echo "case 8: an option that would break the quoting is refused, loudly"
# The values are pasted into a double-quoted assignment; a silently mangled block would source
# something other than what was asked for, which is worse than a failed build.
for bad in 'a"b' 'a`b' 'a$b' 'a\b'; do
  H="$(mktemp -d "$WORK/c8.XXXXXX")"
  run_install "$H" "PROJECTDIR=$bad"
  check "projectDir '$bad' fails the build" test "$status" -ne 0
  check "  naming the option" grep -q 'projectDir' "$WORK/out.log"
  check "  and writes no block" bash -c "! grep -qF '# >>> shell-dirs >>>' '$rc'"
done

echo
if [ "$fails" -eq 0 ]; then echo "ALL PASS"; else echo "$fails FAILED"; exit 1; fi
