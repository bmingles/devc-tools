# Plan Status

## Status

### Pending

- [devc-tui-ui](devc-tui-ui.md) — The interactive checkbox folder tree on top of the core: scrollable tri-state tree, filter, skills section, writing through the same apply path as the CLI.

### Completed

- [devc-tui-core](archived/devc-tui-core.md) — New `devc-tui/` tool: scan a configured root for repos and worktrees, and toggle them as bind mounts in `.devcontainer/devcontainer.json` plus folders in the `.code-workspace`, via comment-fenced managed blocks. Headless CLI + tests.
- [host-command-bridge](archived/host-command-bridge.md) — Loopback-TCP + token bridge letting a devcontainer invoke allowlisted host scripts (e.g. `caffeinate`), with a Deno Desktop menu-bar tray showing idle/active state.
- [host-lifecycle-cli](archived/host-lifecycle-cli.md) — Single self-contained `devc-bridge` executable with `start`/`stop`/`status`/`restart` background lifecycle and zero-setup config/command seeding.

## Development Phases

| Phase | Plan | Status |
| ----- | ---- | ------ |
| Host command bridge (socket server + client + tray) | [host-command-bridge](archived/host-command-bridge.md) | complete |
| Host `devc-bridge` lifecycle CLI + zero-setup seeding | [host-lifecycle-cli](archived/host-lifecycle-cli.md) | complete |
| devc-tui core — scan, model, fenced-region file surgery | [devc-tui-core](archived/devc-tui-core.md) | complete |
| devc-tui interactive UI — checkbox project tree | [devc-tui-ui](devc-tui-ui.md) | |
