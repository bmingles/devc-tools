#!/bin/bash
# Asserts that every step which publishes something irreversible is gated on BOTH the ref
# being a v* tag AND the run not being a dry run.
#
#   bash tests/workflow_guards_test.sh
#
# Why this exists: `workflow_dispatch` can target a *tag*, not just a branch. Gating a
# publish on `startsWith(github.ref, 'refs/tags/v')` alone therefore publishes from a run
# whose own `dry_run` checkbox said not to — a GitHub release people may already have
# curled, and a ghcr.io tag that cannot be un-pushed. Both workflows shipped that way; this
# harness is what keeps the fix from being undone by a later edit that only looks at the ref.
#
# `inputs` is null outside workflow_dispatch, so `!inputs.dry_run` is true on a tag push and
# ordinary tag releases are unaffected.
#
# Deliberately NOT covered: publish-feature.yml's version guard, which is gated on the ref
# alone on purpose — a dry run against a tag should still check the tag against the
# Feature's version. That is a check, not a publish.
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1

fails=0
check() { # check <desc> <condition-as-args...>
  local desc="$1"; shift
  if "$@"; then echo "  ok   $desc"; else echo "  FAIL $desc"; fails=$((fails + 1)); fi
}

# The `if:` line belonging to a named step: the first one within the few lines following it.
step_guard() { # step_guard <file> <step name>
  awk -v name="- name: $2" '
    index($0, name) { found = 1; next }
    found && /^ *if:/ { sub(/^ *if: */, ""); print; exit }
    found && /^ *- (name|uses):/ { exit }
  ' "$1"
}

guards_both() { # guards_both <file> <step name>
  local guard
  guard="$(step_guard "$1" "$2")"
  [ -n "$guard" ] || { echo "       (no if: found for '$2' in $1)"; return 1; }
  case "$guard" in
    *"startsWith(github.ref, 'refs/tags/v')"*) ;;
    *) echo "       (not tag-gated: $guard)"; return 1 ;;
  esac
  case "$guard" in
    *'!inputs.dry_run'*) ;;
    *) echo "       (not dry-run-gated: $guard)"; return 1 ;;
  esac
  return 0
}

echo 'publishing steps are gated on the tag AND on dry_run'
check 'release.yml — Publish release' \
  guards_both .github/workflows/release.yml 'Publish release'
check 'publish-feature.yml — Publish' \
  guards_both .github/workflows/publish-feature.yml 'Publish'
check 'publish-feature.yml — Log in to ghcr.io' \
  guards_both .github/workflows/publish-feature.yml 'Log in to ghcr.io'

echo
echo 'both workflows still declare the dry_run input they are gated on'
for f in .github/workflows/release.yml .github/workflows/publish-feature.yml; do
  check "$(basename "$f") declares dry_run" grep -q '^      dry_run:' "$f"
done

echo
if [ "$fails" -eq 0 ]; then echo 'ALL PASS'; else echo "$fails FAILED"; fi
exit "$((fails > 0))"
