# devc-tools

A collection of small tools for working with **devcontainers** — each one self-contained
in its own subfolder, with its own docs and build tasks.

## Tools

| Tool | What it does |
| --- | --- |
| [`devc-bridge/`](devc-bridge/README.md) | Lets a devcontainer invoke allowlisted commands on the host (e.g. `caffeinate` the Mac while a Claude Code session runs), with a menu-bar tray showing idle/active state. |
| [`devc-tui/`](devc-tui/README.md) | Selectively bind-mounts sibling projects, Git worktrees, and agent skill folders into the current repo's devcontainer, and mirrors the selection into its `.code-workspace` — editing only its own comment-fenced blocks. |

## Repo layout

| Path | Role |
| --- | --- |
| `devc-bridge/` | The host command bridge — see its [README](devc-bridge/README.md) |
| `devc-tui/` | The project/worktree mount picker — see its [README](devc-tui/README.md) |
| `scripts/bash_aliases.sh` | Shell functions to run each tool from source (no build) — source it from `~/.bashrc` |
| `.devc/` | Devcontainer config for developing *this* repo (bind mounts, env, post-create) |
| `.plans/` | Plan docs; `.plans/PLAN.md` is the status index |
| `devc-tools.code-workspace` | VS Code workspace file |

Each tool owns its setup instructions; start with the tool's own README.
