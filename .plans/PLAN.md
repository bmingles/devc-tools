# Plan Status

## Status

### Pending

### Completed

- [devc-tui-host-folder-paths](archived/devc-tui-host-folder-paths.md) — Fix the `devc-tui:folders` fence, which writes container paths into a workspace file VS Code opens on the host: write host paths relative to the workspace file, and move the selection read-back with them.
- [devc-tui-folder-tree](archived/devc-tui-folder-tree.md) — Make the interactive tree mirror the scanned directory layout: worktree groups shown in place instead of re-parented under their primary, collapsed by default, and the fold column reserved for fold state.
- [devc-tui-ui](archived/devc-tui-ui.md) — The interactive checkbox folder tree on top of the core: scrollable tri-state tree, filter, skills section, writing through the same apply path as the CLI.
- [devc-tui-core](archived/devc-tui-core.md) — New `devc-tui/` tool: scan a configured root for repos and worktrees, and toggle them as bind mounts in `.devcontainer/devcontainer.json` plus folders in the `.code-workspace`, via comment-fenced managed blocks. Headless CLI + tests.
- [host-command-bridge](archived/host-command-bridge.md) — Loopback-TCP + token bridge letting a devcontainer invoke allowlisted host scripts (e.g. `caffeinate`), with a Deno Desktop menu-bar tray showing idle/active state.
- [host-lifecycle-cli](archived/host-lifecycle-cli.md) — Single self-contained `devc-bridge` executable with `start`/`stop`/`status`/`restart` background lifecycle and zero-setup config/command seeding.

## Development Phases

| Phase | Plan | Status |
| ----- | ---- | ------ |
| Host command bridge (socket server + client + tray) | [host-command-bridge](archived/host-command-bridge.md) | complete |
| Host `devc-bridge` lifecycle CLI + zero-setup seeding | [host-lifecycle-cli](archived/host-lifecycle-cli.md) | complete |
| devc-tui core — scan, model, fenced-region file surgery | [devc-tui-core](archived/devc-tui-core.md) | complete |
| devc-tui interactive UI — checkbox project tree | [devc-tui-ui](archived/devc-tui-ui.md) | complete |
| devc-tui tree reshape — folder tree, collapsed by default | [devc-tui-folder-tree](archived/devc-tui-folder-tree.md) | complete |
| devc-tui workspace folders — host paths, not container paths | [devc-tui-host-folder-paths](archived/devc-tui-host-folder-paths.md) | complete |
