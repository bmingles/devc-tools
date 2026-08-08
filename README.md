# devc-tools

A collection of small tools for working with **devcontainers** — each one
self-contained in its own subfolder, with its own docs and build tasks.

## Tools

| Tool                                    | What it does                                                                                                                                                                                                                                                                                    |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`devc-bridge/`](devc-bridge/README.md) | Lets a devcontainer invoke allowlisted commands on the host (e.g. `caffeinate` the Mac while a Claude Code session runs), with a menu-bar tray showing idle/active state.                                                                                                                       |
| [`devc/`](devc/README.md)               | Dev container lifecycle CLI (`up`, `attach`, `claude`, `exec`, `build`, …) over a bundled default config, plus `devc config` — a TUI that bind-mounts sibling projects, Git worktrees, and agent skill folders into the project's `.devcontainer/`, editing only its own comment-fenced blocks. |

## Repo layout

| Path                        | Role                                                                                 |
| --------------------------- | ------------------------------------------------------------------------------------ |
| `devc-bridge/`              | The host command bridge — see its [README](devc-bridge/README.md)                    |
| `devc/`                     | The dev container CLI + config TUI — see its [README](devc/README.md)                |
| `scripts/bash_aliases.sh`   | Shell functions to run each tool from source (no build) — source it from `~/.bashrc` |
| `.devc/`                    | Devcontainer config for developing _this_ repo (bind mounts, env, post-create)       |
| `.plans/`                   | Plan docs; `.plans/PLAN.md` is the status index                                      |
| `devc-tools.code-workspace` | VS Code workspace file                                                               |

Each tool owns its setup instructions; start with the tool's own README.
