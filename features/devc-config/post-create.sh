#!/bin/bash
# devc-config create-time script — run the project's own create-time script, if it has one.
#
# install.sh copies this file, unmodified, to
# /usr/local/share/devc-features/devc-config/post-create.sh at image build time; the manifest's
# postCreateCommand names that copy directly, so there is nothing to bake and no options cross
# into this file. The devcontainer CLI runs it AS THE REMOTE USER, and runs every
# Feature-declared postCreateCommand BEFORE the one the consumer's own devcontainer.json
# declares — so this hook's exit code can fail create before the project's own
# postCreateCommand, if any, ever starts.
#
# devc/tests/devc_config_test.sh extracts the devc:devc-config fence below and runs it —
# unmodified — against this file directly, so the test cannot drift from the implementation.
# Nothing inside the fence may be reformatted, reworded, or have a comment dropped for
# tidiness; every line inside it is load-bearing for one of the eight cases that harness
# asserts.
# devc:devc-config (start)
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
# devc:devc-config (end)
