# Releases and installer — prebuilt binaries + `curl | sh`

## Goal

Tag a version, have CI publish every binary this repo produces, and let anyone
install the right ones for their machine with one command:

```sh
curl -fsSL https://github.com/bmingles/devc-tools/releases/latest/download/install.sh | sh
```

After this, nobody needs Deno to _use_ these tools — only to develop them.

### Why

Every install path today assumes a clone and a toolchain: `deno task build` for
`devc`, `deno task build` again for the bridge host, `deno task build:client`
for the container client, or `source scripts/bash_aliases.sh` to run all of it
from source. [devc-bridge-client-mount](devc-bridge-client-mount.md) already
fixed the _destination_ the container client must land in
(`~/.config/devc-bridge/client/devc-bridge`) and named this plan as the
follow-on that fills it for a typical user. This is that plan, widened to cover
`devc` and the bridge host as well.

## Findings that constrain the design

Four things were verified against the real toolchain (Deno 2.9.5) before
writing this, because each one invalidates an obvious approach:

1. **A compiled `devc-bridge` host binary cannot `start`.** `start`
   (`host/main.ts:99-121`) shells out to `deno desktop … main.ts` with
   `cwd: dirname(fromFileUrl(Deno.mainModule))`. In a compiled binary
   `Deno.mainModule` is a _virtual_ path — `file:///tmp/deno-compile-<name>/main.ts`
   — that does not exist on disk. Confirmed by compiling and running it:

   ```
   devc-bridge: building tray app…
   NotFound: Failed to spawn '/usr/local/bin/deno': No such cwd '/tmp/deno-compile-dbtest'
   ```

   It also assumes a `deno` on the user's PATH, which a released binary must
   not. **Publishing the host binary is blocked until `start` stops building.**
   `stop`/`status`/`run` are unaffected — the compiled binary runs those fine.
2. **`deno desktop` cross-compiles**, `--target` accepting the same six triples
   as `deno compile` (`x86_64`/`aarch64` × `apple-darwin`/`unknown-linux-gnu`/
   `pc-windows-msvc`). `deno desktop --output DevcBridge.app --target
   aarch64-apple-darwin` was run **from this Linux container** and produced a
   well-formed bundle with a valid Mach-O (`cf fa ed fe`) at
   `Contents/MacOS/laufey_webview`. So one `ubuntu-latest` job can build every
   artifact — subject to the signing question in Risks.
3. **`deno desktop --icon` cannot cross-build from Linux.** It shells out to
   macOS's `iconutil` to turn the generated `.iconset` into an `.icns`; on Linux
   that is `error: No such file or directory (os error 2)` and **exit 1**. The
   same build without `--icon` exits 0 and produces a complete bundle. So
   finding 2's "one Linux job builds everything" holds for the eight plain
   binaries but **not** for the two icon-bearing `.app`s.
4. **The tray app's executable is `laufey_webview`, not the bridge.** The
   bundle is a generic webview host (`CFBundleExecutable=laufey_webview`,
   `NSPrincipalClass=LaufeyApplication`) with the program in a sibling dylib. So
   the `.app` is **not** usable as the `start`/`stop`/`status` CLI, and macOS
   needs **two** artifacts: a plain compiled CLI binary and the bundle.

## Decisions

1. **Assets are named by Deno's own target triple.** `aarch64-apple-darwin`,
   `x86_64-unknown-linux-gnu`, and so on — the exact strings `--target` takes.
   Inventing a second vocabulary (`darwin-arm64`, `macos`, `amd64`) would mean
   two mappings to keep in step: one in the workflow, one in the installer.
2. **Every asset is a `.tar.gz`, even single binaries.** The tray is a
   _directory_ bundle, and its executable bits matter; tar carries mode and
   structure, `zip` does not portably. One archive format keeps the installer's
   extract path single.
3. **`checksums.txt` is a release asset and the installer verifies against it.**
   A `curl | sh` that pipes an unverified binary onto PATH is the thing this
   plan exists to make routine, so it should not be the thing it does casually.
4. **Every artifact is built natively, on a runner of its own architecture, and
   executed there before release.** Four build jobs — `ubuntu-24.04`,
   `ubuntu-24.04-arm`, `macos-13` (Intel), `macos-14` (Apple Silicon) — each
   producing only its own target's assets, then a fifth job that collects them,
   writes `checksums.txt` and publishes.

   Cross-compiling would work for most of this (finding 2) and is how the
   x86_64 darwin binary in the Risks section was proven. Native wins anyway
   because it answers three things at once: `--icon` needs macOS's `iconutil`
   (finding 3), ad-hoc signing needs a Mac, and — the one that actually decides
   it — **a native runner can run the binary it just built**, so "does this
   execute on Apple Silicon" stops being an open question answered by a
   stranger's bug report and becomes a CI assertion. All four runner types are
   free on public repos, so the usual reason to cross-compile does not apply.

   Ad-hoc `codesign -s -` the darwin assets rather than relying on Deno's
   behavior: the Risks section shows it signs arm64 and not x86_64, which is
   defensible but is not a contract this repo should depend on.

   If `ubuntu-24.04-arm` is unavailable, cross-build the two aarch64 Linux
   assets from x86_64 — already proven, and the client has been built that way
   since [devc-bridge-client-mount](devc-bridge-client-mount.md). That is a
   contained fallback for one job, not a reason to design around.
5. **`start` builds the tray only when running from source.** This is the
   change that unblocks finding 1, and it must preserve the dev property that
   `start` always reflects the current working tree:
   - **From source** — build the app, then launch it. Exactly today's behavior.
   - **Compiled** — require an already-installed
     `~/.config/devc-bridge/DevcBridge.app` and `open -g` it; if it is missing,
     fail naming the installer.

   Detect the two by asking whether the resolved host dir actually contains
   `main.ts` — the same probe that finding 1 shows failing. Deliberately not a
   build-with-fallback: a compiled binary that silently shelled out to a `deno`
   it found on PATH would build a tray from **whatever source tree that Deno
   resolves**, which is worse than failing.
6. **The installed tray path is the one `start` already uses.**
   `join(cfg.base, 'DevcBridge.app')` — `~/.config/devc-bridge/DevcBridge.app`.
   The installer writes where the code already looks; no new path enters the
   config.
7. **Default install dir is `$HOME/.local/bin`, and the installer never uses
   `sudo`.** A pipe-to-shell that escalates is a bad habit to teach.
   `DEVC_INSTALL_DIR` overrides; if the chosen dir is not on `PATH`, say so with
   the line to add, rather than silently installing something unreachable.
8. **One version for the whole repo, moving in lockstep.** A single tag
   `vX.Y.Z` gates both tools; bumping one republishes the other unchanged. Per-
   tool tags (`devc/v0.2.0`) would make the installer resolve two versions and
   reason about compatible pairs, for a two-tool repo that installs as one
   thing. **The tag is the source of truth, and CI enforces the match**
   rather than rewriting source during the build. `devc/help.ts:6` already holds
   a hand-maintained `VERSION`; a release job that edited it would make the
   published binary disagree with the commit it claims to be. A tag whose
   version does not equal `VERSION` fails the workflow.
9. **Both `devc-bridge` binaries gain a `--version`/`version` they lack today,**
   from a `VERSION` const mirroring devc's — the host CLI _and_ the container
   client. An installer that can place three binaries needs each of them to be
   able to say what it is, and "which client is actually mounted in here" is a
   question the container currently cannot answer at all.
10. **The Linux client is arch-matched to the _host_,** carrying decision 9 of
    [devc-bridge-client-mount](devc-bridge-client-mount.md) into the installer:
    an arm64 Mac gets the `aarch64-unknown-linux-gnu` client, because Docker
    Desktop runs containers matching the host. This is the one asset whose
    selection is **not** "the platform I am running on" in the usual sense, and
    it is the easiest thing in this plan to get backwards.
11. **Windows is out of scope (confirmed), and `devc-bridge` is macOS-only.** `devc` drives
    `tmux`/`tty` and POSIX paths; the bridge's every shipped command is macOS
    (`caffeinate`), `start` launches via `open -g`/LaunchServices, and the tray
    is a menu-bar app. A Linux host could run the bridge headless — the tray
    already degrades that way (`tray.ts:106`) — but nothing it could usefully
    run is shipped, so it is a follow-on, not a v1 gap. Document both, do not
    half-build them.
12. **`install.sh` ships as a release asset, not from `main`.** GitHub serves a
    permanent redirect at
    `releases/latest/download/<asset>` (and `releases/download/vX.Y.Z/<asset>`
    for a pinned one), so an asset-hosted script still has one stable URL — it
    just resolves to the script **that release was built and tested with**,
    instead of whatever `main` currently holds. A script on `main` is a live
    edit against every past release; this is not. Two things follow:
    - The workflow **stamps the version into the copy it uploads**, so the
      script installs its own release's binaries with no GitHub API call, no
      rate limit, and no way to drift from the assets it was published beside.
      `DEVC_VERSION` still overrides for a deliberate downgrade.
    - `install.sh` lives at the repo root as the source of truth and is edited
      there; the workflow uploads it. Do not point users at the `main` copy.
13. **Re-running the installer is the upgrade path.** No version tracking, no
    manifest, no self-update command: download, verify, replace. Uninstall is
    documented as file removal rather than coded.

## The release matrix

Ten archives — eight plain binaries and two bundles — plus `checksums.txt`
and `install.sh`, from tag `vX.Y.Z`:

| Asset                                          | Contains           | Built with                               |
| ---------------------------------------------- | ------------------ | ---------------------------------------- |
| `devc-<target>.tar.gz` × 4                     | `devc`             | `deno compile --include default`         |
| `devc-bridge-host-<darwin-target>.tar.gz` × 2  | `devc-bridge`      | `deno compile --include commands`        |
| `DevcBridge-<darwin-target>.app.tar.gz` × 2    | `DevcBridge.app/`  | `deno desktop --include commands --icon` |
| `devc-bridge-client-<linux-target>.tar.gz` × 2 | `devc-bridge`      | `deno compile` (client flags)            |
| `checksums.txt`                                | sha256 of each     | `sha256sum`                              |
| `install.sh`                                   | the stamped script | version substituted at release time      |

`<target>` ∈ the four triples; `<darwin-target>` and `<linux-target>` are their
two-element subsets. `devc` ships all four because a Linux host runs
devcontainers too.

**Three distinct binaries are named `devc-bridge`** — the host CLI, the
container client, and (conceptually) the tray. They differ in target OS,
permissions and destination, and the installer writes all three on macOS. Asset
names disambiguate with `-host-` and `-client-`; keep that in any new code that
touches them.

## Implementation

### `devc-bridge/host/main.ts` — `start` (prerequisite, decision 5)

Split the current build-then-launch into: resolve the app path → if running from
source, build it → launch it → wait for the pidfile. The launch, the port-in-use
check, the pidfile wait and the log tail are unchanged. A compiled binary with
no installed app must exit non-zero naming both the expected path and the
install command; it must not attempt a build.

This is testable without a GUI: the from-source/compiled decision is a pure
function of "does `<hostDir>/main.ts` exist", so it can be unit-tested by
pointing it at a temp dir.

### `devc-bridge/host/version.ts` (new) + `main.ts`

`VERSION` const, a `version` subcommand and `--version`/`-V`, mirroring
`devc/help.ts:6`. Add `version` to `USAGE`.

### `.github/workflows/release.yml` (new)

Triggered by `push` on tag `v*`, plus `workflow_dispatch` with a `dry_run`
input that builds and uploads workflow artifacts **without** creating a release
— so the matrix can be exercised before a tag exists. `permissions: contents:
write`.

**Four build jobs, one publish job** (decision 4). The build jobs are one
matrix over `{ubuntu-24.04, ubuntu-24.04-arm, macos-13, macos-14}`, each
building only its architecture's assets, smoke-testing each one it produced
(`--version` must print the release version — which is also what makes decision
9's version flags load-bearing rather than cosmetic), ad-hoc signing on macOS,
and uploading them as workflow artifacts. The publish job runs once, downloads
all of them, and:

1. `sha256sum` every archive into `checksums.txt`.
2. Stamp the version into a copy of `install.sh` (decision 12).
3. Publish with `gh release create` (the `GITHUB_TOKEN` already in the runner).
   Prefer the built-in CLI over a third-party action: fewer third parties in the
   path that produces binaries people `curl | sh`.

Two gates run before any of it, on the cheapest runner:

- **Version guard:** on a tag, assert `v${VERSION from devc/help.ts}` equals the
  tag, and the same for both bridge `VERSION`s. Mismatch fails before anything
  is built (decision 8).
- **Test gate:** `deno fmt --check`, `deno check`, `deno task test`. A release
  must not be publishable from a red tree. **The pre-existing failure is already
  fixed** — `tests/fixtures/mounts_fence_between.jsonc` was missing its
  `// <<< devc:projects` end marker, so `findFence` threw
  `UnterminatedFenceError` exactly as it should; the fixture, not the code, was
  wrong. The suite is green (268/268), so this gate can go in as-is.

All jobs pin `denoland/setup-deno` to the Deno version this repo builds with.

Use the repo's existing task definitions where they exist rather than
duplicating compile flags in YAML; where the workflow needs flags a task does
not express (`--target`, an output path under `dist/`), add the task rather than
inlining the flags. Permission flags drifting between a local build and a
released binary is the failure this avoids.

### `install.sh` (new, repo root)

POSIX `sh` (not bash — it is piped to whatever `sh` is), `set -eu`, and written
so a truncated download cannot execute a partial script: wrap the body in a
`main` function invoked on the last line.

Behavior:

- **Detect** `uname -s`/`uname -m` → triple. Anything else exits with a message
  naming what is supported (decision 11).
- **Resolve the version:** `DEVC_VERSION` if set, else the latest release tag
  from the GitHub API.
- **Download** the assets for this platform plus `checksums.txt` into a temp
  dir; verify with `sha256sum` or `shasum -a 256`, whichever exists; abort on
  mismatch. Trap-clean the temp dir.
- **Install**, each by extract-then-rename so a failure cannot leave a partial
  binary in place:

  | What                       | Where                                        |
  | -------------------------- | -------------------------------------------- |
  | `devc`                     | `$DEVC_INSTALL_DIR` (default `~/.local/bin`) |
  | `devc-bridge` host (macOS) | `$DEVC_INSTALL_DIR`                          |
  | `DevcBridge.app` (macOS)   | `~/.config/devc-bridge/DevcBridge.app`       |
  | Linux client               | `~/.config/devc-bridge/client/devc-bridge`   |

- **The client is installed on every platform**, arch-matched to the host
  (decision 10) — that is the whole point of the destination
  [devc-bridge-client-mount](devc-bridge-client-mount.md) established, and it
  overwrites devc's placeholder or any previous client unconditionally
  (decision 8 of that plan).
- **Flags** (env vars, since it is piped): `DEVC_VERSION`, `DEVC_INSTALL_DIR`,
  `DEVC_TOOLS` to limit what is installed (`devc`, `bridge`, `client`).
- **Check prerequisites, warn, never block.** Report any of `docker`, the
  `devcontainer` CLI or `node` that is missing, then install anyway. An
  installer that refuses because Docker is not running is worse than one that
  says so — and the noise in Risks makes the same list visible later anyway.
- **Report** what was installed and at what version, and warn when
  `$DEVC_INSTALL_DIR` is not on `PATH`, printing the `export` line to add.

### `.gitignore`

Add `/dist/` (workflow build output; also what a local dry run produces).

### Docs

- **Root `README.md`** — an Install section with the `curl` line, above the
  per-tool table. This becomes the front door, so it goes first.
- **`devc/README.md`** — installed binary as the primary path; `deno task build`
  demoted to development.
- **`devc-bridge/README.md`** — rework "Setup (macOS host)": installer first,
  then the from-source path. Document that a **compiled** `devc-bridge start`
  needs the installed `DevcBridge.app` and will not build one (decision 5), and
  that the client now arrives from the installer rather than `build:client` for
  non-developers.

## Risks

- **Signing: resolved for Intel, unverified for Apple Silicon.** Tested on a
  real Intel Mac against a Linux-cross-built `x86_64-apple-darwin` `devc`:
  `codesign -dv` says **`code object is not signed at all`**, and the binary
  **runs anyway** (`devc 0.1.0`) — x86_64 macOS does not require a signature.
  The `aarch64-apple-darwin` build behaves differently: `codesign` _described_
  it (`Identifier=a.out`, `Format=Mach-O thin (arm64)`) rather than reporting no
  signature, which is consistent with Deno ad-hoc signing arm64 output because
  arm64 macOS requires it. That was **not executable on the Intel test machine**
  ("Bad CPU type"), so it remains inference, not proof.

  **Closed by decision 4:** the darwin assets are built and ad-hoc signed on
  macOS runners and executed there, so neither Deno's signing behavior nor the
  inference above is load-bearing. The verified Intel result stands as the
  reason cross-building is a viable fallback if a runner ever goes away.
- **Gatekeeper quarantine.** `curl` does not set `com.apple.quarantine`, so an
  installed `.app` should launch; a browser-downloaded one would not. Worth a
  README note, not a code path.
- **`--allow-run` noise — accepted, document it.** `devc`'s compiled binary
  prints `Info Failed to resolve 'docker' for allow-run: cannot find binary path`
  on **every invocation** (stderr) for each allowlisted binary missing from PATH
  — verified locally: `docker`, `devcontainer` and `tmux` each produce a line.
  Broadening to a bare `--allow-run` would silence it by giving up the
  allowlist, which is the wrong trade for a tool that shells out to Docker. A
  README note under Install covers it.

## Checklist

- [ ] `devc-bridge/host/main.ts` — `start` builds only from source; compiled
      requires the installed app and fails naming it
- [ ] `devc-bridge/host/version.ts` + `main.ts` — `VERSION`, `version`
      subcommand, `--version`/`-V`, `USAGE` updated
- [ ] `devc-bridge/host/deno.json`, `devc/deno.json`, `devc-bridge/client/deno.json`
      — release build tasks the workflow calls (targeted, output under `dist/`)
- [ ] `.github/workflows/release.yml` — tag trigger + `dry_run` dispatch;
      version + test gates; four native build jobs (`ubuntu-24.04`,
      `ubuntu-24.04-arm`, `macos-13`, `macos-14`) each smoke-testing what it
      built and ad-hoc signing on macOS; publish job with `checksums.txt`,
      stamped `install.sh`, `gh release create`
- [x] `devc/tests/jsonc_edit_test.ts:111` — fixed ahead of this plan: the
      fixture was missing its fence end marker (9/9 passing)
- [ ] `install.sh` — detect, resolve version, verify checksums, install the
      per-platform set, `DEVC_*` env knobs, PATH warning
- [x] `.gitignore` — `/dist/` (added ahead of this plan, for the signing test)
- [ ] Tests for the from-source/compiled probe and for the installer's
      triple→asset mapping (a shell harness in the style of
      `devc/tests/bridge_client_link_test.sh`)
- [ ] `README.md`, `devc/README.md`, `devc-bridge/README.md` — install-first
- [ ] `.plans/PLAN.md` — register

## Validation

- [x] A cross-built `x86_64-apple-darwin` binary runs on an Intel Mac —
      **verified**: unsigned, executes, `devc 0.1.0`
- [ ] `aarch64-apple-darwin` on Apple Silicon — now a CI assertion rather than a
      manual check: the `macos-14` job must execute what it built
- [ ] `deno task test` / `check` / `fmt --check` clean across the repo
- [ ] `workflow_dispatch` with `dry_run` produces all ten archives and a
      `checksums.txt` whose hashes verify
- [ ] Every build job's smoke test runs the binary it produced and sees the
      release version — in particular `macos-14`, which is the arm64 evidence
      this plan could not otherwise get
- [ ] `ubuntu-24.04-arm` is actually available to this repo; if not, the
      aarch64 Linux assets fall back to a cross-build from `ubuntu-24.04`
- [ ] Tag a prerelease (`v0.1.0-rc.1`) → release created with every asset
- [ ] A tag disagreeing with `VERSION` fails the workflow before building
- [ ] `install.sh` run against the prerelease on macOS: `devc --version` and
      `devc-bridge --version` both report it; `~/.config/devc-bridge/DevcBridge.app`
      exists; `devc-bridge status` reports `client: installed`
- [ ] `devc-bridge start` from the **installed** binary launches the installed
      tray with no `deno` on PATH — the case finding 1 blocks today
- [ ] `devc-bridge start` from source still rebuilds and reflects working-tree
      edits (decision 5's dev property is intact)
- [ ] The installed client is the **host-matched Linux** binary: on an arm64
      Mac, `file` reports `aarch64` ELF, and `devc build` in an unrelated repo
      → `devc-bridge ping test` prints `pong`
- [ ] A corrupted `checksums.txt` entry aborts the install with nothing written
- [ ] Re-running the installer upgrades in place
- [ ] `DEVC_INSTALL_DIR` off `PATH` produces the warning and the `export` line

## Relevant Files

- `devc-bridge/host/main.ts` — the `start` change that unblocks shipping it
- `devc-bridge/host/version.ts` — new
- `devc/help.ts` — existing `VERSION`, the guard's reference point
- `.github/workflows/release.yml` — new (no `.github/` exists yet)
- `install.sh` — new
- `devc/deno.json`, `devc-bridge/host/deno.json`, `devc-bridge/client/deno.json`
  — release build tasks
- `devc-bridge/client/build-client.sh` — the dev path to the same destination
  the installer writes; keep the two in step
- `README.md`, `devc/README.md`, `devc-bridge/README.md`
- `.plans/PLAN.md` — register this plan

## Follow-on (not this plan)

- **A CI workflow on push/PR** (fmt/check/test). The release job runs the same
  gate; splitting it out is a separate concern.
- **Linux host support for devc-bridge** — the core is portable and the tray
  already degrades headless, but a useful Linux command set has to exist first.
- **Homebrew tap / `winget`,** once release assets and checksums exist to point
  them at.
