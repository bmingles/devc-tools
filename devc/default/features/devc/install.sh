#!/usr/bin/env bash
# devc Feature — build-time install.
#
# Runs as root during the image build (before any volumes are mounted), so it
# handles only build-time concerns: installing the Claude CLI, appending the
# shell additions to the vscode user's .bashrc, and dropping tmux.conf into
# place. Volume-dependent steps (chown, symlink) live in post-create.sh, which
# the Feature declares as its postCreateCommand.
#
# Idempotent: safe to re-run on a rebuild.
set -euo pipefail

USERNAME="${_REMOTE_USER:-vscode}"
USER_HOME="$(getent passwd "$USERNAME" | cut -d: -f6)"
USER_HOME="${USER_HOME:-/home/$USERNAME}"

FEATURE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# --- tmux (image-level tool, needs root/apt) -------------------------------
if ! command -v tmux >/dev/null 2>&1; then
  apt-get update
  apt-get install -y --no-install-recommends tmux
  rm -rf /var/lib/apt/lists/*
fi

# --- Claude CLI (installed as the target user) -----------------------------
if [ ! -x "$USER_HOME/.local/bin/claude" ] && ! command -v claude >/dev/null 2>&1; then
  su - "$USERNAME" -c 'curl -fsSL https://claude.ai/install.sh | bash'
fi

# --- .bashrc additions (marker-guarded, no double-append on rebuild) -------
BASHRC="$USER_HOME/.bashrc"
MARKER="# >>> devc bashrc-additions >>>"
if ! grep -qF "$MARKER" "$BASHRC" 2>/dev/null; then
  {
    printf '%s\n' "$MARKER"
    cat "$FEATURE_DIR/bashrc-additions.sh"
    printf '%s\n' "# <<< devc bashrc-additions <<<"
  } >> "$BASHRC"
  chown "$USERNAME":"$USERNAME" "$BASHRC"
fi

# --- tmux.conf -------------------------------------------------------------
install -o "$USERNAME" -g "$USERNAME" -m 0644 \
  "$FEATURE_DIR/tmux.conf" "$USER_HOME/.tmux.conf"

# --- runtime setup script (invoked via the Feature's postCreateCommand) ----
install -d -m 0755 /usr/local/share/devc
install -m 0755 "$FEATURE_DIR/post-create.sh" /usr/local/share/devc/post-create.sh
