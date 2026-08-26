#!/bin/bash
# devc-config create-time script — two fenced blocks, run in this order:
#
#   1. devc:devc-config    — run the project's own create-time script, if it has one.
#   2. devc:bashrc-additions — devc's own prompt/title/attach-clear ~/.bashrc block.
#
# install.sh copies this file, unmodified, to
# /usr/local/share/devc-features/devc-config/post-create.sh at image build time; the manifest's
# postCreateCommand names that copy directly, so there is nothing to bake and no options cross
# into this file. The devcontainer CLI runs it AS THE REMOTE USER, and runs every
# Feature-declared postCreateCommand BEFORE the one the consumer's own devcontainer.json
# declares — so this hook's exit code can fail create before the project's own
# postCreateCommand, if any, ever starts.
#
# devc/tests/devc_config_test.sh and devc/tests/bashrc_additions_test.sh each extract their own
# fence below and run it — unmodified — against this file directly, so neither test can drift
# from the implementation. Nothing inside either fence may be reformatted, reworded, or have a
# comment dropped for tidiness; every line inside them is load-bearing for one of the cases
# those harnesses assert.
set -e

# devc:devc-config (start)
set -e
PROJECT_ROOT="${PROJECT_PATH:-$PWD}"
# Each step of post-create.sh is its own `bash` invocation, so the project cwd is not
# inherited from the orchestrator — establish it here, for the hook's benefit.
cd "$PROJECT_ROOT"
for candidate in \
  "$PROJECT_ROOT/.devc/devc-post-create.sh" \
  "$PROJECT_ROOT/.devcontainer/devc-post-create.sh"; do
  # `-e` is false for a dangling symlink, so `-L` catches that case too and lets it fall
  # into the not-executable error below rather than being skipped as absent.
  [ -e "$candidate" ] || [ -L "$candidate" ] || continue
  if [ ! -x "$candidate" ]; then
    echo "devc: $candidate is not executable — chmod +x it, or remove it" >&2
    exit 1
  fi
  echo "devc: running $candidate"
  "$candidate"
  break
done
# devc:devc-config (end)

# devc:bashrc-additions (start) — devc/tests/bashrc_additions_test.sh runs everything between
# these two markers against a temp $HOME, so keep the block self-contained. BASHRC= is this
# fence's one parameter, and the harness re-points it with `sed -e "s#^BASHRC=.*#…#"` — it must
# stay a bare assignment at the start of a line for that to keep working.
#
# Moved here from devc's own scripts/bashrc-additions.sh (retired) — this is what makes devc's
# prompt/title/attach-clear behavior reach a project-mode repo for the first time, since
# devc-config is the one Feature devc dynamically injects into every container it starts. See
# .plans/archived/devc-swap-baseline-features.md.
#
# `exit 0` would end devc-config's whole post-create.sh, not just this block — guard with `if`
# instead, the same shape the devc:seed-link fence above (in the agents Feature) uses.
BASHRC="$HOME/.bashrc"
MARKER="# >>> devc bashrc-additions >>>"
if ! grep -qF "$MARKER" "$BASHRC" 2>/dev/null; then

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

fi
# devc:bashrc-additions (end)
