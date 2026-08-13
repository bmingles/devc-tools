#!/bin/bash
# Scenario `login_shell` — the half `shell-dirs` never had: `profile_*.sh` under a login shell.
#
# The two prefixes are **targets, not ordering**. `~/.bashrc` reaches interactive shells only —
# the stock `case $- in *i*) ;; *) return;; esac` guard sits above this Feature's block — and
# the login profile reaches login shells. This scenario is what pins that in a real container,
# in all four combinations, including the one the README must not overclaim: plain `bash -c`
# reads **no** startup file, so it gets neither.
set -e

source dev-container-features-test-lib

check "the login profile is ~/.profile, and it has the block" \
  grep -qxF '_bash_config_kind=profile' "$HOME/.profile"
check "~/.bashrc has the other one" grep -qxF '_bash_config_kind=bashrc' "$HOME/.bashrc"
check "and no ~/.bash_profile was invented — it would shadow both" test ! -e "$HOME/.bash_profile"

probe() { # probe <bash flags> <var>
  rm -f /tmp/probe
  bash "$1" "printf %s \"\${$2:-none}\" > /tmp/probe" > /dev/null 2>&1
  cat /tmp/probe 2> /dev/null
}

check "an interactive shell runs bashrc_*.sh" test "$(probe -ic BASHRC_MARKER)" = yes
check "and not profile_*.sh" test "$(probe -ic PROFILE_MARKER)" = none

check "a login shell runs profile_*.sh" test "$(probe -lc PROFILE_MARKER)" = yes
# Not asserted the other way round: on this image ~/.profile sources ~/.bashrc, which returns
# immediately in a non-interactive shell — so `bash -lc` gets only the profile half here, but
# that is the image's ~/.profile talking, not this Feature.

# An interactive login shell — the shape a terminal in the container actually starts — runs both
# blocks over the same two directories, bashrc first, because ~/.profile sources ~/.bashrc
# before reaching its own appended block. Both halves must survive that: the once-per-shell
# guard keys on the kind as well as the directory precisely so the second pass is not skipped.
check "an interactive login shell runs both" bash -c \
  "rm -f /tmp/probe
   bash -ilc 'printf %s \"\${BASHRC_MARKER:-none}/\${PROFILE_MARKER:-none}\" > /tmp/probe' \
     > /dev/null 2>&1
   [ \"\$(cat /tmp/probe)\" = yes/yes ]"

# The ceiling, stated as a test so the README cannot quietly overclaim it. `docker exec ctr
# bash -c '…'` is this case: no startup file is read at all, and only containerEnv reaches it.
check "a plain non-interactive shell gets neither" bash -c \
  "[ \"\$(bash -c 'printf %s \"\${BASHRC_MARKER:-none}/\${PROFILE_MARKER:-none}\"')\" = none/none ]"

check "and every one of those shells is silent" bash -c \
  "[ -z \"\$(bash -lc true 2>&1)\" ] && [ -z \"\$(bash -c true 2>&1)\" ]"

reportResults
