FROM mcr.microsoft.com/devcontainers/base:noble

# devc baseline (build-time, cached image layers). No devcontainer Feature is involved:
# the baseline is this Dockerfile plus a top-level "postCreateCommand" (in devcontainer.json)
# running post-create.sh, which only delegates to scripts/*.
#
# scripts/bashrc-additions.sh is consumed here at build time (below). post-create.sh and the
# create-time scripts are baked so the zero-config path — which has no project .devcontainer/
# to run them from — can invoke them by absolute path. In `devc config` mode the top-level
# postCreateCommand runs the copies in the project's own .devcontainer/ instead (so edits apply
# on the next create, no rebuild), and these baked copies simply go unused. initialize-command.sh
# is not copied — it runs on the host, before this image is ever built.
COPY post-create.sh /usr/local/share/devc/post-create.sh
COPY scripts/ /usr/local/share/devc/scripts/

USER root
RUN chmod 0755 /usr/local/share/devc/post-create.sh \
    && chmod -R 0755 /usr/local/share/devc/scripts

USER vscode

# Claude CLI (installed as the target user, into ~/.local/bin — not shadowed by
# the ~/.claude volume mounted at runtime). Idempotent.
RUN if [ ! -x "$HOME/.local/bin/claude" ] && ! command -v claude >/dev/null 2>&1; then \
      curl -fsSL https://claude.ai/install.sh | bash; \
    fi

# .bashrc additions, marker-guarded so a rebuild does not double-append.
RUN BASHRC="$HOME/.bashrc"; \
    MARKER="# >>> devc bashrc-additions >>>"; \
    if ! grep -qF "$MARKER" "$BASHRC" 2>/dev/null; then \
      { printf '%s\n' "$MARKER"; \
        cat /usr/local/share/devc/scripts/bashrc-additions.sh; \
        printf '%s\n' "# <<< devc bashrc-additions <<<"; } >> "$BASHRC"; \
    fi
