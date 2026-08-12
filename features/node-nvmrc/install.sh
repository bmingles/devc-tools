#!/bin/sh
# node-nvmrc Feature install — place the create-time script and the interactive-shell hook.
#
# Runs as root at image *build* time, and its whole job is to put files somewhere. It must not
# touch nvm: the workspace is not mounted yet, so there is no .nvmrc to read, and nvm itself may
# be installed by a Feature ordered after this one on some other consumer's config. Everything
# that needs either of those things happens in post-create.sh.
#
# Copied out of devc's baseline — devc/default/scripts/node-setup.sh and the nvm lines in
# scripts/bashrc-additions.sh — and generalized for an image that has never heard of devc.
# Both devc copies keep running exactly as they do today; swapping devc onto this Feature is a
# separate plan. Nothing here assumes a `vscode` user, a PROJECT_PATH, or a `sudo`.
#
# No network, so nothing to verify and no FEATURE_VERSION to bake: this Feature fetches no
# release asset (see features/README.md).
set -e

die() {
  echo "node-nvmrc: $*" >&2
  exit 1
}

# Options reach install.sh uppercased with non-word characters stripped (the CLI's getSafeId),
# and booleans arrive as the strings "true"/"false". The defaults are repeated here rather than
# trusted from the manifest so the script also runs standalone; /usr/local/share/nvm is where
# ghcr.io/devcontainers/features/node puts nvm, not a devc invention.
NVM_DIR_OPT="${NVMDIR:-/usr/local/share/nvm}"
INSTALL_ON_CREATE="${INSTALLONCREATE:-true}"
AUTO_USE_ON_CD="${AUTOUSEONCD:-true}"
FIX_NODE_MODULES_OWNERSHIP="${FIXNODEMODULESOWNERSHIP:-true}"

# /usr/local/share/devc-features/<id>/ is the Feature namespace. /usr/local/share/devc/ is
# devc's own baseline namespace and no Feature writes into it — not sharing the prefix is what
# keeps "did devc put this here, or a Feature?" answerable. Overridable for the test harness.
SHARE_DIR="${SHARE_DIR:-/usr/local/share/devc-features/node-nvmrc}"

FEATURE_DIR="$(cd "$(dirname "$0")" && pwd)"

# --- the create-time script -------------------------------------------------------------
#
# The manifest's postCreateCommand takes no arguments, so the options have to cross into
# post-create.sh at build time. They are baked by rewriting its three `VAR="${VAR:-default}"`
# lines, which keeps the file in the repo readable and runnable on its own.

bake() { # bake <file> <var> <value>
  _bake_tmp="$1.bake.$$"
  sed "s|^$2=.*|$2=\"$3\"|" "$1" > "$_bake_tmp"
  mv -f "$_bake_tmp" "$1"
  # A rename or a reformat upstream would otherwise leave the option silently unwired, with the
  # `${VAR:-default}` fallback quietly standing in for whatever the consumer asked for.
  grep -q "^$2=\"$3\"\$" "$1" || die "could not bake $2 into $(basename "$1")"
}

mkdir -p "$SHARE_DIR"
# Plain cp rather than `install -o root`: this runs as root, so the copy is root-owned either
# way, and no ownership flag means the script still runs unprivileged in the test harness.
cp "$FEATURE_DIR/post-create.sh" "$SHARE_DIR/post-create.sh"
bake "$SHARE_DIR/post-create.sh" NVM_DIR "$NVM_DIR_OPT"
bake "$SHARE_DIR/post-create.sh" INSTALL_ON_CREATE "$INSTALL_ON_CREATE"
bake "$SHARE_DIR/post-create.sh" FIX_NODE_MODULES_OWNERSHIP "$FIX_NODE_MODULES_OWNERSHIP"
chmod 0755 "$SHARE_DIR/post-create.sh"

echo "node-nvmrc: create-time script installed at $SHARE_DIR/post-create.sh"

# --- the interactive-shell hook ----------------------------------------------------------

[ "$AUTO_USE_ON_CD" = true ] || {
  echo 'node-nvmrc: autoUseOnCd is false — no ~/.bashrc block appended'
  exit 0
}

USER_HOME="${_REMOTE_USER_HOME:-$HOME}"
[ -n "$USER_HOME" ] || die 'no _REMOTE_USER_HOME and no HOME — nowhere to append a .bashrc block'
BASHRC="$USER_HOME/.bashrc"
START_MARKER='# >>> node-nvmrc >>>'
END_MARKER='# <<< node-nvmrc <<<'

# Marker-guarded so a rebuild does not double-append — the same shape devc/default/Dockerfile
# uses for its own bashrc-additions block.
if grep -qF "$START_MARKER" "$BASHRC" 2> /dev/null; then
  echo "node-nvmrc: $BASHRC already has the block — left alone"
  exit 0
fi

BLOCK="$(mktemp)"
trap 'rm -f "$BLOCK"' EXIT

# Quoted heredoc: what appears between the fence markers below is exactly what lands in
# ~/.bashrc, and exactly what test/nvm_use_test.sh pulls back out of *this file* and runs. An
# unquoted heredoc would put shell escapes in between and break both.
cat > "$BLOCK" << 'NVM_USE_BLOCK'
# devc:nvm-use (start) — features/node-nvmrc/test/nvm_use_test.sh extracts everything between
# these two markers out of install.sh and runs it directly, so keep the block self-contained:
# no helper defined above it, and NVM_DIR overridable from the environment. install.sh bakes
# the nvmDir option into the copy it appends here, so a real ~/.bashrc names the directory
# outright rather than deferring to an environment variable that may not be set.
export NVM_DIR="${NVM_DIR:-/usr/local/share/nvm}"
# shellcheck source=/dev/null
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

# Everything below is conditional on nvm having actually loaded. devc's copy redefines cd
# unconditionally, which is safe in an image devc built; a Feature can be installed into an
# image that has no nvm at all, and there an unconditional override leaves a `cd` that calls a
# nonexistent command on every directory change. Absent nvm this block leaves the shell exactly
# as it found it.
if command -v nvm > /dev/null 2>&1; then
  # `|| return` keeps a failed cd failing. The explicit `return 0` keeps a *successful* cd
  # succeeding in a directory with no .nvmrc, so `cd somewhere && make` still works — devc's
  # one-liner returns 1 from every such cd, which is harmless only because its own PS1 renders
  # $? decoratively.
  cd() {
    builtin cd "$@" || return
    [ -f .nvmrc ] && nvm use --silent
    return 0
  }

  # Select the pinned version for the directory the shell starts in. Wrapped so the block
  # cannot leave a non-zero $? behind: this is the last thing ~/.bashrc runs, and a consumer's
  # prompt may report exit status, so a plain `[ -f .nvmrc ]` failing in a project that pins
  # nothing would show up as an error on the very first prompt of every shell.
  { [ -f .nvmrc ] && nvm use --silent; } || true
fi
# devc:nvm-use (end)
NVM_USE_BLOCK

# Same rewrite-and-verify as post-create.sh's options, for the same reason.
BLOCK_TMP="$BLOCK.bake.$$"
sed "s|^export NVM_DIR=.*|export NVM_DIR=\"$NVM_DIR_OPT\"|" "$BLOCK" > "$BLOCK_TMP"
mv -f "$BLOCK_TMP" "$BLOCK"
grep -q "^export NVM_DIR=\"$NVM_DIR_OPT\"\$" "$BLOCK" ||
  die 'could not bake nvmDir into the ~/.bashrc block'

{
  printf '%s\n' "$START_MARKER"
  cat "$BLOCK"
  printf '%s\n' "$END_MARKER"
} >> "$BASHRC"

# `>>` creates the file root-owned if it did not exist, which would make the remote user's own
# ~/.bashrc unwritable by them. Appending to an existing file leaves ownership alone, so this is
# a no-op in the common case.
if [ -n "${_REMOTE_USER:-}" ]; then
  chown "$_REMOTE_USER" "$BASHRC" 2> /dev/null || true
fi

echo "node-nvmrc: nvm-use block appended to $BASHRC (NVM_DIR=$NVM_DIR_OPT)"
