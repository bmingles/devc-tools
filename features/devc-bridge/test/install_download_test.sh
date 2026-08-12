#!/bin/bash
# Exercises the Feature install.sh's client download against a local fixture "release"
# served over file://, with no network, no Docker and nothing real installed.
#
#   bash features/devc-bridge/test/install_download_test.sh features/devc-bridge/install.sh
#
# In the style of tests/install_test.sh: `uname` is stubbed on PATH rather than the script
# being parameterized, so the real arch-detection code runs, and downloads come from a
# file:// URL via DEVC_RELEASE_BASE so the real curl/tar/sha256sum path runs too.
#
# The two things worth testing offline are the two this script is easiest to get wrong:
#
#   • the arch → asset mapping. Unlike the release installer — which runs on the host and
#     must pick the *container's* arch — this runs inside the image being built, so
#     `uname -m` is the answer. Pinned here so a later "simplification" cannot reintroduce
#     the host-arch reasoning that does not apply.
#   • the failure paths — bad checksum, missing asset, missing checksums entry,
#     unsupported arch — every one of which must abort with nothing installed. A Feature
#     that unpacks an unverified binary onto PATH is the thing the checksum exists to stop.
set -uo pipefail

SCRIPT="$(cd "$(dirname "${1:?usage: install_download_test.sh /path/to/install.sh}")" && pwd)/$(basename "$1")"
[ -f "$SCRIPT" ] || { echo "no such script: $SCRIPT"; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

fails=0
check() { # check <desc> <condition-as-args...>
  local desc="$1"; shift
  if "$@"; then echo "  ok   $desc"; else echo "  FAIL $desc"; fails=$((fails + 1)); fi
}
check_out() { # check_out <desc> <expected-substring>
  local desc="$1" pat="$2"
  if grep -qF -- "$pat" "$WORK/out.log"; then
    echo "  ok   $desc"
  else
    echo "  FAIL $desc (no '$pat' in output)"; sed 's/^/       | /' "$WORK/out.log"
    fails=$((fails + 1))
  fi
}

# The version the Feature bakes in — read from the script so the fixture always describes
# the release the script will actually ask for.
VERSION="$(sed -n "s/^FEATURE_VERSION='\(.*\)'$/\1/p" "$SCRIPT")"
[ -n "$VERSION" ] || { echo "could not read FEATURE_VERSION from $SCRIPT"; exit 1; }

# --- the fixture release -----------------------------------------------------------------

# Each fake client prints the triple it came from, so asserting on the *installed* binary
# proves which archive was chosen — the mapping test, not just "a file appeared".
make_release() { # make_release <dir> <version>
  local dir="$1" v="$2" t
  mkdir -p "$dir/download/v$v"
  for t in x86_64-unknown-linux-gnu aarch64-unknown-linux-gnu; do
    local stage="$WORK/stage-$t"
    rm -rf "$stage"; mkdir -p "$stage"
    printf '#!/bin/sh\necho %s\n' "$t" > "$stage/devc-bridge"
    chmod 755 "$stage/devc-bridge"
    tar -czf "$dir/download/v$v/devc-bridge-client-$v-$t.tar.gz" -C "$stage" devc-bridge
  done
  ( cd "$dir/download/v$v" && sha256sum ./*.tar.gz | sed 's|\./||' > checksums.txt )
}

RELEASE="$WORK/release"
make_release "$RELEASE" "$VERSION"

# `uname -m` stub. Everything else on PATH stays real.
stub_uname() { # stub_uname <machine>
  mkdir -p "$WORK/bin"
  cat > "$WORK/bin/uname" <<EOF
#!/bin/sh
case "\${1:-}" in
  -m) echo "$1" ;;
  *) exec /usr/bin/uname "\$@" ;;
esac
EOF
  chmod 755 "$WORK/bin/uname"
}

# Run the real script with the client path and release base pointed at temp dirs.
# Sets $status and writes combined output to $WORK/out.log.
run_install() { # run_install <machine> <release-base> <dest-root> [extra env...]
  local machine="$1" base="$2" root="$3"; shift 3
  stub_uname "$machine"
  rm -rf "$root"; mkdir -p "$root/share" "$root/bin"
  set +e
  env "$@" \
    PATH="$WORK/bin:$PATH" \
    DEVC_RELEASE_BASE="$base" \
    BRIDGE_CLIENT="$root/share/devc-bridge" \
    BRIDGE_LINK="$root/bin/devc-bridge" \
    sh "$SCRIPT" > "$WORK/out.log" 2>&1
  status=$?
  set -e
}

echo "case 1: x86_64 gets the x86_64 client, on PATH and executable"
R="$WORK/c1"
run_install x86_64 "file://$RELEASE" "$R"
check "exit 0" test "$status" -eq 0
check "client installed" test -f "$R/share/devc-bridge"
check "is executable" test -x "$R/share/devc-bridge"
check "chose the x86_64 asset" \
  test "$("$R/share/devc-bridge")" = "x86_64-unknown-linux-gnu"
check "link is a symlink at it" test -L "$R/bin/devc-bridge"
check "and runs through the link" \
  test "$("$R/bin/devc-bridge")" = "x86_64-unknown-linux-gnu"
check "no temp file left beside it" \
  bash -c "! ls '$R/share/'devc-bridge.tmp.* >/dev/null 2>&1"

echo "case 2: aarch64 gets the aarch64 client (and arm64 is the same machine)"
R="$WORK/c2"
run_install aarch64 "file://$RELEASE" "$R"
check "exit 0" test "$status" -eq 0
check "chose the aarch64 asset" \
  test "$("$R/share/devc-bridge")" = "aarch64-unknown-linux-gnu"
R="$WORK/c2b"
run_install arm64 "file://$RELEASE" "$R"
check "arm64 → aarch64 asset" \
  test "$("$R/share/devc-bridge")" = "aarch64-unknown-linux-gnu"
R="$WORK/c2c"
run_install amd64 "file://$RELEASE" "$R"
check "amd64 → x86_64 asset" \
  test "$("$R/share/devc-bridge")" = "x86_64-unknown-linux-gnu"

echo "case 3: a tampered archive aborts with nothing installed"
# The whole reason the checksum is here. Corrupt the asset *after* checksums.txt was
# written, exactly as a substituted download would look.
BAD="$WORK/release-bad"
cp -r "$RELEASE" "$BAD"
printf 'not the client you asked for' \
  > "$BAD/download/v$VERSION/devc-bridge-client-$VERSION-x86_64-unknown-linux-gnu.tar.gz"
R="$WORK/c3"
run_install x86_64 "file://$BAD" "$R"
check "non-zero exit" test "$status" -ne 0
check_out "says checksum mismatch" "checksum mismatch"
check_out "says nothing was installed" "nothing was installed"
check "no client installed" test ! -e "$R/share/devc-bridge"
check "no link created" test ! -e "$R/bin/devc-bridge"

echo "case 4: an asset missing from checksums.txt aborts"
NOSUM="$WORK/release-nosum"
cp -r "$RELEASE" "$NOSUM"
grep -v 'x86_64-unknown-linux-gnu' "$NOSUM/download/v$VERSION/checksums.txt" \
  > "$NOSUM/download/v$VERSION/checksums.txt.new"
mv "$NOSUM/download/v$VERSION/checksums.txt.new" "$NOSUM/download/v$VERSION/checksums.txt"
R="$WORK/c4"
run_install x86_64 "file://$NOSUM" "$R"
check "non-zero exit" test "$status" -ne 0
check_out "names the missing entry" "checksums.txt has no entry"
check "no client installed" test ! -e "$R/share/devc-bridge"

echo "case 5: a missing asset aborts"
GONE="$WORK/release-gone"
cp -r "$RELEASE" "$GONE"
rm "$GONE/download/v$VERSION/devc-bridge-client-$VERSION-x86_64-unknown-linux-gnu.tar.gz"
R="$WORK/c5"
run_install x86_64 "file://$GONE" "$R"
check "non-zero exit" test "$status" -ne 0
check_out "says the download failed" "download failed"
check "no client installed" test ! -e "$R/share/devc-bridge"

echo "case 6: an unsupported architecture aborts before any download"
R="$WORK/c6"
run_install riscv64 "file://$RELEASE" "$R"
check "non-zero exit" test "$status" -ne 0
check_out "names the architecture" "unsupported architecture riscv64"
check "no client installed" test ! -e "$R/share/devc-bridge"

echo "case 7: clientVersion overrides the baked-in version"
# Pins the option's env-var name: the CLI passes `clientVersion` as $CLIENTVERSION
# (getSafeId uppercases and strips non-word chars). Getting this name wrong would silently
# ignore the option, so assert the override actually reaches the asset URL.
ALT='9.9.9'
make_release "$RELEASE" "$ALT"
R="$WORK/c7"
run_install x86_64 "file://$RELEASE" "$R" CLIENTVERSION="$ALT"
check "exit 0" test "$status" -eq 0
check_out "installed the overridden version" "client $ALT"
R="$WORK/c7b"
run_install x86_64 "file://$RELEASE" "$R" CLIENTVERSION="v$ALT"
check "a leading v is accepted too" test "$status" -eq 0
check_out "same bare version in the asset" "client $ALT"

echo "case 8: an empty clientVersion falls back to the baked-in version"
R="$WORK/c8"
run_install x86_64 "file://$RELEASE" "$R" CLIENTVERSION=""
check "exit 0" test "$status" -eq 0
check_out "used the Feature's own version" "client $VERSION"

echo
if [ "$fails" -eq 0 ]; then
  echo "all cases ok"
else
  echo "$fails check(s) FAILED"
fi
exit "$fails"
