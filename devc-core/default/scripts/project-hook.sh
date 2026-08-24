#!/bin/bash
# Project extension point — run the project's own create-time script, if it has one.
#
# devc owns this file and regenerates it; it never touches the project's hook. Both
# locations are first-class and first-hit-wins, matching the devc.json overlay's own
# search order (.devc/ before .devcontainer/).
#
# Existence selects, executability is enforced: a candidate that is genuinely absent is
# skipped, but one that exists either runs or fails this script. A present-but-unrunnable
# hook is a mistake to surface, not a reason to silently run a different file — so there is
# no path on which a hook that exists is quietly skipped.
#
# The hook runs with cwd set to the project root, so it can use paths relative to the
# repo. It is invoked directly under `set -e`, so its exit code fails container create.
# devc:project-hook (start)
set -e
PROJECT_ROOT="${PROJECT_PATH:-$PWD}"
# Each step of post-create.sh is its own `bash` invocation, so the project cwd is not
# inherited from the orchestrator — establish it here, for the hook's benefit.
cd "$PROJECT_ROOT"
for candidate in \
  "$PROJECT_ROOT/.devc/devc-post-create.sh" \
  "$PROJECT_ROOT/.devcontainer/devc-post-create.sh"; do
  # `-e` is false for a dangling symlink, so `-L` catches that case too and lets it fall
  # into the not-executable error below rather than being skipped as absent.
  [ -e "$candidate" ] || [ -L "$candidate" ] || continue
  if [ ! -x "$candidate" ]; then
    echo "devc: $candidate is not executable — chmod +x it, or remove it" >&2
    exit 1
  fi
  echo "devc: running $candidate"
  "$candidate"
  break
done
# devc:project-hook (end)
