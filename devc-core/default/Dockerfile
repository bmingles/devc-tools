FROM mcr.microsoft.com/devcontainers/base:noble

# devc's baseline used to be this Dockerfile plus a top-level create-time orchestrator
# (post-create.sh -> scripts/*), baked in so the zero-config path could invoke it by
# absolute path. That baseline is now delivered by Features instead (agents,
# git-container-config; see devcontainer.json) — this Dockerfile survives only for its
# base image and the ripgrep install below. See .plans/archived/devc-swap-baseline-features.md's
# "The Dockerfile stays" section: nothing here may become a dependency again.

USER root

# ripgrep. Claude Code's Bash tool injects an `rg` shell *function* that routes to the
# ripgrep bundled inside the claude binary, which hides the absence of a real one: any
# tool that is not a Claude bash shell (a script, a subprocess, an editor extension)
# sees no `rg` on PATH. Install the actual binary. A base-image preference, not a devc
# dependency — see the plan section above before adding anything else here.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ripgrep \
    && rm -rf /var/lib/apt/lists/*

USER vscode
