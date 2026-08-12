#!/bin/sh
# shell-dirs create-time step — resolve the workspace-relative projectDir to an absolute path
# and bake it into the ~/.bashrc block install.sh already wrote at build time.
#
# Why this exists. install.sh runs at image *build* time, where the workspace is not mounted and
# its path is unknowable, so the block it writes defers to $PROJECT_PATH at shell time. That
# made an environment variable the consumer had to set a prerequisite for a bare `{}` to do
# anything at all — which is not a Feature that "installs cleanly and does something useful".
# A lifecycle hook runs at *create* time, and the CLI hands every hook the workspace folder as
# its cwd, so the path can be resolved here, once. $PROJECT_PATH becomes an override rather
# than a requirement.
#
# Only the *path* is baked. Every shell still reads the directory's contents fresh, so adding a
# file after create still needs no rebuild — that property is the whole point of the Feature and
# nothing here touches it.
set -e

# install.sh rewrites this line with the projectDir option. Keep the `${VAR:-default}` shape:
# it is what makes this file runnable on its own, and what install.sh's bake() verifies.
PROJECT_DIR="${PROJECT_DIR:-.devcontainer/shell}"

BASHRC="${_SHELL_DIRS_BASHRC:-$HOME/.bashrc}"
START_MARKER='# >>> shell-dirs >>>'
END_MARKER='# <<< shell-dirs <<<'

case "$PROJECT_DIR" in
  # The layer is switched off. Nothing to resolve, and nothing to say about it.
  '') exit 0 ;;
  # Already a fixed container path: install.sh wrote it verbatim and it never consulted
  # PROJECT_PATH in the first place.
  /*) exit 0 ;;
esac

# autoAppend=false, a hand-edited ~/.bashrc, or a shell that is not bash — all reasons the block
# may not be there. None of them is this script's business to repair.
[ -f "$BASHRC" ] || exit 0
grep -qF "$START_MARKER" "$BASHRC" 2> /dev/null || exit 0

if [ -n "${PROJECT_PATH:-}" ]; then
  WS="$PROJECT_PATH"
else
  WS="$PWD"
  # runLifecycleHook computes one cwd for every lifecycle command:
  #
  #   remoteCwd = containerProperties.remoteWorkspaceFolder || containerProperties.homeFolder
  #
  # so a cwd equal to the home folder is precisely the branch where there is no workspace
  # folder to have been given. Baking $HOME/.devcontainer/shell there would be actively worse
  # than leaving the block deferring to PROJECT_PATH, so decline, and say which of the two
  # things to set.
  if [ "$WS" = "$HOME" ]; then
    echo "shell-dirs: no PROJECT_PATH, and the cwd is the home folder — this container has no" >&2
    echo "shell-dirs: workspace folder, so the project layer cannot be resolved at create time." >&2
    echo "shell-dirs: it still works if you set PROJECT_PATH as remoteEnv, or give projectDir" >&2
    echo "shell-dirs: an absolute container path. Nothing was changed." >&2
    exit 0
  fi
fi

RESOLVED="$WS/$PROJECT_DIR"
LINE="PROJECT_SHELL_DIR=\"$RESOLVED\""

# Rewritten only *between this Feature's own markers*. A devc container in the interim has two
# copies of the devc:shell-dirs block in one ~/.bashrc, and devc's copy is not ours to edit —
# an unscoped `/^PROJECT_SHELL_DIR=/` would rewrite both.
TMP="$BASHRC.shell-dirs.$$"
trap 'rm -f "$TMP"' EXIT
awk -v p="$LINE" -v s="$START_MARKER" -v e="$END_MARKER" '
  index($0, s) == 1        { inblock = 1 }
  index($0, e) == 1        { inblock = 0 }
  inblock && /^PROJECT_SHELL_DIR=/ { print p; next }
                           { print }
' "$BASHRC" > "$TMP"

# cp onto the existing file rather than mv, so ~/.bashrc keeps its own inode, mode and owner —
# this hook runs as the remote user, and a replaced file would be theirs by luck rather than by
# construction.
cp "$TMP" "$BASHRC"

grep -qxF "$LINE" "$BASHRC" || {
  echo "shell-dirs: could not resolve the project layer into $BASHRC" >&2
  exit 1
}

echo "shell-dirs: project layer resolved to $RESOLVED"
