#!/bin/bash
# agents offline harness — the real install.sh, run repeatedly against a temp SHARE_DIR
# and a temp $_REMOTE_USER_HOME, with `curl` and `runuser` stubbed on PATH so no network call and
# no real privilege switch happens. No Docker, no root, no network:
#
#   bash features/agents/test/install_options_test.sh
#
# What this cannot cover, because it needs a real container: whether the CLI installers
# (claude.ai/install.sh, gh.io/copilot-install) actually work, and whether `runuser`/`su` really
# drop privileges the way the stub here does not even attempt to. Both need
# test/run-features-test.sh under Docker. What this DOES pin, against the real install.sh: option
# baking (including claudeDir's empty-default resolution), the path-option injection guard, the
# idempotent-CLI-already-installed skip, and that a failed download fails the build.
set -uo pipefail

FEATURE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

fails=0
check() { # check <desc> <condition-as-args...>
  local desc="$1"; shift
  if "$@"; then echo "  ok   $desc"; else echo "  FAIL $desc"; fails=$((fails + 1)); fi
}

# --- stubs: curl (no network) and runuser (no real privilege switch) ---------------------------
#
# Real runuser/su need root and a real target user, neither available here — that half is left
# to test/run-features-test.sh under Docker. The stub still runs the installer script for real
# (via `bash`), just as the current user with $HOME repointed, so everything except the actual
# privilege drop is exercised.
STUBS="$WORK/stubs"
mkdir -p "$STUBS"

cat > "$STUBS/curl" << 'CURL'
#!/bin/sh
echo "curl $*" >> "$CURL_LOG"
[ "${CURL_FAIL:-}" = 1 ] && exit 1
url=""
for a in "$@"; do case "$a" in http*) url="$a" ;; esac; done
case "$url" in
  *claude*) bin=claude ;;
  *copilot*) bin=copilot ;;
  *) bin=unknown ;;
esac
echo "mkdir -p \"\$HOME/.local/bin\"; printf '#!/bin/sh\necho fake-$bin\n' > \"\$HOME/.local/bin/$bin\"; chmod +x \"\$HOME/.local/bin/$bin\""
CURL
chmod +x "$STUBS/curl"

cat > "$STUBS/runuser" << 'RUNUSER'
#!/bin/sh
echo "runuser $*" >> "$RUNUSER_LOG"
while [ $# -gt 0 ]; do
  case "$1" in
    -l) shift; user="$1"; shift ;;
    -c) shift; cmd="$1"; shift ;;
    *) shift ;;
  esac
done
echo "$user" >> "$RUNUSER_USER_LOG"
HOME="$FAKE_REMOTE_HOME" PATH="$PATH" bash -c "$cmd"
RUNUSER
chmod +x "$STUBS/runuser"

# This devcontainer has a real `claude` (and possibly `copilot`) already on PATH — this file IS
# this Feature's own test suite, run inside a container built from an `agents`-like setup.
# Left in the PATH handed down to install.sh, the installer's own idempotent
# `! command -v claude` guard would find the real one and skip the fake install silently, so every
# case below would "pass" without curl ever running. Strip those directories out.
CLEAN_PATH="$PATH"
for real_bin in claude copilot; do
  real_path="$(command -v "$real_bin" 2> /dev/null || true)"
  if [ -n "$real_path" ]; then
    real_dir="$(dirname "$real_path")"
    CLEAN_PATH="$(printf '%s' "$CLEAN_PATH" | tr ':' '\n' | grep -vxF "$real_dir" | paste -sd: -)"
  fi
done

# setup <name> [VAR=value ...] — run the real install.sh with this case's env, into a fresh
# SHARE_DIR and a fresh fake remote-user HOME.
setup() {
  local name="$1"; shift
  CASE="$WORK/$name"
  rm -rf "$CASE"
  mkdir -p "$CASE/share" "$CASE/home"
  : > "$CASE/curl.log"; : > "$CASE/runuser.log"; : > "$CASE/runuser_user.log"
  env -u INSTALLCLAUDECLI -u INSTALLCOPILOTCLI -u CLAUDEDIR -u SEEDDIR -u CLAUDEJSONDIR \
    SHARE_DIR="$CASE/share" \
    _REMOTE_USER="$(id -un)" _REMOTE_USER_HOME="$CASE/home" \
    FAKE_REMOTE_HOME="$CASE/home" \
    CURL_LOG="$CASE/curl.log" RUNUSER_LOG="$CASE/runuser.log" RUNUSER_USER_LOG="$CASE/runuser_user.log" \
    PATH="$STUBS:$CLEAN_PATH" \
    "$@" sh "$FEATURE_DIR/install.sh" > "$CASE/install.log" 2> "$CASE/install.err"
  status=$?
  HOOK="$CASE/share/post-create.sh"
}

echo "case 1: bare install — defaults"
setup c1
check "install.sh exits 0" test "$status" -eq 0
check "post-create.sh installed" test -f "$HOOK"
check "CLAUDE_DIR baked to the resolved \$_REMOTE_USER_HOME/.claude" \
  grep -qxF "CLAUDE_DIR=\"$WORK/c1/home/.claude\"" "$HOOK"
check "SEED_DIR baked empty" grep -qx 'SEED_DIR=""' "$HOOK"
check "CLAUDE_JSON_DIR baked empty" grep -qx 'CLAUDE_JSON_DIR=""' "$HOOK"
check "claudeDir was pre-created" test -d "$WORK/c1/home/.claude"
check "claude was installed (curl invoked once)" test "$(wc -l < "$WORK/c1/curl.log")" -eq 1
check "claude binary landed under the fake remote HOME" test -x "$WORK/c1/home/.local/bin/claude"
check "copilot was NOT installed — installCopilotCli defaults false" \
  test ! -e "$WORK/c1/home/.local/bin/copilot"
check "the CLI install ran as the configured remote user" \
  grep -qxF "$(id -un)" "$WORK/c1/runuser_user.log"

echo "case 2: installCopilotCli=true — both CLIs land"
setup c2 INSTALLCOPILOTCLI=true
check "install.sh exits 0" test "$status" -eq 0
check "claude installed" test -x "$WORK/c2/home/.local/bin/claude"
check "copilot installed too" test -x "$WORK/c2/home/.local/bin/copilot"
check "curl invoked twice (claude, then copilot)" test "$(wc -l < "$WORK/c2/curl.log")" -eq 2

echo "case 3: installClaudeCli=false, installCopilotCli=false — no CLI installed, no curl at all"
setup c3 INSTALLCLAUDECLI=false
check "install.sh exits 0" test "$status" -eq 0
check "no curl invocation happened" test ! -s "$WORK/c3/curl.log"
check "claude was not installed" test ! -e "$WORK/c3/home/.local/bin/claude"
check "claudeDir is still pre-created regardless" test -d "$WORK/c3/home/.claude"

echo "case 4: a custom claudeDir wins over the \$_REMOTE_USER_HOME default"
CUSTOM="$WORK/c4-custom-claude-dir"
setup c4 CLAUDEDIR="$CUSTOM"
check "install.sh exits 0" test "$status" -eq 0
check "CLAUDE_DIR baked to the custom path" grep -qxF "CLAUDE_DIR=\"$CUSTOM\"" "$HOOK"
check "the custom directory was created" test -d "$CUSTOM"

echo "case 5: seedDir and claudeJsonDir bake through unchanged"
setup c5 SEEDDIR=/usr/local/share/whatever/seed CLAUDEJSONDIR=/usr/local/share/whatever/json
check "install.sh exits 0" test "$status" -eq 0
check "SEED_DIR baked" grep -qxF 'SEED_DIR="/usr/local/share/whatever/seed"' "$HOOK"
check "CLAUDE_JSON_DIR baked" grep -qxF 'CLAUDE_JSON_DIR="/usr/local/share/whatever/json"' "$HOOK"

echo "case 6: the CLI is already installed — the idempotent guard skips curl entirely"
# Deliberately not calling setup() here — it runs the real install.sh once by itself, which
# would install the fake claude first and make "curl was never invoked" pass for the wrong
# reason. Build this case's directories by hand instead, so install.sh runs exactly once.
rm -rf "${WORK:?}/c6"
mkdir -p "$WORK/c6/share" "$WORK/c6/home/.local/bin"
printf '#!/bin/sh\necho already-there\n' > "$WORK/c6/home/.local/bin/claude"
chmod +x "$WORK/c6/home/.local/bin/claude"
env -u INSTALLCLAUDECLI -u INSTALLCOPILOTCLI -u CLAUDEDIR -u SEEDDIR -u CLAUDEJSONDIR \
  SHARE_DIR="$WORK/c6/share" _REMOTE_USER="$(id -un)" _REMOTE_USER_HOME="$WORK/c6/home" \
  FAKE_REMOTE_HOME="$WORK/c6/home" CURL_LOG="$WORK/c6/curl.log" RUNUSER_LOG="$WORK/c6/runuser.log" \
  RUNUSER_USER_LOG="$WORK/c6/runuser_user.log" PATH="$STUBS:$CLEAN_PATH" \
  sh "$FEATURE_DIR/install.sh" > "$WORK/c6/install.log" 2> "$WORK/c6/install.err"
status=$?
check "install.sh still exits 0" test "$status" -eq 0
check "curl was never invoked — already installed" test ! -s "$WORK/c6/curl.log"
check "the pre-existing binary is untouched" \
  test "$(cat "$WORK/c6/home/.local/bin/claude")" = "$(printf '#!/bin/sh\necho already-there')"

echo "case 7: a failed download fails the build"
setup c7 CURL_FAIL=1
check "install.sh exits non-zero" test "$status" -ne 0
check "it names the failure" grep -q 'network required' "$WORK/c7/install.err"
check "no post-create.sh was left half-installed" test ! -f "$HOOK"

echo "case 8: a failed download with both CLIs disabled does not matter — curl is never reached"
setup c8 INSTALLCLAUDECLI=false CURL_FAIL=1
check "install.sh exits 0" test "$status" -eq 0

echo "case 9: path-option injection guard rejects every dangerous character, for every path option"
for opt in CLAUDEDIR SEEDDIR CLAUDEJSONDIR; do
  for bad in '"' '`' '$' '\' ; do
    setup "c9-$opt-inject" "$opt=/x${bad}y"
    check "$opt rejects a literal $bad" test "$status" -ne 0
  done
done

echo "case 10: an empty path option is accepted (distinct from unset) and bakes empty"
setup c10 CLAUDEDIR="" SEEDDIR="" CLAUDEJSONDIR=""
check "install.sh exits 0" test "$status" -eq 0
check "CLAUDE_DIR still resolves to the \$_REMOTE_USER_HOME default" \
  grep -qxF "CLAUDE_DIR=\"$WORK/c10/home/.claude\"" "$HOOK"

echo
if [ "$fails" -eq 0 ]; then echo "ALL PASS"; else echo "$fails FAILED"; exit 1; fi
