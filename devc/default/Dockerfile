FROM mcr.microsoft.com/devcontainers/base:noble

RUN apt-get update \
    && apt-get install -y --no-install-recommends tmux \
    && rm -rf /var/lib/apt/lists/*

USER vscode

RUN curl -fsSL https://claude.ai/install.sh | bash

COPY --chown=vscode:vscode bashrc-additions.sh /tmp/bashrc-additions.sh
RUN cat /tmp/bashrc-additions.sh >> /home/vscode/.bashrc \
    && rm /tmp/bashrc-additions.sh

COPY --chown=vscode:vscode tmux.conf /home/vscode/.tmux.conf

USER root

COPY post-create.sh /usr/local/share/devc/post-create.sh
RUN chmod +x /usr/local/share/devc/post-create.sh
