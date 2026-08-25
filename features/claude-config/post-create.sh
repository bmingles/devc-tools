#!/bin/bash
# claude-config create-time step — wires ~/.claude and ~/.claude.json to whatever persistence and
# seed the consumer has mounted.
#
# install.sh copies this file to /usr/local/share/devc-features/claude-config/post-create.sh at
# image build time and bakes CLAUDE_DIR, SEED_DIR and CLAUDE_JSON_DIR below; the manifest's
# postCreateCommand names that copy, and the devcontainer CLI runs it as the remote user, before
# any user postCreateCommand.
#
# Copied from devc-core/default/scripts/agents-setup.sh — see README.md's "Relationship to devc"
# for which file is which. The devc:seed-link block below is copied verbatim from that file: only
# its two parameterizing assignments (SEED and CLAUDE_DIR) differ, pointed at this Feature's
# baked options instead of devc's hardcoded paths, so devc/tests/seed_link_test.sh runs against
# both copies unmodified.
#
# The script must exit 0 on every skip path: a postCreateCommand that fails aborts container
# creation, and none of the skips here (no seedDir, no claudeJsonDir, ownership already correct)
# is worth an unbootable container.
set -e

warn() {
  echo "claude-config: $*" >&2
}

# --- baked by install.sh from the Feature's options ------------------------------------------
# CLAUDE_DIR is always a resolved absolute path by the time install.sh finishes (an empty
# claudeDir option resolves to $_REMOTE_USER_HOME/.claude there, not here); `${VAR-}` only
# matters when this file is run standalone, unbaked.
CLAUDE_DIR="${CLAUDE_DIR-}"
SEED_DIR="${SEED_DIR-}"
CLAUDE_JSON_DIR="${CLAUDE_JSON_DIR-}"
# -----------------------------------------------------------------------------------------------

# --- 1. ownership repair -------------------------------------------------------------------
# Belt-and-braces: install.sh already pre-creates CLAUDE_DIR owned by the remote user at build
# time, and whether a first-use empty named volume mounted over it at create time inherits that
# ownership is unmeasured (no Docker in the environment this Feature was written in — see
# .plans/design/devc-feature-split.md, open question 3). Cheap either way, so it stays.
#
# Non-recursive — a hard requirement, not a style choice: subpaths like skills/ are host bind
# mounts and must not be chowned.
if [ -d "$CLAUDE_DIR" ]; then
  owner="$(stat -c '%U' "$CLAUDE_DIR" 2> /dev/null || true)"
  if [ -n "$owner" ] && [ "$owner" != "$(id -un)" ]; then
    if command -v sudo > /dev/null 2>&1; then
      sudo chown "$(id -un)" "$CLAUDE_DIR" || warn "could not chown $CLAUDE_DIR"
    else
      warn "$CLAUDE_DIR is owned by $owner and no sudo is available to fix it"
    fi
  fi
fi

# devc:seed-link (start) — devc/tests/seed_link_test.sh runs everything between these two
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
SEED="$SEED_DIR"
CLAUDE_DIR="$CLAUDE_DIR"

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

# --- 3. ~/.claude.json ---------------------------------------------------------------------
# A volume can only mount at a directory, so a per-workspace ~/.claude.json (a file) cannot be a
# mount target directly: claudeJsonDir names the directory instead, and ~/.claude.json is
# symlinked to a file inside it, seeded on first run so Claude Code reads/writes through it.
# Empty (the default) leaves ~/.claude.json alone entirely — the plain file Claude Code creates
# itself, for a consumer with nothing mounted here.
if [ -n "$CLAUDE_JSON_DIR" ]; then
  if command -v sudo > /dev/null 2>&1; then
    sudo chown "$(id -un)" "$CLAUDE_JSON_DIR" || warn "could not chown $CLAUDE_JSON_DIR"
  else
    warn "no sudo available to chown $CLAUDE_JSON_DIR"
  fi
  if [ ! -f "$CLAUDE_JSON_DIR/claude.json" ]; then
    echo '{}' > "$CLAUDE_JSON_DIR/claude.json"
  fi
  if [ ! -L "$HOME/.claude.json" ]; then
    rm -f "$HOME/.claude.json"
    ln -s "$CLAUDE_JSON_DIR/claude.json" "$HOME/.claude.json"
  fi
fi
