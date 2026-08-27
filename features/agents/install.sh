#!/bin/sh
# agents Feature install — install the agent CLIs at build time, pre-create ~/.claude and the
# seed mount point, and place the create-time script.
#
# Runs as root at image *build* time. Three things happen here that post-create.sh cannot:
#
#   - The CLI installs. Copied from devc-core/default/Dockerfile's two guards, run as the remote
#     user (not root) so the binaries land under a directory that user can later update
#     (`claude`/`copilot`/`pi update`) instead of one only root can write. Network is required
#     when any install option is true: a failed download fails the build, matching
#     devc-bridge/install.sh's stance (better than a container that looks fine until the first
#     `claude`). An npm-installed CLI (pi) additionally needs Node.js visible to a
#     non-interactive shell, which at build time it is not — see install_cli's node prelude.
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
# the installers would drop their binaries under root's own ~/.local/bin instead. The installer
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

# Exit code the node prelude below uses to say "the toolchain is missing", so install_cli can
# tell that apart from a failed download and name the real problem. 78 is sysexits.h's
# EX_CONFIG; any value the installers themselves do not use would do.
NODE_MISSING_STATUS=78

install_cli() { # install_cli <display name> <binary name> <install script URL> [min node version]
  # A 4th argument means "this installer runs on Node.js", and its value is the minimum version
  # that installer needs — see the node prelude below.
  _name="$1"; _bin="$2"; _url="$3"; _node_min="${4:-}"
  _script="$(mktemp)"
  # set -o pipefail is bash-only (hence `bash '$1'` above, not a bare `sh -c`) — without it a
  # failed curl piped into bash would not fail this whole line, and a network failure would look
  # like a successful, silent no-op install instead of failing the build.
  #
  # Built in pieces so the node prelude can be a *quoted* heredoc: it is all runtime shell, and
  # nothing in it should be expanded here by root's shell. Only the last piece interpolates, and
  # only the two values it has to (`$_bin`, `$_url`).
  {
    echo 'set -e'
    echo 'set -o pipefail'
    if [ -n "$_node_min" ]; then
      # The one value the prelude cannot hardcode, spliced in ahead of it so the prelude itself
      # can stay a quoted heredoc.
      echo "NODE_MIN='$_node_min'"
      cat << 'NODE_PRELUDE'
# Some installers (pi) install themselves with npm, so they need Node.js on PATH — and at image
# build time it is not there, even though the node Feature has already installed it. The
# devcontainers node Feature wires nvm into /etc/bash.bashrc only, and bash sources that file
# just for *interactive* shells (/etc/profile guards it on $PS1). This script is a
# non-interactive one, so node is present on disk and invisible to it. `installsAfter` does not
# help: it fixes the install *order*, not the PATH. Source nvm directly instead.
if ! command -v node > /dev/null 2>&1; then
  for _nvm_dir in "${NVM_DIR:-}" /usr/local/share/nvm "$HOME/.nvm"; do
    [ -n "$_nvm_dir" ] || continue
    [ -s "$_nvm_dir/nvm.sh" ] || continue
    export NVM_DIR="$_nvm_dir"
    # nvm.sh is a large script that is not written to be sourced under `set -e`; a non-fatal
    # failure inside it must not take this whole install down.
    set +e
    . "$_nvm_dir/nvm.sh" > /dev/null 2>&1
    set -e
    if command -v node > /dev/null 2>&1; then break; fi
  done
fi

if ! command -v node > /dev/null 2>&1 || ! command -v npm > /dev/null 2>&1; then
  echo "agents: Node.js $NODE_MIN or newer and npm are required for this CLI, and neither" >&2
  echo "agents: node nor npm was found at build time (nvm was not found either). Add a node" >&2
  echo "agents: Feature to the container ahead of this one, then rebuild." >&2
  exit 78
fi

# Check the version here rather than letting the installer discover it. An installer that fails
# its own preflight exits 1, which install_cli can only report as "network required" — the
# misleading message this whole prelude exists to stop. Comparing in node rather than with sort
# -V keeps it to one tool that is, by this point, guaranteed present.
if ! node -e 'const need=process.argv[1].split(".").map(Number),have=process.versions.node.split(".").map(Number);for(let i=0;i<3;i++){const n=need[i]||0,h=have[i]||0;if(h>n)process.exit(0);if(h<n)process.exit(1)}process.exit(0)' "$NODE_MIN" > /dev/null 2>&1; then
  echo "agents: this CLI needs Node.js $NODE_MIN or newer; the container has $(node --version)." >&2
  echo "agents: raise the node Feature's version option, or drop the install option for it." >&2
  exit 78
fi

# Pin npm's global prefix to ~/.local, so an npm-installed agent CLI lands in ~/.local/bin
# beside claude and copilot. Without this, npm's global prefix under nvm is the *active node
# version's* own directory (/usr/local/share/nvm/versions/node/<version>) — so the binary would
# drop out of PATH the moment node-nvmrc switched the container onto a different version for a
# project's .nvmrc, and the `[ ! -x "$HOME/.local/bin/<bin>" ]` guard below would never see it
# on a rebuild either.
export npm_config_prefix="$HOME/.local"
NODE_PRELUDE
    fi
    cat << EOF
if [ ! -x "\$HOME/.local/bin/$_bin" ] && ! command -v $_bin > /dev/null 2>&1; then
  curl -fsSL $_url | bash
fi
EOF
  } > "$_script"
  chmod 0755 "$_script"
  # Captured with `|| _status=$?` rather than `if ! …`, so `set -e` does not abort here and the
  # prelude's distinct exit code survives to be reported below.
  _status=0
  run_as_remote_user "$_script" || _status=$?
  rm -f "$_script"
  if [ "$_status" -eq "$NODE_MISSING_STATUS" ]; then
    die "$_name CLI install failed — see the Node.js requirement above"
  elif [ "$_status" -ne 0 ]; then
    die "$_name CLI install failed (network required)"
  fi
  echo "agents: $_name CLI installed for $REMOTE_USER"
}

if [ "$INSTALL_CLAUDE_CLI_OPT" = true ]; then
  install_cli Claude claude https://claude.ai/install.sh
fi
if [ "$INSTALL_COPILOT_CLI_OPT" = true ]; then
  install_cli Copilot copilot https://gh.io/copilot-install
fi
if [ "$INSTALL_PI_CLI_OPT" = true ]; then
  # pi's own package declares engines >= 22.19.0; under anything older its bundle dies with a
  # raw SyntaxError rather than a version complaint, so the check is worth making here.
  install_cli Pi pi https://pi.dev/install.sh 22.19.0
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
