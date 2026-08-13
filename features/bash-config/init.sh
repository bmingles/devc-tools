# bash-config — the sourcing logic. Sourced by the two static blocks install.sh appends to
# ~/.bashrc and to the login profile; never executed, so there is no shebang and no `set -e`.
# It runs *inside* the caller's shell, and killing an interactive shell over one bad layer
# script is not this file's call.
#
# install.sh ships this file **verbatim** and nothing — not install.sh, not post-create.sh —
# ever rewrites a line of it. That is the whole reason the two directories below are fixed
# paths: the thing that made shell-dirs expensive was that its sourcing logic lived inside
# ~/.bashrc and carried the options, so both halves of the Feature had to patch lines in it.
# Here the configuration lives in files this Feature owns (dirs/project is a symlink, dirs/env.sh
# is written at create time) and the code is a constant.
#
# **POSIX sh, deliberately.** The login profile this is sourced from is ~/.profile on a
# Debian-derived image, and ~/.profile is read by dash — measured: `sh -l` executes the block.
# So no `[[ ]]`, no arrays, no `local`, no `+=`, however much of that bash would accept on the
# ~/.bashrc side.
#
# Its input is `_bash_config_kind`, which the block assigns immediately before sourcing this
# file: `bashrc` or `profile`, selecting which prefix is sourced. The unset for it is *here*
# rather than in the block, so that the block stays two lines that never change and a missing
# or unreadable init.sh leaves nothing behind but that one variable.
#
# `bashrc_` and `profile_` are **targets, not ordering**. They pick which file sources a
# script. In an interactive login shell both run, and bashrc_ runs first — because ~/.profile
# sources ~/.bashrc partway through, before ever reaching its own appended block. In a plain
# terminal only bashrc_ runs; under `bash -lc` only profile_. Two audiences with a partial
# overlap, not two layers.

# The one path in this file. Overridable only for the offline harness — a Feature that is
# published cannot have its fixed paths depend on the environment of the shell that reads it.
_bash_config_dirs="${_BASH_CONFIG_DIRS:-/usr/local/share/devc-features/bash-config/dirs}"

_bash_config_source_dir() { # _bash_config_source_dir <directory>
  # An absent directory, a dangling symlink (`-d` follows, so it is false) and an empty one are
  # all silent successes at rc 0. This Feature has to be safe to leave enabled in a project that
  # ships no scripts at all, or the one-line opt-in is worthless.
  [ -d "$1" ] || return 0

  # The *physical* path, so the guard below keys on where the files actually are rather than on
  # the name this shell reached them by: dirs/project is a symlink into the workspace, and a
  # directory reached under two names is still one directory.
  _bash_config_real=$(CDPATH= cd -P "$1" 2> /dev/null && pwd)
  [ -n "$_bash_config_real" ] || _bash_config_real="$1"

  # Source a directory at most once per shell **per kind**. The kind belongs in the key: an
  # interactive login shell runs the bashrc block and then the profile block, over these same
  # two directories, and a key of the path alone would let the first pass mark them done and
  # silently disable every profile_*.sh in the container. Deliberately not exported — it must
  # reset per shell, not inherit into a subshell that legitimately re-sources ~/.bashrc.
  case ":${_BASH_CONFIG_DONE:-}:" in
    *":$_bash_config_kind@$_bash_config_real:"*) return 0 ;;
  esac
  _BASH_CONFIG_DONE="${_BASH_CONFIG_DONE:+$_BASH_CONFIG_DONE:}$_bash_config_kind@$_bash_config_real"

  for _bash_config_f in "$1/${_bash_config_kind}_"*.sh; do
    # An unmatched glob stays literal, so this -f test is also the empty-directory guard — and
    # what keeps a *directory* named bashrc_x.sh from being sourced.
    [ -f "$_bash_config_f" ] && . "$_bash_config_f"
  done
  # Also the function's exit status: `unset` succeeds, where the loop's last `[ -f ]` may not.
  unset _bash_config_f
}

# Anything other than the two kinds is a misuse (this file sourced by hand, say), and a no-op
# rather than a guess: an empty kind would glob `_*.sh` and source files nobody named.
if [ "${_bash_config_kind:-}" = bashrc ] || [ "${_bash_config_kind:-}" = profile ]; then
  # First, and outside the helper so its exports land in the shell rather than in a function:
  # post-create.sh writes PROJECT_PATH here, so a layer script can use it without the consumer
  # having declared a remoteEnv. Absent is normal — nothing creates it at build time.
  [ -r "$_bash_config_dirs/env.sh" ] && . "$_bash_config_dirs/env.sh"

  # User directory first, project second, so a project's committed settings win on conflict —
  # the same system → global → local order git uses. A project file that *assigns* rather than
  # appends to a shared variable (PS1, PATH) therefore overrides the personal one.
  _bash_config_source_dir "$_bash_config_dirs/user"
  _bash_config_source_dir "$_bash_config_dirs/project"
fi

# No helper and no loop variable survive, and this is the last thing ~/.bashrc runs — a
# consumer's prompt may render $?, so a stray non-zero status here would show up as an error on
# the very first prompt of every shell. `unset` cannot fail, which is why it goes last.
unset -f _bash_config_source_dir
unset _bash_config_dirs _bash_config_real _bash_config_kind
