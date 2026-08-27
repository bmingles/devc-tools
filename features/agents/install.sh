#!/bin/sh
# agents Feature install — install the agent CLIs at build time, pre-create ~/.claude and the
# seed mount point, and place the create-time script.
#
# Runs as root at image *build* time. Three things happen here that post-create.sh cannot:
#
#   - The CLI installs. Copied from devc-core/default/Dockerfile's two guards, run as the remote
#     user (not root) so the binaries land under a directory that user can later update
#     (`claude`/`copilot update`) instead of one only root can write. Network is required when
#     either install option is true: a failed download fails the build, matching
#     devc-bridge/install.sh's stance (better than a container that looks fine until the first
#     `claude`).
#   - Pre-creating ~/.claude owned by the remote user, so a first-use empty named volume a
#     consumer mounts there (see README) starts from a real, owned directory rather than one
#     mounted root-owned. post-create.sh's ownership repair (a non-recursive `sudo chown`) is
#     kept anyway as belt-and-braces — whether Docker actually seeds a fresh volume's ownership
#     from what was already at that path is unmeasured (no Docker in the environment this
#     Feature was written in; see .plans/design/devc-feature-split.md, open question 3).
#   - Pre-creating the seed directory, empty. It is this Feature's published surface: a consumer
#     bind-mounts their own host config onto it, exactly as bash-config's dirs/user works. Empty
#     is a working state, not a broken one — post-create.sh's seed-link step finds nothing to
#     link and moves on, which is what the bare `{}` case is.
#
# Installing the CLIs as root would put them somewhere the remote user cannot update — the exact
# reason devc-core/default/Dockerfile switches USER before its own two RUN lines.
#
# There are no path options to validate or bake. Every path this Feature touches is either fixed
# (the seed) or derived from the remote user's own home (~/.claude), so the option-injection
# guard and the bake() rewriting that earlier versions carried have nothing left to guard or
# rewrite — see README.md's "Why there are no path options".
set -e

die() {
  echo "agents: $*" >&2
  exit 1
}

# Options reach install.sh uppercased with non-word characters stripped (the CLI's getSafeId),
# and booleans arrive as the strings "true"/"false". The defaults are repeated here rather than
# trusted from the manifest so the script also runs standalone.
INSTALL_CLAUDE_CLI_OPT="${INSTALLCLAUDECLI:-true}"
INSTALL_COPILOT_CLI_OPT="${INSTALLCOPILOTCLI:-false}"
INSTALL_PI_CLI_OPT="${INSTALLPICLI:-false}"

# /usr/local/share/devc-features/<id>/ is the Feature namespace. /usr/local/share/devc/ is
# devc's own baseline namespace and no Feature writes into it — not sharing the prefix is what
# keeps "did devc put this here, or a Feature?" answerable. Overridable for the test harness.
SHARE_DIR="${SHARE_DIR:-/usr/local/share/devc-features/agents}"

FEATURE_DIR="$(cd "$(dirname "$0")" && pwd)"

# _REMOTE_USER_HOME is set by the CLI whenever it knows the remote user (every real Feature
# install); falls back to $HOME for a manual run or the offline test harness. Claude Code
# resolves its own state directory as $CLAUDE_CONFIG_DIR or, unset, $HOME/.claude — so the
# remote user's home is the only correct answer here, and there is nothing to make an option of.
REMOTE_USER_HOME="${_REMOTE_USER_HOME:-$HOME}"
REMOTE_USER="${_REMOTE_USER:-$(id -un)}"
CLAUDE_DIR="$REMOTE_USER_HOME/.claude"

# --- CLI installs, as the remote user, not root -------------------------------------------------
#
# `su -`/`runuser -l` resolve $HOME to $_REMOTE_USER_HOME for the installer script, without which
# both installers would drop their binaries under root's own ~/.local/bin instead. The installer
# body itself (the `[ ! -x ... ] && ! command -v ...` guard, then `curl -fsSL <url> | bash`) is
# the Dockerfile's two RUN lines, copied verbatim. Written to a temp script and run by path,
# rather than passed as a `-c` string, so nothing here has to reason about nested quoting.
have() { command -v "$1" > /dev/null 2>&1; }

run_as_remote_user() { # run_as_remote_user <script-path>
  if have runuser; then
    runuser -l "$REMOTE_USER" -c "bash '$1'"
  else
    su - "$REMOTE_USER" -c "bash '$1'"
  fi
}

install_cli() { # install_cli <display name> <binary name> <install script URL>
  _name="$1"; _bin="$2"; _url="$3"
  _script="$(mktemp)"
  # set -o pipefail is bash-only (hence `bash '$1'` above, not a bare `sh -c`) — without it a
  # failed curl piped into bash would not fail this whole line, and a network failure would look
  # like a successful, silent no-op install instead of failing the build.
  cat > "$_script" << EOF
set -e
set -o pipefail
if [ ! -x "\$HOME/.local/bin/$_bin" ] && ! command -v $_bin > /dev/null 2>&1; then
  curl -fsSL $_url | bash
fi
EOF
  chmod 0755 "$_script"
  run_as_remote_user "$_script" || die "$_name CLI install failed (network required)"
  rm -f "$_script"
  echo "agents: $_name CLI installed for $REMOTE_USER"
}

if [ "$INSTALL_CLAUDE_CLI_OPT" = true ]; then
  install_cli Claude claude https://claude.ai/install.sh
fi
if [ "$INSTALL_COPILOT_CLI_OPT" = true ]; then
  install_cli Copilot copilot https://gh.io/copilot-install
fi
if [ "$INSTALL_PI_CLI_OPT" = true ]; then
  install_cli Pi pi https://pi.dev/install.sh
fi

# --- pre-create ~/.claude, owned by the remote user ---------------------------------------------
# See the top-of-file comment on open question 3. Runs even when CLAUDE_DIR will be immediately
# mounted over by a consumer's own volume — belt-and-braces either way, and cheap.
mkdir -p "$CLAUDE_DIR"
if [ "$(id -un)" != "$REMOTE_USER" ]; then
  chown "$REMOTE_USER" "$CLAUDE_DIR" 2> /dev/null ||
    echo "agents: could not chown $CLAUDE_DIR to $REMOTE_USER (post-create.sh repairs this)"
fi

# --- the create-time script, and the seed mount point -------------------------------------------
#
# claude-seed stays root-owned and is never written to by this Feature: a consumer mounts their
# own host directory onto it read-only, and post-create.sh only ever reads it. Left empty when
# nobody mounts anything, which is the bare `{}` case.
mkdir -p "$SHARE_DIR/claude-seed"

# Plain cp rather than `install -o root`: this runs as root, so the copy is root-owned either
# way, and no ownership flag means the script still runs unprivileged in the test harness.
cp "$FEATURE_DIR/post-create.sh" "$SHARE_DIR/post-create.sh"
chmod 0755 "$SHARE_DIR/post-create.sh"

echo "agents: create-time script installed at $SHARE_DIR/post-create.sh"
echo "agents: claudeDir='$CLAUDE_DIR' seedDir='$SHARE_DIR/claude-seed'" \
  "installClaudeCli=$INSTALL_CLAUDE_CLI_OPT installCopilotCli=$INSTALL_COPILOT_CLI_OPT" \
  "installPiCli=$INSTALL_PI_CLI_OPT"
