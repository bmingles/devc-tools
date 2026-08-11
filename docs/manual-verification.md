# Manual verification

Everything here needs something the dev container does not have: GitHub Actions,
a Docker host, or a Mac. It is the residue of `devc-bridge-feature`,
`devc-bridge-tray-decouple` and `release-and-installer` — every other check in
those plans is automated and green.

**Do the sections in order.** Each one is cheap and rules out the failures that
would waste the next one. §1 is free and answers the most.

Baseline that is already green, for contrast — re-run before starting if the
tree has moved:

```sh
deno fmt --check                                   # repo root
(cd devc && deno task check && deno task test)                    # 269 tests
(cd devc-bridge/host && deno task check && deno task test)        # 10 tests
(cd devc-bridge/client && deno task check)
bash tests/install_test.sh install.sh                             # 34 cases
(cd devc && for t in seed_link:default/scripts/agents-setup.sh \
                     shell_dirs:default/scripts/bashrc-additions.sh \
                     project_hook:default/scripts/project-hook.sh; do
  bash "tests/${t%%:*}_test.sh" "${t#*:}"; done)
bash features/devc-bridge/test/install_link_test.sh                # 5 cases
```

---

## 1. Workflow dry runs — no tag, nothing published

Both workflows have **never run**. Do this from a branch, not a tag.

```sh
gh workflow run release.yml
gh workflow run publish-feature.yml
gh run list --limit 5
```

> **The `dry_run` input is decorative.** Neither workflow references it — every
> publish step is gated on `startsWith(github.ref, 'refs/tags/v')` instead. A
> dispatch from a branch therefore cannot publish whatever you set it to. It
> fails closed, so this is safe, but do not read the checkbox as the control.

Expected from `release.yml`:

- [ ] `gate` passes — the version guard prints three `0.1.0` lines and, off a
      tag, synthesizes `tag=v0.1.0`
- [ ] All four `build` jobs pass, **including `ubuntu-24.04-arm`**. This is the
      one runner whose availability to this repo is unverified. If it is not
      available: drop that matrix row and add
      `aarch64-unknown-linux-gnu` to the `ubuntu-24.04` job as a cross-build
      (already proven), losing only that asset's smoke test.
- [ ] Each build job's smoke test prints `devc 0.1.0` / `devc-bridge 0.1.0` —
      this is the first time the macOS binaries are ever _executed_, and the
      first run of the ad-hoc `codesign` step
- [ ] `publish` collects exactly these eight, and `diff` against the expected
      list is empty:

      devc-{x86_64,aarch64}-unknown-linux-gnu.tar.gz
      devc-{x86_64,aarch64}-apple-darwin.tar.gz
      devc-bridge-host-{x86_64,aarch64}-apple-darwin.tar.gz
      devc-bridge-client-{x86_64,aarch64}-unknown-linux-gnu.tar.gz

- [ ] `sha256sum -c checksums.txt` passes in the collect step
- [ ] The stamp step rewrites `DEVC_RELEASE_VERSION='v0.1.0'` and `sh -n` passes
- [ ] A `release-v0.1.0` artifact is uploaded; **no GitHub release exists**

Expected from `publish-feature.yml`:

- [ ] `features package` succeeds; version guard is skipped off a tag
- [ ] Nothing is pushed to ghcr.io

---

## 2. The Feature, before it is published — Docker host

The `ghcr.io/...` reference cannot resolve until §3. Test the Feature by
**relative local path** instead; this needs no registry and no overlay.

Prerequisite, because a Feature cannot create its own mount sources:

```sh
devc-bridge start          # seeds ~/.config/devc-bridge/{run,client}
ls ~/.config/devc-bridge/  # must show run/ and client/
```

- [ ] **Scenario suite.** `bash features/devc-bridge/test/run-features-test.sh`
      — stages a `src/`+`test/` collection copy and runs
      `devcontainer features test`. Asserts: `/run/devc-bridge/token` populated,
      the client mount populated, **both mounts read-only** (a `sudo touch` must
      fail), `devc-bridge` on `PATH` and a symlink to the mounted client.
      The read-only assertions are the two findings the whole design rests on.
- [ ] **A real non-devc project.** A `devcontainer.json` with an `image` and:

      "features": { "./features/devc-bridge": {} }

      (relative to that file's folder). Bring it up, then `devc-bridge ping test`
      → `pong`. This is the point of the plan. `ping` needs the host bridge
      *running*, not merely installed — which is why the scenario suite does not
      assert it.
- [ ] **A host that never installed the bridge.** Same project on a machine with
      no `~/.config/devc-bridge/` fails the create with Docker's
      `bind source path does not exist`. Intended, and now identical for devc and
      non-devc projects — devc no longer pre-creates anything.

---

## 3. Tag a prerelease

**The version guard is strict equality.** To tag `v0.1.0-rc.1`, all three
consts must first read `0.1.0-rc.1`:

- `devc/help.ts`
- `devc-bridge/host/version.ts`
- `devc-bridge/client/version.ts`

and `features/devc-bridge/devcontainer-feature.json`'s `version` must match too
(its own guard, in `publish-feature.yml`).

- [ ] **Negative test first.** Push a tag that disagrees with `VERSION` and
      confirm `gate` fails before anything compiles, naming both values.
- [ ] Bump all four, commit, `git tag v0.1.0-rc.1 && git push --tags`
- [ ] `release.yml` creates a release with all eight assets plus `checksums.txt`
      and `install.sh`, flagged **prerelease** (the `-` in the tag), so
      `releases/latest` still points at the last stable
- [ ] `publish-feature.yml` pushes
      `ghcr.io/bmingles/devc-tools/devc-bridge`, tagged `latest`, `0`, `0.1`,
      `0.1.0`. **`:0` is what devc's docs reference** — there is no `1` tag until
      the repo hits 1.x.
- [ ] Make the package public in the repo's Packages settings, or an anonymous
      `devcontainer up` cannot pull it

---

## 4. Install from the prerelease — macOS

```sh
curl -fsSL https://github.com/bmingles/devc-tools/releases/download/v0.1.0-rc.1/install.sh | sh
```

- [ ] `devc --version` → `devc 0.1.0-rc.1`; `devc-bridge --version` likewise
- [ ] Both land in `~/.local/bin`, **no sudo prompt at any point**
- [ ] The client is the **host-matched Linux** binary in
      `~/.config/devc-bridge/client/` — on an Apple Silicon Mac that is
      `aarch64-unknown-linux-gnu`, not the installer's own darwin triple. The
      easiest thing to get backwards, so check it explicitly:

      file ~/.config/devc-bridge/client/devc-bridge   # ELF ... ARM aarch64

- [ ] **Corrupted checksum aborts with nothing written.** Edit a line in a local
      copy of `checksums.txt`, serve it with `DEVC_RELEASE_BASE=file://...`, and
      confirm no binary is installed and no temp dir survives.
- [ ] **Re-running upgrades in place** rather than duplicating or failing
- [ ] `DEVC_INSTALL_DIR=/tmp/notonpath sh` warns and prints the `export` line
- [ ] `DEVC_TOOLS=bridge` on **Linux** fails with "macOS-only"

---

## 5. devc-bridge on macOS

The headless path is proven on Linux; these are the macOS-only parts.

- [ ] **The case the tray-decouple plan exists for.** From the _installed_
      binary, with no Deno anywhere:

      env -i HOME="$HOME" PATH=/usr/bin:/bin ~/.local/bin/devc-bridge start
      devc-bridge status        # running
      devc-bridge stop

- [ ] Daemon survives closing the terminal that started it (SIGHUP — this is
      what `309cffe` fixed; it is regression-tested, but never against real
      launchd-free macOS)
- [ ] **Real keepawake.** With a container pinging:
      `pmset -g assertions | grep -i caffeinate` shows a live assertion;
      `devc-bridge status` → `active: caffeinate`; it clears after
      `DEVC_BRIDGE_KEEPAWAKE_IDLE_MS` (default 300000) of silence
- [ ] `DEVC_BRIDGE_KEEPAWAKE_IDLE_MS=60000 devc-bridge restart` takes effect —
      inherited through the environment, with **no settings file written**
      anywhere (that mechanism is deleted)
- [ ] Container → host `ping` through the installed client returns `pong`
- [ ] A real Claude session keeps the Mac awake via the hooks in
      `devc-bridge/README.md` § Wiring into Claude Code hooks
- [ ] **Tray, opt-in, from source only:** `deno task dev` shows a menu-bar icon
      that tracks idle ○ / active ●. Never exercised — this container builds a
      `deno desktop` bundle but cannot execute one.

---

## 6. devc, with and without the bridge

The regression that matters most: devc must not depend on any of the above.

- [ ] **A devc container comes up on a host that has never heard of the bridge.**
      No `~/.config/devc-bridge/`, no host bridge installed, no Feature ref
      anywhere. This is what `b513800`/`0d46b51` restored and what the bundled
      default must never break again.
- [ ] **Opting in works.** In `~/.config/devc/devc.json` (all projects) or a
      project's `devc.json`:

      { "additionalFeatures": { "ghcr.io/bmingles/devc-tools/devc-bridge:0": {} } }

      then `devc up` → `devc-bridge ping test` → `pong`, with no
      `Duplicate mount point` error.
- [ ] `devc mounts` shows both bridge mounts as **ro**
- [ ] `devc-bridge stop` works against the pidfile at its new path (moved out of
      `run/`, so a writable token mount can no longer feed it a PID)
