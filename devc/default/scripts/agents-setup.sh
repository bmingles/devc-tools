#!/bin/bash
# devc create-time: Claude Code / agent config. Owns the isolated ~/.claude volume,
# symlinks the host seed files into it, and routes ~/.claude.json through its
# per-workspace volume. (Copilot or other agent setup would join here.)
set -e

# The isolated .claude volume mounts root-owned on first creation.
# Non-recursive: subpaths like skills/ are host bind mounts and must not be chowned.
sudo chown vscode:vscode /home/vscode/.claude

# devc:seed-link (start) — tests/seed_link_test.sh runs everything between these two
# markers against temp dirs, so keep the block self-contained (parameterized only by
# SEED and CLAUDE_DIR; no sudo, no paths outside them).
#
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
# devc:seed-link (end)

# ~/.claude.json (auth) is persisted in a per-workspace volume. A volume can only mount at a
# directory, so it mounts at /usr/local/share/devc/claude-json (devc's namespace, out of ~,
# alongside claude-seed) and ~/.claude.json is symlinked to the backing file — seeded on first
# run so Claude Code reads/writes through the volume.
JSON_VOL=/usr/local/share/devc/claude-json
sudo chown vscode:vscode "$JSON_VOL"
if [ ! -f "$JSON_VOL/claude.json" ]; then
  echo '{}' > "$JSON_VOL/claude.json"
fi
if [ ! -L /home/vscode/.claude.json ]; then
  rm -f /home/vscode/.claude.json
  ln -s "$JSON_VOL/claude.json" /home/vscode/.claude.json
fi
