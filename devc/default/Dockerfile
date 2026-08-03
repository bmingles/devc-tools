FROM mcr.microsoft.com/devcontainers/base:noble

# devc baseline (build-time, cached image layers). Runtime setup that depends on
# volumes/workspace lives in post-create.sh, invoked at container-create time
# (by the devc Feature's postCreateCommand in a project, or by the bundled
# default's top-level postCreateCommand in the zero-config case).
#
# The scripts are the devc Feature's own files; the Dockerfile reaches into the
# feature dir so the zero-config path (which cannot reference the local Feature)
# still gets the same baseline. Feature install.sh also stages post-create.sh, so
# the Feature stays self-contained; the duplicate is idempotent.
COPY features/devc/bashrc-additions.sh features/devc/post-create.sh /tmp/devc/

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
        cat /tmp/devc/bashrc-additions.sh; \
        printf '%s\n' "# <<< devc bashrc-additions <<<"; } >> "$BASHRC"; \
    fi

# Runtime setup script, placed where both the top-level (zero-config) and the
# Feature's postCreateCommand expect it.
USER root
RUN install -d -m 0755 /usr/local/share/devc \
    && install -m 0755 /tmp/devc/post-create.sh /usr/local/share/devc/post-create.sh \
    && rm -rf /tmp/devc
USER vscode
