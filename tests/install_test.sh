#!/bin/bash
# Exercises install.sh end to end against a local fixture "release" served over file://,
# with no network and nothing real installed. In the style of the other shell harnesses in
# this repo (devc/tests/*.sh, features/devc-bridge/test/install_link_test.sh): run the real
# script, assert on what it did, so the test cannot drift from the implementation.
#
#   bash tests/install_test.sh install.sh
#
# The two things worth testing offline are exactly the two the installer is easiest to get
# wrong:
#
#   • the triple → asset mapping, including the one asset whose triple is NOT "the platform
#     I am running on" — the Linux container client is matched to the *host's arch*, so an
#     arm64 Mac must fetch aarch64-unknown-linux-gnu;
#   • the failure paths — a bad checksum, a missing asset, an unsupported platform — which
#     must abort with nothing written.
#
# `uname` is stubbed on PATH rather than the script being parameterized, so the real
# detection code runs. Downloads come from a file:// URL via DEVC_RELEASE_BASE, so the real
# curl/tar/sha256sum path runs too.
set -uo pipefail

SCRIPT="$(cd "$(dirname "${1:?usage: install_test.sh /path/to/install.sh}")" && pwd)/$(basename "$1")"
[ -f "$SCRIPT" ] || { echo "no such script: $SCRIPT"; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

fails=0
check() { # check <desc> <condition-as-args...>
  local desc="$1"; shift
  if "$@"; then echo "  ok   $desc"; else echo "  FAIL $desc"; fails=$((fails + 1)); fi
}
check_out() { # check_out <desc> <expected> — greps the last run's combined output
  local desc="$1" pat="$2"
  if grep -qF -- "$pat" "$WORK/out.log"; then
    echo "  ok   $desc"
  else
    echo "  FAIL $desc (no '$pat' in output)"; sed 's/^/       | /' "$WORK/out.log"
    fails=$((fails + 1))
  fi
}
check_no_out() { # check_no_out <desc> <pattern>
  if grep -qF -- "$2" "$WORK/out.log"; then
    echo "  FAIL $1 (unexpected '$2' in output)"; fails=$((fails + 1))
  else
    echo "  ok   $1"
  fi
}

# --- the fixture release ---------------------------------------------------------------

TRIPLES=(x86_64-unknown-linux-gnu aarch64-unknown-linux-gnu x86_64-apple-darwin aarch64-apple-darwin)
DARWIN=(x86_64-apple-darwin aarch64-apple-darwin)
LINUX=(x86_64-unknown-linux-gnu aarch64-unknown-linux-gnu)

# Each fake binary prints the asset it came from, so an assertion on the *installed* file
# proves which archive was chosen — the mapping test, not just "a file appeared".
make_archive() { # make_archive <release-dir> <asset> <binary-name> <marker>
  local dir="$1" asset="$2" bin="$3" marker="$4"
  local stage; stage="$(mktemp -d "$WORK/stage.XXXXXX")"
  printf '#!/bin/sh\necho "%s"\n' "$marker" > "$stage/$bin"
  chmod 0755 "$stage/$bin"
  tar -czf "$dir/$asset" -C "$stage" "$bin"
  rm -rf "$stage"
}

# Builds a complete eight-archive release plus checksums.txt, exactly the matrix
# .github/workflows/release.yml publishes.
make_release() { # make_release <dir> <version-marker>
  local dir="$1" v="$2"
  mkdir -p "$dir"
  local t
  for t in "${TRIPLES[@]}"; do
    make_archive "$dir" "devc-$t.tar.gz" devc "devc $v $t"
  done
  for t in "${DARWIN[@]}"; do
    make_archive "$dir" "devc-bridge-host-$t.tar.gz" devc-bridge "host $v $t"
  done
  for t in "${LINUX[@]}"; do
    make_archive "$dir" "devc-bridge-client-$t.tar.gz" devc-bridge "client $v $t"
  done
  ( cd "$dir" && sha256sum ./*.tar.gz | sed 's#\./##' > checksums.txt )
}

REL="$WORK/release/download/v9.9.9"
make_release "$REL" v9.9.9

# --- the uname stub --------------------------------------------------------------------

STUB="$WORK/stub"
mkdir -p "$STUB"
cat > "$STUB/uname" <<'EOF'
#!/bin/sh
case "${1:-}" in
  -s) echo "$FAKE_OS" ;;
  -m) echo "$FAKE_ARCH" ;;
  *) echo "$FAKE_OS" ;;
esac
EOF
chmod 0755 "$STUB/uname"

# --- the runner ------------------------------------------------------------------------

# Runs the real install.sh in a throwaway HOME with a stubbed uname and a file:// release.
# Returns the script's exit code; output lands in $WORK/out.log. HOME is per-case, so the
# default install dir (~/.local/bin) and client dir (~/.config/devc-bridge/client) are
# themselves under test rather than being overridden away.
run_install() { # run_install <case-name> <os> <arch> [EXTRA_ENV=...]...
  local name="$1" os="$2" arch="$3"; shift 3
  HOME_DIR="$WORK/home/$name"
  mkdir -p "$HOME_DIR"
  env -i \
    PATH="$STUB:/usr/local/bin:/usr/bin:/bin" \
    HOME="$HOME_DIR" \
    FAKE_OS="$os" FAKE_ARCH="$arch" \
    DEVC_RELEASE_BASE="file://$WORK/release" \
    DEVC_VERSION=v9.9.9 \
    "$@" \
    sh "$SCRIPT" > "$WORK/out.log" 2>&1
}

installed() { # installed <path-under-HOME>  — echoes what the installed fake binary prints
  "$HOME_DIR/$1" 2>/dev/null
}

# --- 1–4: the triple → asset mapping ---------------------------------------------------

echo "case 1: Linux x86_64 — devc + the container client, no host bridge"
run_install linux-x64 Linux x86_64
check "exit 0" test $? -eq 0
check "devc is the x86_64 linux build" \
  test "$(installed .local/bin/devc)" = 'devc v9.9.9 x86_64-unknown-linux-gnu'
check "client is the x86_64 linux build" \
  test "$(installed .config/devc-bridge/client/devc-bridge)" = 'client v9.9.9 x86_64-unknown-linux-gnu'
check "no host bridge on Linux" test ! -e "$HOME_DIR/.local/bin/devc-bridge"
check "devc is executable" test -x "$HOME_DIR/.local/bin/devc"
check "client is executable" test -x "$HOME_DIR/.config/devc-bridge/client/devc-bridge"
check "no partial-install temp file left behind" \
  test -z "$(find "$HOME_DIR" -name '.devc*.tmp.*' -print -quit)"

echo "case 2: Linux aarch64"
run_install linux-arm Linux aarch64
check "exit 0" test $? -eq 0
check "devc is the aarch64 linux build" \
  test "$(installed .local/bin/devc)" = 'devc v9.9.9 aarch64-unknown-linux-gnu'
check "client is the aarch64 linux build" \
  test "$(installed .config/devc-bridge/client/devc-bridge)" = 'client v9.9.9 aarch64-unknown-linux-gnu'

echo "case 3: macOS arm64 — three binaries, and the client is LINUX arm64"
run_install darwin-arm Darwin arm64
check "exit 0" test $? -eq 0
check "devc is the arm64 darwin build" \
  test "$(installed .local/bin/devc)" = 'devc v9.9.9 aarch64-apple-darwin'
check "host bridge is the arm64 darwin build" \
  test "$(installed .local/bin/devc-bridge)" = 'host v9.9.9 aarch64-apple-darwin'
check "client is arch-matched to the HOST, i.e. aarch64 LINUX" \
  test "$(installed .config/devc-bridge/client/devc-bridge)" = 'client v9.9.9 aarch64-unknown-linux-gnu'
check_out "reports the client's triple" 'aarch64-unknown-linux-gnu'

echo "case 4: macOS x86_64"
run_install darwin-x64 Darwin x86_64
check "exit 0" test $? -eq 0
check "devc is the x86_64 darwin build" \
  test "$(installed .local/bin/devc)" = 'devc v9.9.9 x86_64-apple-darwin'
check "host bridge is the x86_64 darwin build" \
  test "$(installed .local/bin/devc-bridge)" = 'host v9.9.9 x86_64-apple-darwin'
check "client is x86_64 LINUX" \
  test "$(installed .config/devc-bridge/client/devc-bridge)" = 'client v9.9.9 x86_64-unknown-linux-gnu'

# --- 5: unsupported platforms ----------------------------------------------------------

echo "case 5: unsupported platform aborts naming what is supported"
run_install win Windows_NT x86_64
check "nonzero exit" test $? -ne 0
check_out "names the OSes it supports" 'supported: macOS, Linux'
check "nothing installed" test ! -e "$HOME_DIR/.local/bin/devc"

run_install riscv Linux riscv64
check "nonzero exit on an unknown arch" test $? -ne 0
check_out "names the arches it supports" 'supported: x86_64, arm64/aarch64'

# --- 6: checksum verification ----------------------------------------------------------

echo "case 6: a corrupted checksums.txt entry aborts with nothing written"
BADREL="$WORK/badrelease/download/v9.9.9"
make_release "$BADREL" v9.9.9
sed -i 's/^[0-9a-f]\{64\}\(  devc-x86_64-unknown-linux-gnu\)/00000000000000000000000000000000000000000000000000000000000000ff\1/' \
  "$BADREL/checksums.txt"
run_install badsum Linux x86_64 DEVC_RELEASE_BASE="file://$WORK/badrelease"
check "nonzero exit" test $? -ne 0
check_out "says which asset mismatched" 'checksum mismatch for devc-x86_64-unknown-linux-gnu.tar.gz'
check_out "says nothing was installed" 'nothing was installed'
check "devc not installed" test ! -e "$HOME_DIR/.local/bin/devc"
check "client not installed either (staged first, installed last)" \
  test ! -e "$HOME_DIR/.config/devc-bridge/client/devc-bridge"

echo "case 6b: a tampered *archive* is caught the same way"
TAMPER="$WORK/tampered/download/v9.9.9"
make_release "$TAMPER" v9.9.9
make_archive "$TAMPER" devc-x86_64-unknown-linux-gnu.tar.gz devc 'pwned'
run_install tampered Linux x86_64 DEVC_RELEASE_BASE="file://$WORK/tampered"
check "nonzero exit" test $? -ne 0
check_out "reports a mismatch" 'checksum mismatch'
check "devc not installed" test ! -e "$HOME_DIR/.local/bin/devc"

echo "case 6c: an asset missing from checksums.txt is not silently trusted"
NOSUM="$WORK/nosum/download/v9.9.9"
make_release "$NOSUM" v9.9.9
grep -v 'devc-x86_64-unknown-linux-gnu' "$NOSUM/checksums.txt" > "$NOSUM/c2" && mv "$NOSUM/c2" "$NOSUM/checksums.txt"
run_install nosum Linux x86_64 DEVC_RELEASE_BASE="file://$WORK/nosum"
check "nonzero exit" test $? -ne 0
check_out "says the entry is missing" 'checksums.txt has no entry for'
check "devc not installed" test ! -e "$HOME_DIR/.local/bin/devc"

echo "case 6d: a missing asset fails cleanly"
GONE="$WORK/gone/download/v9.9.9"
make_release "$GONE" v9.9.9
rm "$GONE/devc-x86_64-unknown-linux-gnu.tar.gz"
run_install gone Linux x86_64 DEVC_RELEASE_BASE="file://$WORK/gone"
check "nonzero exit" test $? -ne 0
check_out "names the failed download" 'download failed'
check "devc not installed" test ! -e "$HOME_DIR/.local/bin/devc"

# --- 7: version resolution -------------------------------------------------------------

echo "case 7: version resolution"
run_install bare-version Linux x86_64 DEVC_VERSION=9.9.9
check "exit 0 with a v-less DEVC_VERSION" test $? -eq 0
check_out "normalizes it to a tag" 'installing v9.9.9'
check "and installs from it" test "$(installed .local/bin/devc)" = 'devc v9.9.9 x86_64-unknown-linux-gnu'

echo "case 7b: an unstamped copy resolves the latest tag from the API"
printf '{"url":"x","tag_name": "v9.9.9", "name":"9.9.9"}\n' > "$WORK/latest.json"
HOME_DIR="$WORK/home/api"; mkdir -p "$HOME_DIR"
env -i PATH="$STUB:/usr/local/bin:/usr/bin:/bin" HOME="$HOME_DIR" \
  FAKE_OS=Linux FAKE_ARCH=x86_64 \
  DEVC_RELEASE_BASE="file://$WORK/release" \
  DEVC_API_LATEST="file://$WORK/latest.json" \
  sh "$SCRIPT" > "$WORK/out.log" 2>&1
check "exit 0" test $? -eq 0
check_out "used the tag from the API" 'installing v9.9.9'
check "installed it" test "$(installed .local/bin/devc)" = 'devc v9.9.9 x86_64-unknown-linux-gnu'

echo "case 7c: a stamped copy needs no API at all"
sed 's/^DEVC_RELEASE_VERSION=.*/DEVC_RELEASE_VERSION='"'"'v9.9.9'"'"'/' "$SCRIPT" > "$WORK/stamped.sh"
grep -q "^DEVC_RELEASE_VERSION='v9.9.9'$" "$WORK/stamped.sh" ||
  { echo "  FAIL the stamp fence does not match what the workflow substitutes"; fails=$((fails + 1)); }
HOME_DIR="$WORK/home/stamped"; mkdir -p "$HOME_DIR"
env -i PATH="$STUB:/usr/local/bin:/usr/bin:/bin" HOME="$HOME_DIR" \
  FAKE_OS=Linux FAKE_ARCH=x86_64 \
  DEVC_RELEASE_BASE="file://$WORK/release" \
  DEVC_API_LATEST='file:///nonexistent/must-not-be-read' \
  sh "$WORK/stamped.sh" > "$WORK/out.log" 2>&1
check "exit 0 without touching the API" test $? -eq 0
check_out "installed the stamped version" 'installing v9.9.9'

# --- 8: DEVC_TOOLS ---------------------------------------------------------------------

echo "case 8: DEVC_TOOLS limits what is installed"
run_install only-devc Linux x86_64 DEVC_TOOLS=devc
check "exit 0" test $? -eq 0
check "devc installed" test -x "$HOME_DIR/.local/bin/devc"
check "client skipped" test ! -e "$HOME_DIR/.config/devc-bridge/client/devc-bridge"

run_install only-client Darwin arm64 DEVC_TOOLS=client
check "exit 0" test $? -eq 0
check "client installed" test -x "$HOME_DIR/.config/devc-bridge/client/devc-bridge"
check "devc skipped" test ! -e "$HOME_DIR/.local/bin/devc"
check "host bridge skipped" test ! -e "$HOME_DIR/.local/bin/devc-bridge"

run_install comma-list Darwin arm64 DEVC_TOOLS=devc,bridge
check "exit 0 with a comma-separated list" test $? -eq 0
check "devc installed" test -x "$HOME_DIR/.local/bin/devc"
check "bridge installed" test -x "$HOME_DIR/.local/bin/devc-bridge"
check "client skipped" test ! -e "$HOME_DIR/.config/devc-bridge/client/devc-bridge"

run_install bridge-on-linux Linux x86_64 DEVC_TOOLS=bridge
check "nonzero exit — the host bridge is macOS-only" test $? -ne 0
check_out "says so" 'macOS-only'

run_install unknown-tool Linux x86_64 DEVC_TOOLS=devc,tray
check "nonzero exit on an unknown tool" test $? -ne 0
check_out "names the known tools" 'known: devc, bridge, client'

# --- 9: PATH advice --------------------------------------------------------------------

echo "case 9: DEVC_INSTALL_DIR off PATH warns with the export line"
run_install offpath Linux x86_64 DEVC_INSTALL_DIR="$WORK/home/offpath/opt/bin"
check "exit 0 — a PATH warning never blocks" test $? -eq 0
check "installed where asked" test -x "$WORK/home/offpath/opt/bin/devc"
check_out "warns" 'is not on your PATH'
check_out "prints the export line" "export PATH=\"$WORK/home/offpath/opt/bin:\$PATH\""

run_install onpath Linux x86_64 DEVC_INSTALL_DIR=/usr/local/bin DEVC_TOOLS=client
check "exit 0" test $? -eq 0
check_no_out "no PATH warning for a dir already on PATH" 'is not on your PATH'

# --- 10: upgrade in place --------------------------------------------------------------

echo "case 10: re-running the installer upgrades in place"
NEWREL="$WORK/release/download/v9.9.10"
make_release "$NEWREL" v9.9.10
run_install upgrade Linux x86_64
check "first install is 9.9.9" test "$(installed .local/bin/devc)" = 'devc v9.9.9 x86_64-unknown-linux-gnu'
FIRST_HOME="$HOME_DIR"
env -i PATH="$STUB:/usr/local/bin:/usr/bin:/bin" HOME="$FIRST_HOME" \
  FAKE_OS=Linux FAKE_ARCH=x86_64 \
  DEVC_RELEASE_BASE="file://$WORK/release" DEVC_VERSION=v9.9.10 \
  sh "$SCRIPT" > "$WORK/out.log" 2>&1
check "exit 0" test $? -eq 0
HOME_DIR="$FIRST_HOME"
check "devc replaced in place" test "$(installed .local/bin/devc)" = 'devc v9.9.10 x86_64-unknown-linux-gnu'
check "client replaced in place" \
  test "$(installed .config/devc-bridge/client/devc-bridge)" = 'client v9.9.10 x86_64-unknown-linux-gnu'
check "no stray temp files" test -z "$(find "$FIRST_HOME" -name '.devc*.tmp.*' -print -quit)"

echo "case 10b: an existing client (or devc's placeholder) is overwritten unconditionally"
mkdir -p "$FIRST_HOME/.config/devc-bridge/client"
printf '#!/bin/sh\necho placeholder\n' > "$FIRST_HOME/.config/devc-bridge/client/devc-bridge"
chmod 0755 "$FIRST_HOME/.config/devc-bridge/client/devc-bridge"
env -i PATH="$STUB:/usr/local/bin:/usr/bin:/bin" HOME="$FIRST_HOME" \
  FAKE_OS=Linux FAKE_ARCH=x86_64 \
  DEVC_RELEASE_BASE="file://$WORK/release" DEVC_VERSION=v9.9.9 \
  sh "$SCRIPT" > "$WORK/out.log" 2>&1
check "exit 0" test $? -eq 0
check "placeholder replaced by the real client" \
  test "$(installed .config/devc-bridge/client/devc-bridge)" = 'client v9.9.9 x86_64-unknown-linux-gnu'

# --- 11: the temp dir is cleaned up ----------------------------------------------------

echo "case 11: the temp dir is trap-cleaned on both paths"
mkdir -p "$WORK/tmp"
run_install cleanup Linux x86_64 TMPDIR="$WORK/tmp"
check "exit 0" test $? -eq 0
check "no temp dir survives a success" \
  test "$(find "$WORK/tmp" -maxdepth 1 -name 'devc-install.*' | wc -l)" -eq 0
run_install cleanup-fail Linux x86_64 TMPDIR="$WORK/tmp" DEVC_RELEASE_BASE="file://$WORK/gone"
check "nonzero exit" test $? -ne 0
check "no temp dir survives a failure either" \
  test "$(find "$WORK/tmp" -maxdepth 1 -name 'devc-install.*' | wc -l)" -eq 0

# --- 12: the matrix this installer expects ---------------------------------------------

echo "case 12: install.sh and the release workflow agree on the asset names"
WF="$(dirname "$SCRIPT")/.github/workflows/release.yml"
if [ -f "$WF" ]; then
  for asset in \
    devc-x86_64-unknown-linux-gnu devc-aarch64-unknown-linux-gnu \
    devc-x86_64-apple-darwin devc-aarch64-apple-darwin \
    devc-bridge-host-x86_64-apple-darwin devc-bridge-host-aarch64-apple-darwin \
    devc-bridge-client-x86_64-unknown-linux-gnu devc-bridge-client-aarch64-unknown-linux-gnu; do
    check "workflow builds $asset.tar.gz" grep -qF "$asset.tar.gz" "$WF"
  done
else
  echo "  skip (no $WF)"
fi

echo
if [ "$fails" -eq 0 ]; then echo "ALL PASS"; else echo "$fails FAILED"; exit 1; fi
