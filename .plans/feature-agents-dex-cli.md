# `agents` 0.5.0 — `installDexCli`: the dex task CLI at build time

## Checklist

- [ ] Resolve the open decision under [Node 24 and a project's `.nvmrc`](#node-24-and-a-projects-nvmrc) before starting
- [ ] `installDexCli` option in `features/agents/devcontainer-feature.json`; manifest `description` names dex among the CLIs; `version` → `0.5.0`
- [ ] `features/agents/install.sh` installs `@zeeg/dex` with npm, as the remote user, through `node_prelude` with a `24.0.0` floor; summary line reports `installDexCli=`
- [ ] Offline harness cases in `features/agents/test/install_options_test.sh` (see [Done when](#done-when))
- [ ] Docker scenario `with_dex` in `features/agents/test/scenarios.json` + `features/agents/test/with_dex.sh`; default `test.sh` asserts `dex` is absent
- [ ] `features/agents/README.md`: option documented; a "Why dex needs Node.js 24" note beside "Why pi needs Node.js", including the `.nvmrc` hazard
- [ ] `features/README.md` table row for `agents` mentions dex; `skills/README.md` points `dex-orchestrating`'s CLI requirement at `installDexCli`
- [ ] `bash features/agents/test/install_options_test.sh` and `bash tests/features_test.sh` pass

## Goal

The [`dex-orchestrating`](../skills/dex-orchestrating/SKILL.md) skill needs the
[dex](https://github.com/dcramer/dex) CLI in the container. devc delivers the
skill through its skills mount; this plan delivers the CLI through the `agents`
Feature, so any container — devc-managed or not — gets both with one option.

`"agents": { "installDexCli": true }` beside a Node ≥ 24 Feature must install a
working `dex`; `"agents": {}` must still install nothing new.

## Existing touchpoints

- `features/agents/devcontainer-feature.json` — option declarations, Feature
  `version` (`0.4.0` today), and the long `description` that enumerates the CLIs.
- `features/agents/install.sh` — build-time installs. `install_cli` (installer
  script piped from a URL, with the `$HOME/.local/bin/<bin>` / `command -v`
  idempotency guard and distinct "Node.js missing" vs "network required"
  failures), `node_prelude` (finds nvm-installed node on a non-interactive shell,
  checks a minimum version, pins `npm_config_prefix=$HOME/.local`), and
  `run_as_remote_user`. pi is the existing npm-backed CLI and the closest model.
- `features/agents/test/install_options_test.sh` — offline harness: real
  `install.sh`, stubbed `curl`/`runuser`, fake CLI binaries.
- `features/agents/test/test.sh` — default scenario; asserts opt-in CLIs absent.
- `features/agents/test/scenarios.json`, `with_pi.sh` — Docker scenario shape to copy.
- `features/agents/README.md` — per-option rationale sections, notably
  "Why pi needs Node.js" and "pi and a project's `.nvmrc`".
- `features/README.md` — published-Features table.
- `skills/README.md` — skills table naming dex as a requirement.

## Contracts

### Option

```jsonc
"installDexCli": {
  "type": "boolean",
  "default": false,
  "description": "Install the dex task-tracking CLI (@zeeg/dex) at build time, as the remote user, into ~/.local/bin. Defaults false. Installs with npm, so it requires Node.js 24.0.0 or newer and npm in the image — add a node Feature alongside this one. ..."
}
```

Named `installDexCli` to match `installClaudeCli` / `installCopilotCli` /
`installPiCli`. No version option (see Not in this plan).

### Install behavior

- Runs as the remote user via `run_as_remote_user`, after `node_prelude "24.0.0"`.
- Installs with `npm install -g @zeeg/dex`; with the prelude's prefix pin the
  binary lands at `$HOME/.local/bin/dex`.
- Skipped when `$HOME/.local/bin/dex` is executable or `dex` is already on PATH —
  same guard as the other CLIs.
- Failure reporting matches `install_cli`: node missing / too old →
  `agents: Dex CLI install failed — see the Node.js requirement above`; any other
  non-zero → `agents: Dex CLI install failed (network required)`. Both fail the build.
- dex publishes no installer script, so `install_cli`'s curl-pipe shape does not
  fit as is. Whether `install_cli` grows an npm mode or a sibling function is
  added is the implementer's call; the guard, the prelude, and the two failure
  messages are the contract.
- The final summary line gains `installDexCli=<value>`.

### Version

`agents` `0.4.0` → `0.5.0` in the same commit (new option, no behavior change
for existing consumers).

## Concept boundaries

- **dex CLI vs `dex-orchestrating` skill.** This Feature installs the CLI only.
  It must not write the skill into `~/.claude/skills`: `~/.claude` is a
  create-time link/volume (see the README's "The three Claude paths"), so a
  build-time write there is shadowed, and the skill already arrives through
  devc's skills mount (`SKILLS_CONTAINER_ROOT`, `devc-core/mounts.ts`).
- **`.dex/` vs `~/.dex` vs `~/.config/dex/`.** `.dex/` is a project's task store
  at its git root and belongs to the project. `~/.dex` (dex home, "centralized"
  mode) and `~/.config/dex/dex.toml` (user config) are dex's own. The Feature
  creates none of them.
- **`dex mcp`.** dex also ships an MCP server. Registering it with Claude Code is
  configuration, not installation — out of scope.
- **dex vs devc.** Different tools with similar names; option, messages and docs
  say "dex" or "Dex CLI" in full, never abbreviate.

## Node 24 and a project's `.nvmrc`

**Open decision — resolve before implementing.**

`@zeeg/dex` declares `engines.node >= 24.0.0` (0.16.0). pi's floor is 22.19.0,
which every current LTS line meets; dex's is not — `lts/jod` (22.x) is still a
common `.nvmrc` pin. As with pi, `~/.local/bin/dex` is a `#!/usr/bin/env node`
script, so with [`node-nvmrc`](../features/node-nvmrc/README.md) it runs under
the **project's** pinned node, not the one it was installed with. A project
pinning Node 22 gets a dex that installs fine at build time and fails at run
time, quite possibly with a raw error rather than a version message.

Options, in rough order of preference:

1. **Document it, like pi.** Same treatment as "pi and a project's `.nvmrc`",
   with a table showing 22.x fails. Cheapest; leaves the hazard live for
   Node 22 projects, which is the common case.
2. **Pin dex's launcher to the install-time node.** Replace the npm symlink
   with a wrapper that execs the absolute path of the node that ran the
   install. Fixes the hazard; decouples dex from `.nvmrc` (acceptable for a
   tool that is not part of the project's own runtime), and an nvm uninstall of
   that version breaks it. The README already argues against this for pi —
   revisit whether that argument holds for a tool that is not project code.
3. **Measure first.** Run dex under Node 22 before choosing: `engines` may be
   conservative. If it works on 22.x, option 1 with an accurate table suffices.

Whatever is chosen, record a scenario or harness case that proves it.

## Done when

- Offline harness (`bash features/agents/test/install_options_test.sh`), new cases:
  - `installDexCli` default → npm is never invoked for dex.
  - `installDexCli: true` → npm invoked as `install -g @zeeg/dex` with
    `npm_config_prefix` = `$HOME/.local`.
  - `$HOME/.local/bin/dex` already present → npm not invoked.
  - npm exits non-zero → build fails with the "network required" message.
  - node absent and no nvm → build fails with the Node.js message.
- `bash tests/features_test.sh` passes (collection guard).
- (needs Docker) `with_dex` scenario: node Feature at version `24`,
  `installDexCli: true`; asserts `command -v dex` is `$HOME/.local/bin/dex` and
  `dex --version` exits 0. Default scenario asserts `dex` absent.

No `.gitignore` changes.

## Not in this plan

- A `dexVersion` option — latest at build time, same as the other CLIs.
- Registering `dex mcp` with Claude Code.
- devc web tool integration of dex.
- Adding `installDexCli` to `devc-core/default/devcontainer.json`.
