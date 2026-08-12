#!/bin/bash
# Asserts one thing about the publishing workflows, and it is the one that fails silently in
# the worst way — by publishing something: **every step that publishes something
# irreversible is gated on BOTH the expected ref AND the run not being a dry run.**
#
#   bash tests/workflow_guards_test.sh
#
# Why this exists: `workflow_dispatch` can target any ref, a *tag* included. Gating a publish
# on the ref alone therefore publishes from a run whose own `dry_run` checkbox said not to —
# a GitHub release people may already have curled, and a ghcr.io tag that cannot be
# un-pushed. Both workflows shipped that way; this harness is what keeps the fix from being
# undone by a later edit that only looks at the ref.
#
# The two workflows expect *different* refs, which is why the expression is a parameter here
# rather than baked in: release.yml publishes binaries from a `v*` tag, while
# publish-feature.yml publishes Features from a push to `main`, each Feature at its own
# version (see .plans/archived/feature-independent-versions.md).
#
# `inputs` is null outside workflow_dispatch, so `!inputs.dry_run` is true on an ordinary
# push or tag and normal releases are unaffected.
#
# What the workflows *check* rather than publish is not covered here. That is
# `tests/features_test.sh`, which the publish workflow runs and which — unlike a guard
# inlined in YAML — is callable directly, so this harness no longer scrapes a `run:` block
# out of the file to make assertions about the shell inside it.
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

guards_both() { # guards_both <file> <step name> <expected ref expression>
  local guard
  guard="$(step_guard "$1" "$2")"
  [ -n "$guard" ] || { echo "       (no if: found for '$2' in $1)"; return 1; }
  case "$guard" in
    *"$3"*) ;;
    *) echo "       (not gated on $3: $guard)"; return 1 ;;
  esac
  case "$guard" in
    *'!inputs.dry_run'*) ;;
    *) echo "       (not dry-run-gated: $guard)"; return 1 ;;
  esac
  return 0
}

echo 'publishing steps are gated on the expected ref AND on dry_run'
check 'release.yml — Publish release' \
  guards_both .github/workflows/release.yml 'Publish release' \
  "startsWith(github.ref, 'refs/tags/v')"
check 'publish-feature.yml — Publish' \
  guards_both .github/workflows/publish-feature.yml 'Publish' \
  "github.ref == 'refs/heads/main'"
check 'publish-feature.yml — Log in to ghcr.io' \
  guards_both .github/workflows/publish-feature.yml 'Log in to ghcr.io' \
  "github.ref == 'refs/heads/main'"

echo
echo 'both workflows still declare the dry_run input they are gated on'
for f in .github/workflows/release.yml .github/workflows/publish-feature.yml; do
  check "$(basename "$f") declares dry_run" grep -q '^      dry_run:' "$f"
done

echo
if [ "$fails" -eq 0 ]; then echo 'ALL PASS'; else echo "$fails FAILED"; fi
exit "$((fails > 0))"
