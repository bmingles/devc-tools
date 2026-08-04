#!/bin/bash
# devc Feature — create-time runtime setup.
#
# Declared as the Feature's postCreateCommand, so it runs *in addition to* any
# top-level postCreateCommand a project defines (Feature lifecycle hooks are
# additive; the top-level command is single-valued). Handles the volume-
# dependent steps that cannot run at build time because volumes are not mounted
# until the container is created.
set -e

# The isolated .claude volume mounts root-owned on first creation.
# Non-recursive: subpaths like skills/ are host bind mounts and must not be chowned.
sudo chown vscode:vscode /home/vscode/.claude

# ~/.claude host config seed. Every top-level *file* in the read-only seed bind mount is
# symlinked into the .claude volume, so host edits are live and host file modes (e.g. the
# statusline exec bit) are preserved. Directories are ignored by design: the devc:skills
# fence mounts per-skill binds under ~/.claude/skills/, and Docker has already materialized
# that directory by the time this runs — linking over it would either produce a nested
# skills/skills or fail on a busy mountpoint.
#
# Runs on every container create, so additions, edits, and deletions on the host all take
# effect without deleting the volume.
SEED=/usr/local/share/devc/claude-seed
CLAUDE_DIR=/home/vscode/.claude

# Drop links a previous create made whose seed file has since been removed or renamed. Only
# symlinks pointing into $SEED are touched, so volume state (projects/, todos/,
# .credentials.json) and the skills mountpoints are left alone. `-type l` uses lstat and
# readlink still reports a target, so a now-dangling link is caught here too.
if [ -d "$CLAUDE_DIR" ]; then
  while IFS= read -r -d '' link; do
    case "$(readlink "$link")" in
      "$SEED"/*) rm -f "$link" ;;
    esac
  done < <(find "$CLAUDE_DIR" -mindepth 1 -maxdepth 1 -type l -print0)
fi

if [ -d "$SEED" ]; then
  while IFS= read -r -d '' src; do
    name="$(basename "$src")"
    dest="$CLAUDE_DIR/$name"
    if [ -L "$src" ] && [ ! -e "$src" ]; then
      echo "devc: skipping $name — host symlink dangles in the container; use a real file"
      continue
    fi
    # -f follows symlinks; skips directories and anything else non-regular.
    [ -f "$src" ] || continue
    if [ -e "$dest" ] && [ ! -L "$dest" ] && [ ! -f "$dest" ]; then
      echo "devc: skipping $name — $dest exists and is not a regular file"
      continue
    fi
    if [ -f "$dest" ] && [ ! -L "$dest" ]; then
      echo "devc: replacing volume-local $name with the host seed copy"
    fi
    ln -sfn "$src" "$dest" || echo "devc: could not link $dest (bind-mounted?)"
  done < <(find "$SEED" -mindepth 1 -maxdepth 1 -print0)
fi

# ~/.claude.json (auth) is persisted in a per-workspace volume, mounted as a
# directory at ~/.claude-json-vol. Seed the backing file on first run, then
# symlink it into place so Claude Code reads/writes through the volume.
sudo chown vscode:vscode /home/vscode/.claude-json-vol
if [ ! -f /home/vscode/.claude-json-vol/claude.json ]; then
  echo '{}' > /home/vscode/.claude-json-vol/claude.json
fi
if [ ! -L /home/vscode/.claude.json ]; then
  rm -f /home/vscode/.claude.json
  ln -s /home/vscode/.claude-json-vol/claude.json /home/vscode/.claude.json
fi

cd "${PROJECT_PATH:-$PWD}"

export NVM_DIR="/usr/local/share/nvm"
# shellcheck source=/dev/null
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

if [ -f .nvmrc ]; then
  sudo chown -R vscode:vscode "$PWD/node_modules" 2>/dev/null || true
  nvm install
fi
