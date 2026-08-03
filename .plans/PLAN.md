# Plan Status

## Status

### Pending

- [devc-wizard-modernize](devc-wizard-modernize.md) — Replace the full-screen sidebar wizard (mnemonic `N`/`B`/`A` keys) with a modern inline sequential flow plus a multi-select, type-to-filter folder picker, zero new dependencies, on the existing `tui/term.ts`+`tui/keys.ts`.

### Completed

- [devc-container-feature-fix](archived/devc-container-feature-fix.md) — Fix zero-config `devc up`: a local Feature can't load from devc's out-of-tree bundled config, so the bundled default carries its baseline itself (Dockerfile build-time + top-level postCreateCommand runtime) while `devc config` projects keep the composable Feature. Also drops in-container tmux.

- [devc-help-output](archived/devc-help-output.md) — Clap-style `--help`/`--version`: structured top-level help with a `Commands:` list, `-V`/`--version`, and per-command `devc <cmd> --help` blocks (verbatim from the design doc), in a new pure `help.ts` module.

- [devc-config-wizard](archived/devc-config-wizard.md) — The four-step `devc config` project wizard writing `.devcontainer/` via two comment-fenced mount blocks (`devc:source`/`devc:skills`) over the kept `jsonc_edit.ts`; opt-in per-folder skills with a remembered last-selection seed.
- [devc-global-config](archived/devc-global-config.md) — Global user config (`codeRoots`/`skillsRoots` at `~/.config/devc-tui/config.json`), first-run flow, and the reusable step-based wizard TUI shell (reusing `tui/term.ts`+`tui/keys.ts`) with the Global config step.
- [devc-container-feature](archived/devc-container-feature.md) — Repackage the baseline setup (Claude CLI, `.claude` volume/symlink, shell additions) as a custom devcontainer Feature so a project's own top-level `postCreateCommand` composes instead of clobbering it; make skills opt-in in the zero-config default.
- [devc-lifecycle-core](archived/devc-lifecycle-core.md) — Replace the fence-based tool with the container-lifecycle CLI (`up`/`attach`/`claude`/`exec`/`mounts`/`stop`/`down`/`status`) + bundled default, ported from the reference `@devcontainers/cli`+`docker` implementation (tmux-attach and `.devc` overlay dropped).
- [devc-tui-home-paths](archived/devc-tui-home-paths.md) — Home directory support: expand `~`/`$HOME` in host-side config values, and write mount `source=` paths under home as `${localEnv:HOME}/...`.
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
| devc-tui home directory support — `$HOME` in config, `${localEnv:HOME}` in mounts | [devc-tui-home-paths](archived/devc-tui-home-paths.md) | complete |
| devc lifecycle core — container commands + bundled default (ported) | [devc-lifecycle-core](archived/devc-lifecycle-core.md) | complete |
| devc baseline as a devcontainer Feature — composable postCreate | [devc-container-feature](archived/devc-container-feature.md) | complete |
| devc global config + wizard TUI foundation | [devc-global-config](archived/devc-global-config.md) | complete |
| devc config wizard — project `.devcontainer/` via managed fences | [devc-config-wizard](archived/devc-config-wizard.md) | complete |
| devc help output — clap-style `--help`/`--version` + per-command help | [devc-help-output](archived/devc-help-output.md) | complete |
| devc container baseline fix — out-of-tree Feature + drop in-container tmux | [devc-container-feature-fix](archived/devc-container-feature-fix.md) | complete |
| devc wizard modernize — inline sequential flow + multi-select folder picker | [devc-wizard-modernize](devc-wizard-modernize.md) | in progress |
