#!/bin/bash
# install.sh end to end, offline — the option's journey into config.sh, the two blocks, and the
# one genuinely hazardous choice in this Feature: which file is the login profile.
#
#   bash features/bash-config/test/install_options_test.sh
#
# No Docker and no root: _REMOTE_USER_HOME and SHARE_DIR point at temp directories, which are
# the only things install.sh writes to. _REMOTE_USER is left unset so the chown is skipped —
# it is the one step that must fail loudly rather than be worked around here, and a scenario
# under Docker is what can actually exercise it.
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

# run_install <name> [VAR=value ...] — sets $H, $share, $status. The caller creates whichever
# startup files the case is about *before* calling; nothing is created here, because which of
# them exists is exactly what most of these cases are testing.
run_install() {
  local name="$1"; shift
  H="$WORK/$name"; share="$WORK/$name.share"
  mkdir -p "$H"
  env -u PROJECTDIR SHARE_DIR="$share" _REMOTE_USER_HOME="$H" "$@" \
    sh "$INSTALL" > "$WORK/out.log" 2>&1
  status=$?
}

# The block as it landed, read back out of the file that was actually written.
block_of() { # block_of <file>
  sed -n '/^# >>> bash-config >>>$/,/^# <<< bash-config <<<$/p' "$1"
}

echo "case 1: a bare {} — the three files, the two directories, the two blocks"
run_install c1
check "install.sh succeeds" test "$status" -eq 0
check "init.sh is installed" test -f "$share/init.sh"
# Verbatim, not rewritten. It is the one file in this Feature that carries logic, and nothing
# ever patches it — if that ever stops being true, this is where it shows up.
check "byte-identical to the file in the repo" cmp -s "$FEATURE_DIR/init.sh" "$share/init.sh"
check "post-create.sh is installed" test -f "$share/post-create.sh"
check "and is executable" test -x "$share/post-create.sh"
check "config.sh carries the default projectDir" \
  grep -qx 'PROJECT_DIR=".devcontainer/shell"' "$share/config.sh"
check "dirs/user is created, empty" bash -c \
  "[ -d '$share/dirs/user' ] && [ -z \"\$(ls -A '$share/dirs/user')\" ]"
# Never populated and never written to again: it is a mount target, and the Feature does not
# get to have an opinion about where its contents come from.
check "and dirs/project is NOT created at build time" test ! -e "$share/dirs/project"

echo "case 2: the two blocks differ only in the kind"
check "~/.bashrc got a block" test -n "$(block_of "$H/.bashrc")"
check "the login profile got one" test -n "$(block_of "$H/.profile")"
check "~/.bashrc's is the bashrc kind, and is four lines" \
  test "$(block_of "$H/.bashrc")" = "# >>> bash-config >>>
_bash_config_kind=bashrc
. $share/init.sh
# <<< bash-config <<<"
check "the profile's is the profile kind, otherwise identical" \
  test "$(block_of "$H/.profile")" = "# >>> bash-config >>>
_bash_config_kind=profile
. $share/init.sh
# <<< bash-config <<<"
# Static means static: no option, no workspace, no \${PROJECT_PATH} deferral, nothing for a
# later hook to come back and patch. That is the whole reason this Feature exists.
check "no option value appears in either block" bash -c \
  "! grep -q 'devcontainer/shell' '$H/.bashrc' '$H/.profile'"

echo "case 3: the fixed paths agree with each other"
# init.sh names its dirs/ outright, because a sourced file cannot find out where it lives. So
# three files have to agree on one path, and nothing but this check makes them.
SHARE_DEFAULT=/usr/local/share/devc-features/bash-config
check "install.sh defaults SHARE_DIR to the Feature namespace" \
  grep -qF "SHARE_DIR:-$SHARE_DEFAULT" "$INSTALL"
check "post-create.sh agrees" grep -qF "SHARE_DIR:-$SHARE_DEFAULT" "$FEATURE_DIR/post-create.sh"
check "init.sh looks for dirs/ under it" \
  grep -qF "_BASH_CONFIG_DIRS:-$SHARE_DEFAULT/dirs" "$FEATURE_DIR/init.sh"
# The manifest calls an absolute path, so it and install.sh must agree or the hook silently
# never runs.
check "and the manifest's postCreateCommand names where install.sh puts it" \
  grep -qF "$SHARE_DEFAULT/post-create.sh" "$FEATURE_DIR/devcontainer-feature.json"

echo "case 4: the login profile is whichever file bash will actually read"
# bash reads the FIRST of ~/.bash_profile, ~/.bash_login, ~/.profile and ignores the rest, so
# creating ~/.bash_profile is destructive rather than additive: measured on this image, a naive
# one made an interactive login shell run NEITHER ~/.profile NOR ~/.bashrc, since ~/.profile is
# what sources ~/.bashrc.
profile_blocks() { # profile_blocks <home> — which of the three files got a block
  local home="$1" f out=''
  for f in .bash_profile .bash_login .profile; do
    [ -f "$home/$f" ] && grep -qF '# >>> bash-config >>>' "$home/$f" && out="$out $f"
  done
  printf '%s' "${out# }"
}

mkdir -p "$WORK/c4a"; : > "$WORK/c4a/.profile"
run_install c4a
check "only ~/.profile exists — it gets the block" test "$(profile_blocks "$H")" = .profile

mkdir -p "$WORK/c4b"; : > "$WORK/c4b/.profile"; : > "$WORK/c4b/.bash_profile"
run_install c4b
check "~/.bash_profile exists — it wins, and only it" \
  test "$(profile_blocks "$H")" = .bash_profile

mkdir -p "$WORK/c4c"; : > "$WORK/c4c/.profile"; : > "$WORK/c4c/.bash_login"
run_install c4c
check "~/.bash_login is second in line" test "$(profile_blocks "$H")" = .bash_login

run_install c4d # a home with none of the three
check "with none of them, ~/.profile is created" test "$(profile_blocks "$H")" = .profile
# The one thing this Feature must never do. A ~/.bash_profile invented here would shadow the
# ~/.profile the image ships and take ~/.bashrc down with it.
check "and ~/.bash_profile is never invented" test ! -e "$H/.bash_profile"

echo "case 5: an existing startup file is appended to, not replaced"
mkdir -p "$WORK/c5"
printf '%s\n' 'alias existing=1' > "$WORK/c5/.bashrc"
printf '%s\n' 'echo login-existing' > "$WORK/c5/.profile"
run_install c5
check "the ~/.bashrc line is kept" grep -qxF 'alias existing=1' "$H/.bashrc"
check "and comes first, so the block can override it" bash -c \
  "[ \"\$(grep -n 'alias existing=1' '$H/.bashrc' | cut -d: -f1)\" -lt \
     \"\$(grep -n '>>> bash-config' '$H/.bashrc' | cut -d: -f1)\" ]"
check "the profile's own contents are kept too" grep -qxF 'echo login-existing' "$H/.profile"

echo "case 6: a rebuild does not double-append"
run_install c6
first_bashrc="$(wc -l < "$H/.bashrc")"; first_profile="$(wc -l < "$H/.profile")"
run_install c6
check "the second run succeeds" test "$status" -eq 0
check "and says it left both files alone" bash -c \
  "[ \"\$(grep -c 'already has the block' '$WORK/out.log')\" = 2 ]"
check "exactly one block in ~/.bashrc" bash -c \
  "[ \"\$(grep -cF '# >>> bash-config >>>' '$H/.bashrc')\" = 1 ]"
check "exactly one in the profile" bash -c \
  "[ \"\$(grep -cF '# >>> bash-config >>>' '$H/.profile')\" = 1 ]"
check "neither file grew" bash -c \
  "[ \"\$(wc -l < '$H/.bashrc')\" = $first_bashrc ] &&
   [ \"\$(wc -l < '$H/.profile')\" = $first_profile ]"
# Per file, not per install: an image that already had the ~/.bashrc block from an older
# version of this Feature still gets the profile one.
mkdir -p "$WORK/c6b"
printf '%s\n' '# >>> bash-config >>>' 'x' '# <<< bash-config <<<' > "$WORK/c6b/.bashrc"
: > "$WORK/c6b/.profile"
run_install c6b
check "a home with only the bashrc block still gets the profile one" \
  test "$(profile_blocks "$H")" = .profile

echo "case 7: projectDir reaches config.sh, whatever it says"
run_install c7 PROJECTDIR=/opt/shell.d
check "an absolute value, verbatim" grep -qx 'PROJECT_DIR="/opt/shell.d"' "$share/config.sh"
run_install c7e PROJECTDIR=
# `${VAR-default}`, not `${VAR:-default}`: an explicitly empty option means "no project
# symlink" and must not quietly become the default.
check "an empty value stays empty" grep -qx 'PROJECT_DIR=""' "$share/config.sh"
check "and the blocks are unchanged by either" bash -c \
  "grep -qxF '_bash_config_kind=bashrc' '$H/.bashrc' &&
   ! grep -q 'opt/shell.d' '$H/.bashrc'"
run_install c7p 'PROJECTDIR=a b/c-d.e'
check "spaces and punctuation survive the round trip" \
  grep -qx 'PROJECT_DIR="a b/c-d.e"' "$share/config.sh"
check "and config.sh still parses as shell" bash -c \
  ". '$share/config.sh'; [ \"\$PROJECT_DIR\" = 'a b/c-d.e' ]"

echo "case 8: an option that would break the quoting is refused, loudly"
# The value is written into a double-quoted assignment in config.sh; a silently mangled config
# would point the project symlink somewhere other than what was asked for, which is worse than
# a failed build.
for bad in 'a"b' 'a`b' 'a$b' 'a\b' 'a
b'; do
  name="c8.$(printf '%s' "$bad" | tr -dc 'a-z')$RANDOM"
  run_install "$name" "PROJECTDIR=$bad"
  check "a projectDir containing $(printf '%q' "$bad") fails the build" test "$status" -ne 0
  check "  naming the option" grep -q 'projectDir' "$WORK/out.log"
  check "  and writes no block" bash -c "! grep -rqF '>>> bash-config' '$H' 2> /dev/null"
done

echo "case 9: the blocks in real shells — the user directory, with no create-time hook at all"
# install.sh alone is enough for the user half: dirs/user exists from build time. This is the
# whole chain — a real startup file, sourcing the real init.sh, in a real shell — with only
# _BASH_CONFIG_DIRS redirected, the same seam SHARE_DIR is for install.sh.
run_install c9
echo 'export BASHRC_MARKER=yes' > "$share/dirs/user/bashrc_10.sh"
echo 'export PROFILE_MARKER=yes' > "$share/dirs/user/profile_10.sh"
probe() { # probe <bash flags> <var> — through a file: `bash -i` without a tty writes job
  # control noise to stderr, and any other startup line is free to print.
  rm -f "$WORK/probe"
  env -u PROJECT_PATH _BASH_CONFIG_DIRS="$share/dirs" HOME="$H" \
    bash "$1" "printf %s \"\${$2:-none}\" > $WORK/probe" > /dev/null 2>&1
  cat "$WORK/probe" 2> /dev/null
}
check "a fresh interactive shell has the bashrc_ file" test "$(probe -ic BASHRC_MARKER)" = yes
check "and not the profile_ one" test "$(probe -ic PROFILE_MARKER)" = none
check "a login shell has the profile_ file" test "$(probe -lc PROFILE_MARKER)" = yes
# The Feature's ceiling, stated as a test so the README cannot quietly overclaim it: plain
# `bash -c` reads no startup file at all, and only containerEnv reaches it.
check "a plain non-interactive shell has neither" bash -c \
  "[ \"\$(probe() { rm -f '$WORK/probe'
     env -u PROJECT_PATH _BASH_CONFIG_DIRS='$share/dirs' HOME='$H' \
       bash -c \"printf %s \\\"\\\${\$1:-none}\\\" > $WORK/probe\" > /dev/null 2>&1
     cat '$WORK/probe' 2> /dev/null; }
   printf '%s/%s' \"\$(probe BASHRC_MARKER)\" \"\$(probe PROFILE_MARKER)\")\" = none/none ]"
check "and both startup files stay silent" bash -c \
  "[ -z \"\$(env -u PROJECT_PATH _BASH_CONFIG_DIRS='$share/dirs' HOME='$H' \
      bash -lc true 2>&1)\" ]"

echo
if [ "$fails" -eq 0 ]; then echo "ALL PASS"; else echo "$fails FAILED"; exit 1; fi
