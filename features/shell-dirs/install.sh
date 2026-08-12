#!/bin/sh
# shell-dirs Feature install — place the create-time script, and append the interactive-shell
# hook to the remote user's ~/.bashrc.
#
# Runs as root at image *build* time, and its whole job is to put files somewhere. Nothing is
# sourced, resolved or created here: neither shell directory need exist at build time (the
# workspace is not mounted yet, and the user layer is typically a bind mount that only appears
# at run time), and both are looked up fresh by every shell instead.
#
# It cannot resolve the workspace either — the path is unknowable during `docker build`, which
# is why the block it writes defers to $PROJECT_PATH, and why post-create.sh exists to replace
# that deferral with a real path at create time.
#
# Copied out of devc's baseline — the `devc:shell-dirs` fenced block in
# devc/default/scripts/bashrc-additions.sh — with only the two *_SHELL_DIR assignments
# substituted. That copy is deliberate and load-bearing: devc/tests/shell_dirs_test.sh runs
# against *this file* unmodified, which is what stops the two copies drifting apart. devc's own
# block keeps running as it does today; swapping devc onto this Feature is a separate plan.
#
# bash only. zsh and fish are not written and not half-written — see README.md.
#
# No network, so nothing to verify and no DEVC_TOOLS_RELEASE to pin: this Feature fetches no
# release asset (see features/README.md).
set -e

die() {
  echo "shell-dirs: $*" >&2
  exit 1
}

# Options reach install.sh uppercased with non-word characters stripped (the CLI's getSafeId).
# `${VAR-default}` rather than `${VAR:-default}`: an explicitly empty option *disables* that
# layer and must not fall back to the default. The defaults are repeated from the manifest so
# this script also runs standalone.
PROJECT_DIR_OPT="${PROJECTDIR-.devcontainer/shell}"
USER_DIR_OPT="${USERDIR-}"

# Both values are pasted into a double-quoted shell assignment, so anything that could end that
# string or start an expansion is rejected outright rather than silently producing a block that
# does something else. These are container paths; none of it is a real restriction.
check_path_opt() { # check_path_opt <option name> <value>
  case "$2" in
    *'"'*) die "$1 may not contain a double quote: $2" ;;
    *'`'*) die "$1 may not contain a backtick: $2" ;;
    *'$'*) die "$1 may not contain a dollar sign: $2" ;;
    *'\'*) die "$1 may not contain a backslash: $2" ;;
  esac
}
check_path_opt projectDir "$PROJECT_DIR_OPT"
check_path_opt userDir "$USER_DIR_OPT"

# /usr/local/share/devc-features/<id>/ is the Feature namespace, the same one node-nvmrc uses.
# /usr/local/share/devc/ is devc's own baseline namespace and no Feature writes into it — not
# sharing the prefix is what keeps "did devc put this here, or a Feature?" answerable.
# Overridable for the test harness.
SHARE_DIR="${SHARE_DIR:-/usr/local/share/devc-features/shell-dirs}"

FEATURE_DIR="$(cd "$(dirname "$0")" && pwd)"

# --- the create-time script -------------------------------------------------------------
#
# The manifest's postCreateCommand takes no arguments, so projectDir has to cross into
# post-create.sh at build time. It is baked by rewriting the one `VAR="${VAR:-default}"` line,
# which keeps the file in the repo readable and runnable on its own.

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
bake "$SHARE_DIR/post-create.sh" PROJECT_DIR "$PROJECT_DIR_OPT"
chmod 0755 "$SHARE_DIR/post-create.sh"

echo "shell-dirs: create-time script installed at $SHARE_DIR/post-create.sh"

# --- the interactive-shell hook ----------------------------------------------------------

USER_HOME="${_REMOTE_USER_HOME:-$HOME}"
[ -n "$USER_HOME" ] || die 'no _REMOTE_USER_HOME and no HOME — nowhere to append a .bashrc block'
BASHRC="$USER_HOME/.bashrc"
START_MARKER='# >>> shell-dirs >>>'
END_MARKER='# <<< shell-dirs <<<'

# Marker-guarded so a rebuild does not double-append — the same shape devc/default/Dockerfile
# uses for its own bashrc-additions block.
if grep -qF "$START_MARKER" "$BASHRC" 2> /dev/null; then
  echo "shell-dirs: $BASHRC already has the block — left alone"
  exit 0
fi

BLOCK="$(mktemp)"
trap 'rm -f "$BLOCK" "$BLOCK.rewrite"' EXIT

# Quoted heredoc: what appears between the fence markers below is exactly what lands in
# ~/.bashrc, and exactly what devc/tests/shell_dirs_test.sh pulls back out of *this file* and
# runs. An unquoted heredoc would expand ${PROJECT_PATH:+...} here, at build time, and break
# both.
cat > "$BLOCK" << 'SHELL_DIRS_BLOCK'
# devc:shell-dirs (start) — devc/tests/shell_dirs_test.sh runs everything between these two
# markers against temp dirs, so keep the block self-contained: parameterized only by the two
# *_SHELL_DIR assignments below, which the harness rewrites, and which install.sh rewrites the
# same way when it appends this block to ~/.bashrc. The fence name still says `devc` because
# that harness is the contract; see this Feature's README for the four things named `shell`.
#
# Optional shell customization, in two layers:
#
#   userDir      an absolute container path — your preferences, every project. Empty by
#                default. Nothing here creates or mounts it; the consumer's devcontainer.json
#                binds a host directory there (README.md has the two lines).
#   projectDir   workspace-relative — this project's committed settings, found via
#                PROJECT_PATH. Defaults to .devcontainer/shell.
#
# User first, then project, so a project's committed settings win on conflict — the same
# system → global → local order git uses. A project that assigns rather than appends to a
# shared variable (PS1, PATH) will therefore override personal settings.
#
# Every *.sh in a layer is sourced, in glob (name) order — prefix with 10-, 20-, … to control
# it. Both layers are *sourced*, not appended into ~/.bashrc at build or create time, so edits
# apply to the next new shell with no rebuild and no recreate, and deleting a file simply stops
# it from being read. Neither directory is created or written here, so nothing is overwritten.
#
# PROJECT_PATH is the container-side workspace root, which the consumer sets as remoteEnv. No
# fallback to $PWD: a shell started outside the workspace should not source whatever repo it
# happens to open in. Unset, the project layer is a silent no-op.
USER_SHELL_DIR=""
PROJECT_SHELL_DIR="${PROJECT_PATH:+$PROJECT_PATH/.devcontainer/shell}"

_devc_source_shell_dir() {
  [ -n "${1:-}" ] && [ -d "$1" ] || return 0
  # Source a directory at most once per shell. devc's baseline carries its own copy of this
  # block, so a devc container that also enables this Feature would otherwise source the
  # project layer twice — idempotent for aliases and `export`, not for PATH=...:$PATH.
  # Deliberately not exported: it must reset per shell, not inherit into subshells that
  # legitimately re-source.
  case ":${_DEVC_SHELL_DIRS_DONE:-}:" in
    *":$1:"*) return 0 ;;
  esac
  _DEVC_SHELL_DIRS_DONE="${_DEVC_SHELL_DIRS_DONE:+$_DEVC_SHELL_DIRS_DONE:}$1"
  for _devc_f in "$1"/*.sh; do
    # An unmatched glob stays literal, so this -f test is also the empty-directory guard.
    [ -f "$_devc_f" ] && . "$_devc_f"
  done
  unset _devc_f
}

_devc_source_shell_dir "$USER_SHELL_DIR"
_devc_source_shell_dir "$PROJECT_SHELL_DIR"
unset -f _devc_source_shell_dir
unset USER_SHELL_DIR PROJECT_SHELL_DIR
# devc:shell-dirs (end)
SHELL_DIRS_BLOCK

# --- substitute the two assignments -------------------------------------------------------
#
# The project layer keeps the ${PROJECT_PATH:+...} guard only while the option is relative —
# that is the whole reason the guard exists. An absolute projectDir names a fixed container
# path, so it is used as-is and works with no PROJECT_PATH at all.
case "$PROJECT_DIR_OPT" in
  '') PROJECT_LINE='PROJECT_SHELL_DIR=""' ;;
  /*) PROJECT_LINE="PROJECT_SHELL_DIR=\"$PROJECT_DIR_OPT\"" ;;
  *) PROJECT_LINE='PROJECT_SHELL_DIR="${PROJECT_PATH:+$PROJECT_PATH/'"$PROJECT_DIR_OPT"'}"' ;;
esac
USER_LINE="USER_SHELL_DIR=\"$USER_DIR_OPT\""

# awk with the replacements passed as -v values, rather than sed: a `&` or a `\` in an option
# is data here, not a back-reference into the replacement text.
awk -v u="$USER_LINE" -v p="$PROJECT_LINE" '
  /^USER_SHELL_DIR=/    { print u; next }
  /^PROJECT_SHELL_DIR=/ { print p; next }
                        { print }
' "$BLOCK" > "$BLOCK.rewrite"
mv -f "$BLOCK.rewrite" "$BLOCK"

# A rename or a reformat of either assignment would otherwise leave the option silently
# unwired, with the block's own default quietly standing in for whatever the consumer asked
# for. The same failure mode devc/tests/shell_dirs_test.sh has when its sed stops matching.
grep -qxF "$USER_LINE" "$BLOCK" || die 'could not substitute userDir into the ~/.bashrc block'
grep -qxF "$PROJECT_LINE" "$BLOCK" ||
  die 'could not substitute projectDir into the ~/.bashrc block'

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

echo "shell-dirs: block appended to $BASHRC"
echo "shell-dirs:   $USER_LINE"
echo "shell-dirs:   $PROJECT_LINE"
