# devc-tools

A collection of small tools for working with **devcontainers** — each one
self-contained in its own subfolder, with its own docs and build tasks.

## Install

```sh
curl -fsSL https://github.com/bmingles/devc-tools/releases/latest/download/install.sh | sh
```

Installs the prebuilt binaries for your machine into `~/.local/bin` — **no Deno
needed**, and never `sudo`. On macOS that is `devc` and the `devc-bridge` host
CLI; on Linux, `devc`. Both get the Linux `devc-bridge` **container client**,
which lands in `~/.config/devc-bridge/client/` where every devcontainer with the
[bridge Feature](features/devc-bridge/README.md) mounts it from.

Every archive is checked against the release's own `checksums.txt` before
anything is written. The script itself is a release asset, so the URL above
always serves the copy that release was built and tested with — not whatever
`main` currently holds.

Knobs, as env vars (it is piped to `sh`, so there are no flags):

| Variable           | Default            | Does                                          |
| ------------------ | ------------------ | --------------------------------------------- |
| `DEVC_VERSION`     | the latest release | Install a specific tag, e.g. `v0.1.0`         |
| `DEVC_INSTALL_DIR` | `~/.local/bin`     | Where `devc`/`devc-bridge` go                 |
| `DEVC_TOOLS`       | all that apply     | Subset to install: `devc`, `bridge`, `client` |

Re-run it to upgrade — download, verify, replace. To uninstall, delete the files
it printed.

Notes:

- **Add `~/.local/bin` to your `PATH`** if it isn't already; the installer says
  so and prints the line to add rather than installing something unreachable.
- `devc` needs `docker` and the
  [`devcontainer` CLI](https://github.com/devcontainers/cli) at run time. The
  installer reports whichever are missing and installs anyway.
- `devc` prints `Info Failed to resolve '<name>' for allow-run` on stderr for
  each of `docker`/`devcontainer`/`tmux` that is not on `PATH`. It is Deno's
  line, it is harmless, and it goes away as you install them. Silencing it would
  mean giving up the allowlist, which is the wrong trade for a tool that shells
  out to Docker.
- Gatekeeper: `curl` does not set `com.apple.quarantine`, so an installed macOS
  binary runs. One downloaded through a browser would not.
- **Windows is out of scope**, and the `devc-bridge` **host** CLI is macOS-only
  — every command it ships is macOS (`caffeinate`). Its container client and
  `devc` itself are fine on Linux.

To build from source instead, see each tool's README; `install.sh` at the repo
root is the source of truth for the script above.

## Tools

| Tool                                    | What it does                                                                                                                                                                                                                                                                                    |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`devc-bridge/`](devc-bridge/README.md) | Lets a devcontainer invoke allowlisted commands on the host (e.g. `caffeinate` the Mac while a Claude Code session runs). Runs headless; `devc-bridge status` reports idle/active, and a menu-bar tray is an opt-in extra.                                                                      |
| [`devc/`](devc/README.md)               | Dev container lifecycle CLI (`up`, `attach`, `claude`, `exec`, `build`, …) over a bundled default config, plus `devc config` — a TUI that bind-mounts sibling projects, Git worktrees, and agent skill folders into the project's `.devcontainer/`, editing only its own comment-fenced blocks. |

## Repo layout

| Path                        | Role                                                                                  |
| --------------------------- | ------------------------------------------------------------------------------------- |
| `devc-bridge/`              | The host command bridge — see its [README](devc-bridge/README.md)                     |
| `devc/`                     | The dev container CLI + config TUI — see its [README](devc/README.md)                 |
| `features/`                 | Published devcontainer Features — see [`devc-bridge`](features/devc-bridge/README.md) |
| `install.sh`                | The `curl \| sh` installer — source of truth; shipped as a release asset              |
| `tests/install_test.sh`     | Its shell harness (`bash tests/install_test.sh install.sh`) — offline, no network     |
| `.github/workflows/`        | `release.yml` (binaries from a `v*` tag) and `publish-feature.yml` (the Feature)      |
| `scripts/bash_aliases.sh`   | Shell functions to run each tool from source (no build) — source it from `~/.bashrc`  |
| `.devc/`                    | Devcontainer config for developing _this_ repo (bind mounts, env, post-create)        |
| `.plans/`                   | Plan docs; `.plans/PLAN.md` is the status index                                       |
| `devc-tools.code-workspace` | VS Code workspace file                                                                |

Each tool owns its setup instructions; start with the tool's own README.

## Releasing

**One version for the whole repo, moving in lockstep.** A single `vX.Y.Z` tag
gates both tools; bumping one republishes the other unchanged. The tag is the
source of truth and nothing rewrites a version during the build — a tag that
disagrees with any of the four hand-maintained versions fails the workflow
before anything is compiled.

To cut a release:

1. Bump the version in **all four**: `VERSION` in `devc/help.ts`,
   `devc-bridge/host/version.ts` and `devc-bridge/client/version.ts`, plus
   `"version"` in `features/devc-bridge/devcontainer-feature.json`. The first
   three are guarded by `release.yml`, the fourth by `publish-feature.yml` —
   miss it and the binaries publish while the Feature does not. Prereleases are
   no exception — to tag `v0.1.0-rc.1`, every one of them must be `0.1.0-rc.1`,
   so nothing claims a version its release does not have.
2. Commit, then `git tag v0.1.0 && git push --tags`.
3. [`release.yml`](.github/workflows/release.yml) builds each of the eight
   archives on a runner of its own architecture, runs `--version` on what it
   built, writes `checksums.txt`, stamps the tag into `install.sh` and publishes.
   [`publish-feature.yml`](.github/workflows/publish-feature.yml) pushes the
   devcontainer Feature on the same tag.

Neither workflow has ever run, and the release path crosses machines this repo
is not developed on. Before the first real tag, work through
[docs/manual-verification.md](docs/manual-verification.md) — the checks that
need GitHub Actions, a Docker host or a Mac, ordered cheapest-and-most-
informative first.

A tag with a `-suffix` publishes as a prerelease, so
`releases/latest/download/install.sh` keeps pointing at the last stable one. To
exercise the whole matrix before tagging, run `release.yml` from the Actions tab
with `dry_run` — it builds and uploads everything as workflow artifacts without
creating a release.
