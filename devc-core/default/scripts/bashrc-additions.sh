#!/bin/bash
# Append this file's own .bashrc content into ~/.bashrc, marker-guarded so re-running
# post-create (or a container restart) does not double-append.
#
# Runs at create time rather than baked into the image at build time, so in `devc config`
# mode a project's edited copy of this file takes effect on the next container create, no
# image rebuild.
set -e
BASHRC="$HOME/.bashrc"
MARKER="# >>> devc bashrc-additions >>>"
grep -qF "$MARKER" "$BASHRC" 2>/dev/null && exit 0

cat >> "$BASHRC" <<'DEVC_BASHRC_ADDITIONS'
# >>> devc bashrc-additions >>>

# Disable any verbose/tracing mode that profile scripts may have enabled.
{ set +xv; } 2>/dev/null

cls ()
{
    clear && printf '\033[3J'
}

# Custom prompt - hybrid of local + container features
export PS1='\[\]`export XIT=$?; [ "$XIT" -ne 0 ] && echo -n "\[\033[1;31m\]" || echo -n "\[\033[0m\]"`container`export FOLDER=$(basename "$PWD"); export BRANCH="$(git --no-optional-locks symbolic-ref --short HEAD 2>/dev/null || git --no-optional-locks rev-parse --short HEAD 2>/dev/null)"; if [ "${BRANCH:-}" != "" ]; then [ "$FOLDER" != "$BRANCH" ] && echo -n " \[\033[32m\]$FOLDER"; echo -n " \[\033[33m\]($BRANCH)"; else echo -n " \[\033[32m\]$FOLDER"; fi`\[\033[00m\] $ \[\]'

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
# <<< devc bashrc-additions <<<
DEVC_BASHRC_ADDITIONS
