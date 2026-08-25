#!/bin/sh
# agents Feature install — install the agent CLIs at build time, pre-create claudeDir, and
# place the create-time script with the option values baked in.
#
# Runs as root at image *build* time. Two things happen here that post-create.sh cannot:
#
#   - The CLI installs. Copied from devc-core/default/Dockerfile's two guards, run as the remote
#     user (not root) so the binaries land under a directory that user can later update
#     (`claude`/`copilot update`) instead of one only root can write. Network is required when
#     either install option is true: a failed download fails the build, matching
#     devc-bridge/install.sh's stance (better than a container that looks fine until the first
#     `claude`).
#   - Pre-creating claudeDir owned by the remote user, so a first-use empty named volume a
#     consumer mounts there (see README) starts from a real, owned directory rather than one
#     mounted root-owned. post-create.sh's ownership repair (a non-recursive `sudo chown`) is
#     kept anyway as belt-and-braces — whether Docker actually seeds a fresh volume's ownership
#     from what was already at that path is unmeasured (no Docker in the environment this
#     Feature was written in; see .plans/design/devc-feature-split.md, open question 3).
#
# Installing the CLIs as root would put them somewhere the remote user cannot update — the exact
# reason devc-core/default/Dockerfile switches USER before its own two RUN lines.
set -e

die() {
  echo "agents: $*" >&2
  exit 1
}

# Options reach install.sh uppercased with non-word characters stripped (the CLI's getSafeId),
# and booleans arrive as the strings "true"/"false". The defaults are repeated here rather than
# trusted from the manifest so the script also runs standalone.
#
# `${VAR-default}` rather than `${VAR:-default}` for the three path options: an explicitly empty
# value means something different from "unset" for all three (claudeDir falls back to
# $_REMOTE_USER_HOME/.claude below; seedDir and claudeJsonDir disable their whole step in
# post-create.sh) and must not fall back to a non-empty default. node-nvmrc, shell-dirs and
# git-container-config make the same distinction for the same reason.
INSTALL_CLAUDE_CLI_OPT="${INSTALLCLAUDECLI:-true}"
INSTALL_COPILOT_CLI_OPT="${INSTALLCOPILOTCLI:-false}"
CLAUDE_DIR_OPT="${CLAUDEDIR-}"
SEED_DIR_OPT="${SEEDDIR-}"
CLAUDE_JSON_DIR_OPT="${CLAUDEJSONDIR-}"

# All three path options are pasted into a double-quoted shell assignment in post-create.sh, so
# anything that could end that string, start an expansion or add a line is rejected outright
# rather than silently producing a script that does something else. Same policy, wording and
# character set as node-nvmrc/shell-dirs/bash-config/git-container-config. These are container
# paths; none of this is a real restriction.
check_path_opt() { # check_path_opt <option name> <value>
  case "$2" in
    *'"'*) die "$1 may not contain a double quote: $2" ;;
    *'`'*) die "$1 may not contain a backtick: $2" ;;
    *'$'*) die "$1 may not contain a dollar sign: $2" ;;
    *'\'*) die "$1 may not contain a backslash: $2" ;;
    # A literal newline, which would turn the rest of the value into its own line of shell.
    *'
'*) die "$1 may not contain a newline: $2" ;;
  esac
}
check_path_opt claudeDir "$CLAUDE_DIR_OPT"
check_path_opt seedDir "$SEED_DIR_OPT"
check_path_opt claudeJsonDir "$CLAUDE_JSON_DIR_OPT"

# /usr/local/share/devc-features/<id>/ is the Feature namespace. /usr/local/share/devc/ is
# devc's own baseline namespace and no Feature writes into it — not sharing the prefix is what
# keeps "did devc put this here, or a Feature?" answerable. Overridable for the test harness.
SHARE_DIR="${SHARE_DIR:-/usr/local/share/devc-features/agents}"

FEATURE_DIR="$(cd "$(dirname "$0")" && pwd)"

# --- resolve claudeDir now, at build time, so the pre-create below and the value baked into
# post-create.sh agree on the same literal path -------------------------------------------------
#
# _REMOTE_USER_HOME is set by the CLI whenever it knows the remote user (every real Feature
# install); falls back to $HOME for a manual run or the offline test harness.
REMOTE_USER_HOME="${_REMOTE_USER_HOME:-$HOME}"
REMOTE_USER="${_REMOTE_USER:-$(id -un)}"
CLAUDE_DIR_RESOLVED="$CLAUDE_DIR_OPT"
[ -n "$CLAUDE_DIR_RESOLVED" ] || CLAUDE_DIR_RESOLVED="$REMOTE_USER_HOME/.claude"

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

# --- pre-create claudeDir, owned by the remote user ---------------------------------------------
# See the top-of-file comment on open question 3. Runs even when claudeDir will be immediately
# mounted over by a consumer's own volume — belt-and-braces either way, and cheap.
mkdir -p "$CLAUDE_DIR_RESOLVED"
if [ "$(id -un)" != "$REMOTE_USER" ]; then
  chown "$REMOTE_USER" "$CLAUDE_DIR_RESOLVED" 2> /dev/null ||
    echo "agents: could not chown $CLAUDE_DIR_RESOLVED to $REMOTE_USER (post-create.sh repairs this)"
fi

# --- the create-time script -----------------------------------------------------------------
#
# The manifest's postCreateCommand takes no arguments, so the options have to cross into
# post-create.sh at build time. They are baked by rewriting its `VAR="${VAR-default}"` lines,
# which keeps the file in the repo readable and runnable on its own.

bake() { # bake <file> <var> <value>
  _bake_tmp="$1.bake.$$"
  # awk with the replacement passed as a -v value, rather than sed: a `&` in a value is a
  # back-reference in a sed replacement and a `|` would end the expression.
  awk -v var="$2" -v line="$2=\"$3\"" '
    index($0, var "=") == 1 { print line; next }
                            { print }
  ' "$1" > "$_bake_tmp"
  mv -f "$_bake_tmp" "$1"
  # A rename or a reformat upstream would otherwise leave the option silently unwired, with the
  # `${VAR-default}` fallback quietly standing in for whatever the consumer asked for.
  # -qxF, not -q: the pattern is built from the same value, so a regex metacharacter in it must
  # not be able to make a failed bake look like a successful one.
  grep -qxF "$2=\"$3\"" "$1" || die "could not bake $2 into $(basename "$1")"
}

mkdir -p "$SHARE_DIR"
# Plain cp rather than `install -o root`: this runs as root, so the copy is root-owned either
# way, and no ownership flag means the script still runs unprivileged in the test harness.
cp "$FEATURE_DIR/post-create.sh" "$SHARE_DIR/post-create.sh"
bake "$SHARE_DIR/post-create.sh" CLAUDE_DIR "$CLAUDE_DIR_RESOLVED"
bake "$SHARE_DIR/post-create.sh" SEED_DIR "$SEED_DIR_OPT"
bake "$SHARE_DIR/post-create.sh" CLAUDE_JSON_DIR "$CLAUDE_JSON_DIR_OPT"
chmod 0755 "$SHARE_DIR/post-create.sh"

echo "agents: create-time script installed at $SHARE_DIR/post-create.sh"
echo "agents: claudeDir='$CLAUDE_DIR_RESOLVED' seedDir='$SEED_DIR_OPT'" \
  "claudeJsonDir='$CLAUDE_JSON_DIR_OPT' installClaudeCli=$INSTALL_CLAUDE_CLI_OPT" \
  "installCopilotCli=$INSTALL_COPILOT_CLI_OPT"
