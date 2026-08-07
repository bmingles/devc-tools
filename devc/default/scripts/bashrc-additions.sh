
# Disable any verbose/tracing mode that profile scripts may have enabled.
{ set +xv; } 2>/dev/null

cls ()
{
    clear && printf '\033[3J'
}

# Custom prompt - hybrid of local + container features
export PS1='\[\]`export XIT=$?; [ "$XIT" -ne 0 ] && echo -n "\[\033[1;31m\]" || echo -n "\[\033[0m\]"`container`export FOLDER=$(basename "$PWD"); export BRANCH="$(git --no-optional-locks symbolic-ref --short HEAD 2>/dev/null || git --no-optional-locks rev-parse --short HEAD 2>/dev/null)"; if [ "${BRANCH:-}" != "" ]; then [ "$FOLDER" != "$BRANCH" ] && echo -n " \[\033[32m\]$FOLDER"; echo -n " \[\033[33m\]($BRANCH)"; else echo -n " \[\033[32m\]$FOLDER"; fi`\[\033[00m\] $ \[\]'

# Automatically use the correct Node version when entering the project
export NVM_DIR="/usr/local/share/nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
cd() { builtin cd "$@" && [ -f .nvmrc ] && nvm use --silent; }
[ -f .nvmrc ] && nvm use --silent

# Change iTerm2 tab color to green cleanly without empty lines
if [ -n "$ITERM_SESSION_ID" ] || [ "$TERM_PROGRAM" = "iTerm.app" ]; then
  echo -ne "\033]6;1;bg;red;brightness;46\a"
  echo -ne "\033]6;1;bg;green;brightness;204\a"
  echo -ne "\033]6;1;bg;blue;brightness;113\a"
fi

# Set terminal title to project name (overrides "deno" shown by iTerm2)
_DEVC_TITLE="$(basename "${PROJECT_PATH:-$PWD}" | tr '.:'  '__')"
printf '\033]0;%s\007' "$_DEVC_TITLE"
# The devcontainers base image (~/.bashrc) retitles the terminal to the running
# command via a DEBUG trap (preexec) and to $SHELL each prompt via precmd() in
# PROMPT_COMMAND. With the Claude CLI's own title disabled
# (CLAUDE_CODE_DISABLE_TERMINAL_TITLE), that command title would otherwise win
# and hide the project name. Drop the trap and repoint precmd() — already wired
# into PROMPT_COMMAND — at the project name so it persists at the prompt and
# while a foreground app runs.
trap - DEBUG
precmd() { printf '\033]0;%s\007' "$_DEVC_TITLE"; }

# devc:shell-dirs (start) — tests/shell_dirs_test.sh runs everything between these two markers
# against temp dirs, so keep the block self-contained (parameterized only by the two *_SHELL_DIR
# assignments below, which the harness rewrites).
#
# Optional shell customization, in two layers:
#
#   ~/.config/devc/shell/   on the host — your preferences, every project. Bind-mounted
#                           read-only at USER_SHELL_DIR (see the mount in devcontainer.json).
#   .devcontainer/shell/    in the workspace — this project's settings, found via PROJECT_PATH.
#
# User first, then project, so a project's committed settings win on conflict — the same
# system → global → local order git uses. A project that assigns rather than appends to a
# shared variable (PS1, PATH) will therefore override personal settings.
#
# Every *.sh in a layer is sourced, in glob (name) order — prefix with 10-, 20-, … to control
# it. Both layers are *sourced*, not appended into ~/.bashrc at build or create time, so edits
# apply to the next new shell with no rebuild and no recreate, and deleting a file simply stops
# it from being read. Neither directory is created or written by devc, so nothing here is ever
# overwritten.
#
# Placed after everything devc sets, so a layer can override PS1, cd() or precmd — but *before*
# the DEVC_ATTACH block below, which snapshots PROMPT_COMMAND and would be clobbered by a file
# that assigns to it. Append to PROMPT_COMMAND rather than replacing it.
#
# PROJECT_PATH is the container-side workspace root (remoteEnv in devcontainer.json, re-passed
# by devc on exec/attach). No fallback to $PWD: a shell started outside devc should not source
# whatever repo it happens to open in.
USER_SHELL_DIR=/usr/local/share/devc/shell
PROJECT_SHELL_DIR="${PROJECT_PATH:+$PROJECT_PATH/.devcontainer/shell}"

_devc_source_shell_dir() {
  [ -n "${1:-}" ] && [ -d "$1" ] || return 0
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

# On `devc attach`, clear gnarly bash-init output on the first prompt, after
# all buffered output from initialization has been flushed.
if [ "${DEVC_ATTACH:-}" = "1" ]; then
  unset DEVC_ATTACH
  _devc_first_prompt() {
    clear
    printf '\033[3J'
    PROMPT_COMMAND="$_DEVC_BASE_PC"
    unset -f _devc_first_prompt
    unset _DEVC_BASE_PC
  }
  _DEVC_BASE_PC="${PROMPT_COMMAND:-}"
  PROMPT_COMMAND="_devc_first_prompt${PROMPT_COMMAND:+; $PROMPT_COMMAND}"
fi
