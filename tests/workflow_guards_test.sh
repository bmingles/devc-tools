#!/bin/bash
# Asserts two things about the publishing workflows, both of which fail silently in the worst
# way — by publishing something:
#
#   1. every step that publishes something irreversible is gated on BOTH the ref being a v*
#      tag AND the run not being a dry run;
#   2. publish-feature.yml's version guard covers the whole Feature collection rather than a
#      named Feature, and the collection's own versions agree.
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
# Deliberately NOT covered by (1): publish-feature.yml's version guard, which is gated on the
# ref alone on purpose — a dry run against a tag should still check the tag against every
# Feature's version. That is a check, not a publish. (2) covers what that guard *checks*, not
# when it runs.
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

# The body of a named step's `run: |` block: every line indented deeper than the `run:` key
# itself, which is where a block scalar ends.
step_run() { # step_run <file> <step name>
  awk -v name="- name: $2" '
    index($0, name) { found = 1; next }
    found && !inrun && /^ *run: *\|/ { match($0, /^ */); indent = RLENGTH; inrun = 1; next }
    found && !inrun && /^ *- (name|uses):/ { exit }
    inrun && /^[[:space:]]*$/ { print ""; next }
    inrun { match($0, /^ */); if (RLENGTH <= indent) exit; print }
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
echo 'the Feature version guard walks the collection instead of naming a Feature'
guard_run="$(step_run .github/workflows/publish-feature.yml 'Version guard')"

# `features publish ./features` walks the whole directory, so a guard that spelled out an id
# would check one Feature and publish the rest unchecked — invisible until someone pulls a
# Feature whose version disagrees with the tag it was published under. Asserting the *absence*
# of every current id is what makes that impossible to reintroduce for the next Feature too;
# asserting it works is Actions' job, not this harness's.
guard_found() { [ -n "$guard_run" ] || { echo '       (no `run:` block found for Version guard)'; return 1; }; }

guard_names_no_feature() {
  local bad=0 id
  for dir in "${feature_dirs[@]}"; do
    id="$(basename "$dir")"
    case "$guard_run" in
      *"$id"*)
        echo "       (guard names $id literally — the next Feature would publish unguarded)"
        bad=1
        ;;
    esac
  done
  return "$bad"
}

guard_walks_collection() {
  case "$guard_run" in
    *'features/*/devcontainer-feature.json'*) return 0 ;;
  esac
  echo '       (guard does not iterate features/*/devcontainer-feature.json)'
  return 1
}

# `features/*/` with no match arrives as its own literal, which is the empty-collection case
# the guard itself must fail on — so the harness has to notice it too.
feature_dirs=()
for dir in features/*/; do
  [ -f "$dir/devcontainer-feature.json" ] && feature_dirs+=("${dir%/}")
done

if [ "${#feature_dirs[@]}" -eq 0 ]; then
  echo '  FAIL features/ contains no Feature'
  fails=$((fails + 1))
else
  check 'publish-feature.yml — Version guard has a run: block' guard_found
  check 'publish-feature.yml — Version guard names no Feature literally' guard_names_no_feature
  check 'publish-feature.yml — Version guard iterates the collection' guard_walks_collection
fi

echo
echo 'one repo, one version — every Feature agrees with the collection'

# What the guard checks on a tag, checked here without one: `id` must equal the directory
# (`features package` names the artifact from it) and every Feature must carry the same
# version, since the tag is compared against all of them. Both are pure repo state, so they
# can rot between releases — this is the part that catches it before the tag does.
manifest_id() { jq -r .id "$1/devcontainer-feature.json"; }
manifest_version() { jq -r .version "$1/devcontainer-feature.json"; }

id_matches_dir() { # id_matches_dir <feature dir>
  local id
  id="$(manifest_id "$1")" || return 1
  [ "$id" = "$(basename "$1")" ] && return 0
  echo "       (id '$id' does not match directory '$(basename "$1")')"
  return 1
}

version_is() { # version_is <feature dir> <expected>
  local version
  version="$(manifest_version "$1")" || return 1
  [ "$version" = "$2" ] && return 0
  echo "       (version '$version' does not match '$2')"
  return 1
}

if [ "${#feature_dirs[@]}" -gt 0 ]; then
  collection_version="$(manifest_version "${feature_dirs[0]}")"
  echo "  (collection version: $collection_version)"
  for dir in "${feature_dirs[@]}"; do
    check "$dir — id equals its directory name" id_matches_dir "$dir"
    check "$dir — version is $collection_version" version_is "$dir" "$collection_version"
  done
fi

echo
if [ "$fails" -eq 0 ]; then echo 'ALL PASS'; else echo "$fails FAILED"; fi
exit "$((fails > 0))"
