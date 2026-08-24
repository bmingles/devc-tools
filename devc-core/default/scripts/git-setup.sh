#!/bin/bash
# Restore the git settings this devcontainer depends on.
#
# ~/.gitconfig is container-local and wiped on every rebuild, while the repo's working
# tree and .git are host bind mounts. Anything git needs at *user* scope therefore has
# to be re-applied on every create.
set -e

# --- per-user identity -------------------------------------------------------------
# Included FIRST so the container-mandated settings below override anything it carries.
# Generated host-side by initialize-command.sh; only user.name / user.email cross over.
IDENTITY=/usr/local/share/devc/gitconfig-identity
if [ -f "$IDENTITY" ]; then
    git config --global --replace-all include.path "$IDENTITY"
fi

# Warn on the *effective* identity rather than on the mount, since the file is also written
# (empty) when the host itself has none configured. No scope flag: `git config --global --get`
# does not follow include.path, so it would report nothing even on a good setup.
if [ -z "$(git config --get user.email || true)" ] ||
    [ -z "$(git config --get user.name || true)" ]; then
    echo "(!) no host git identity found; set user.name/user.email to commit" >&2
fi

# --- container-mandated ------------------------------------------------------------
if ! command -v git-lfs >/dev/null 2>&1; then
    echo "(!) git-lfs not on PATH; skipping LFS filter setup" >&2
else
    # The git-lfs feature runs `git lfs install` at build time as root, so the filters
    # land in /root/.gitconfig and the remoteUser never sees them. Its postCreate script
    # would configure them for the right user, but only when autoPull=true -- which we
    # don't want. Without these filters, git compares materialized LFS binaries against
    # their pointer blobs and reports every LFS asset as modified.
    #
    #   --skip-repo    leave .git/hooks and the repo config alone; they are host-shared
    #                  and already correct, so rewriting them churns the host's state.
    #   --force        take ownership of the filter values, so container behaviour does
    #                  not depend on what the host happens to have configured.
    #   --skip-smudge  don't materialize LFS objects on checkout. Most work here does not
    #                  need them, and checkouts stay fast. Run `git lfs pull` (all) or
    #                  `git lfs checkout -- <path>` (targeted) when you do. The clean
    #                  filter stays active either way, so materialized files still read
    #                  as unmodified.
    git lfs install --force --skip-repo --skip-smudge
fi

# Worktree links must stay relative: absolute paths differ between host (/Users/...) and
# container (/workspaces/...). Without this, a `git worktree add` run inside the container
# writes container-absolute paths the host cannot resolve -- corrupting a .git both sides
# share.
git config --global worktree.useRelativePaths true

# The workspace binds in via grpcfuse and can present a different owner than the container
# user, making git refuse to operate ("detected dubious ownership"). The container is
# single-user and ephemeral, so allowing all paths is fine here.
git config --global --replace-all safe.directory '*'
