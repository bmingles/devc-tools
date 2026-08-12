# devc-bridge — download the client, and let the consumer own the mount

## Goal

Make the Feature's security independent of **undocumented devcontainer CLI
behavior**. Today both guarantees it offers rest on `readonly` surviving into
`docker run --mount`, which the published Feature schema cannot express and the
CLI honors only as an accident of string passthrough.

| What                        | Today                                | After                                                    |
| --------------------------- | ------------------------------------ | -------------------------------------------------------- |
| Client binary               | read-only bind mount, string form    | **downloaded at image build time** — no mount            |
| Token                       | read-only bind mount, string form    | mount declared by the **consumer's `devcontainer.json`** |
| `devcontainer-feature.json` | two off-schema string mounts         | **no `mounts` key at all**                               |

The Feature ends up doing one thing — install the client — and declaring nothing
the spec does not sanction. The single mount the arrangement still needs moves to
`devcontainer.json`, where the string form and `readonly` are **specified**.

### Why

The Feature declares its mounts as JSON **strings** because
`generateMountCommand` passes a string to Docker verbatim but rebuilds an object
from scratch as `type=,src=,dst=`, dropping every other field. The published
Feature `Mount` schema has `additionalProperties: false` and no `readonly`, so
the supported form *cannot* carry it. The string form works, is off-schema, and
is load-bearing for security — a combination with no good failure mode: a future
CLI that normalizes string mounts would silently make both mounts writable.

Two independent moves remove the dependency rather than defending it:

- The **client** does not have to come from the host at all. It is already a
  published release asset, so the Feature fetches it at build time and owns it as
  a root-owned file in an image layer. The vector `readonly` defended against —
  one container rewriting a binary every other container executes — stops
  existing rather than being blocked.
- The **token** must cross at runtime, so it stays a mount. But nothing requires
  the *Feature* to declare it. In `devcontainer.json` the string form is in the
  schema and `readonly` is real, so the consumer declares it and gets a
  guarantee the spec actually makes.

## Findings — measured, not assumed

Schemas from `devcontainers/spec` @ `main`; CLI source from `devcontainers/cli` @
`main`, read locally. The filesystem findings were run inside this repo's own
devcontainer.

1. **A Feature cannot express `readonly`, in either the schema or the CLI.**
   `devContainerFeature.schema.json` types `mounts` as `items: {$ref: Mount}` —
   objects only — and `Mount` is `additionalProperties: false` over exactly
   `source` / `target` / `type`. The CLI's interface
   (`containerFeaturesConfiguration.ts:102-107`) adds only `external`.
   `generateMountCommand` (`dockerfileUtils.ts:280-294`) returns
   `['--mount', <string>]` untouched for a string, and otherwise emits exactly
   `type=…,src=…,dst=…`. No object form keeps `readonly`.

2. **`devcontainer.json` is different, and says so.** `devContainer.base.schema.json`
   types `mounts` as `anyOf: [Mount, string]` and describes it as *"See Docker's
   documentation for the --mount option for the supported syntax."* The string
   form is not tolerated there, it is specified, and it is specified to be
   Docker's syntax — which is what makes `readonly` a promise rather than an
   accident. This is the whole basis for the plan.

3. **Host file permissions cannot substitute for `readonly`.** Docker Desktop
   shares host paths through `fakeowner` (`/proc/mounts`), which does not enforce
   DAC. Measured on the `rw` bind: an unprivileged `vscode` (uid 1000) overwrote a
   file that was `root:root`, mode `0400` — 6 bytes to 13, content replaced, exit
   0, **no sudo**. `ls -l` reports whatever owner suits the caller. The `ro` flag,
   by contrast, is enforced and stops root:
   `sudo touch /run/devc-bridge/probe` → `Read-only file system`.

4. **A container can plant symlinks in a writable bind mount.** `ln -s /etc/passwd …`
   succeeds and the target is stored verbatim, as is a relative
   `../../../../etc/hostname`; the host resolves those in its **own** namespace.
   Inert when the mount is `ro`, which is why it never mattered before — and why
   it matters for any consumer who omits `readonly` or uses compose.

5. **Compose drops `readonly` regardless of form.** `dockerCompose.ts:525` parses
   the mount and `:738` emits only `source:target`. Compose consumers therefore
   get a writable token mount no matter what they write.

6. **The host is already authoritative in memory.** `core.ts:213` compares
   `req.token !== opts.token`, loaded once at `main.ts:147`, before
   `startServer` opens its listener (`core.ts:171`). A container writing
   `run/token` while the bridge runs authorizes nothing. The single escalation is
   `ensureToken` (`token.ts:13-19`) adopting a non-empty file on the **next**
   start, letting a container pin an attacker-chosen secret across a restart.

7. **Regenerating the token is transparent to running containers.** The client
   re-reads the token file on **every invocation** (`client/devc-bridge.ts:81`),
   and `run/` is mounted as a live directory. Adoption buys nothing that
   regeneration loses.

8. **`run/` holds the token and nothing else** (`config.ts:20`). The pidfile was
   already moved to `base/` (`config.ts:38-44`) because a container-writable PID
   picks which host process `stop` sends SIGTERM to. Nothing else host-side reads
   from `run/`.

9. **Feature-declared mounts collide with consumer-declared ones.**
   `devc/default/devcontainer.json:61-63` records it: declaring the bridge mounts
   there *as well* fails the create with Docker's `Duplicate mount point`. So
   today a consumer who wants to adjust the mount cannot — the Feature owns it and
   any attempt to override is a hard failure. Moving it out removes the footgun.

10. **`${localEnv:HOME}` in Feature mounts is the same substitution pass** as
    `devcontainer.json` (`imageMetadata.ts:310` → `variableSubstitution.ts:97`).
    Undocumented for Features, documented for `devcontainer.json` — and after this
    plan the Feature has no mounts, so the question is moot.

11. **The client is already a release asset.** `release.yml:228` publishes
    `devc-bridge-client-$VERSION-{x86_64,aarch64}-unknown-linux-gnu.tar.gz`, and
    `install.sh:277` already fetches and checksum-verifies exactly that name.

12. **Arch detection inside the container is the easy direction.** `uname -m` in
    the build is the image's own architecture, which is what the client must
    match. Contrast `install.sh:65-93`, where `CLIENT_TRIPLE` must be derived from
    the *host* and is flagged as the easy thing to get backwards.

## Decisions

1. **The client is downloaded in `install.sh`, not mounted.** Feature installs run
   as root at image build time, so the binary lands root-owned `0755` in an image
   layer. No shared host file means no cross-container tamper vector. A
   root-capable container can still overwrite its own copy — as it can any binary
   in its own image — which affects only itself.

2. **The destination path does not change.** Still
   `/usr/local/share/devc-bridge/client/devc-bridge`, symlinked from
   `/usr/local/bin/devc-bridge`. This keeps the developer story free:
   bind-mounting a locally built client dir over that path shadows the downloaded
   copy, live, with `build-client.sh`'s atomic same-dir rename still working.

3. **Downloads are checksum-verified against the release's `checksums.txt`,** by
   the same rule `install.sh` states: nothing is placed outside a temp dir until
   the hash matches, and a mismatch fails the build.

4. **The version defaults to the Feature's own version.** The publish workflow
   already fails when `devcontainer-feature.json`'s `version` disagrees with the
   tag (`publish-feature.yml:41-43`). A `clientVersion` option overrides it.

5. **The Feature declares no mounts. The consumer declares the token mount.**
   This is the core of the plan. In `devcontainer.json` the string form is in the
   schema (finding 2), `readonly` is enforced even against root (finding 3), and
   `${localEnv:HOME}` is documented. The Feature file becomes trivially valid, the
   duplicate-mount footgun (finding 9) disappears, and the consumer can adjust the
   mount without fighting the Feature. Cost: a standalone project copies **one**
   mount line in addition to the Feature line — down from two mounts plus a
   post-create step before the Feature existed, and the line is now
   security-relevant text the consumer should see rather than inherit invisibly.

6. **devc carries the mount in its bundled `devcontainer.json`,** so devc users
   still wire up nothing. It rejoins the three readonly string mounts already
   there (`claude-seed`, `gitconfig-identity`, `shell`) rather than inventing a
   pattern. Drop `consistency=cached` while moving it — `devc/README.md:237`
   already records it as an osxfs-era no-op.

7. **The host regenerates the token on every `start` instead of adopting it.**
   Kept even though `readonly` is back, because it closes the pinning bug that
   exists *today* (finding 6) and because the security must not depend on every
   consumer remembering `readonly` — compose consumers cannot have it at all
   (finding 5). Safe because of finding 7.

8. **Token writes are symlink-safe.** Write a temp file in the **same directory**
   and `rename` over the target: `rename` replaces a symlink instead of following
   it, and is atomic, so a client never reads a half-written token.
   `build-client.sh:44` already uses this pattern. Without it, decision 7 would
   hand a writable-mount consumer an arbitrary host-file overwrite (finding 4) —
   the host would follow a planted symlink and write the fresh token through it.

9. **No token watcher.** An earlier draft had the host restore `run/token`
   whenever it changed. Dropped: with `readonly` it is dead code, and for a
   consumer who omits `readonly` the residual is a self-inflicted denial of
   service, which does not justify a second watch loop and its
   write-triggers-itself hazard. Recorded here so it is not re-proposed.

10. **A forgotten mount fails at runtime, not at build.** The client already says
    it well (`client/devc-bridge.ts:88-90`: *"is the host server running and the
    run dir bind-mounted?"*). Do not add a build-time probe: the mount does not
    exist at build time, so a Feature check could only guess. Document the
    expected failure instead.

11. **The `client/` prerequisite disappears; `run/` remains.** A consumer that
    declares the mount still fails to create on a host that never ran
    `devc-bridge start`, because `--mount type=bind` errors on a missing source.
    That is now the consumer's mount and the consumer's error, and the README
    should say so.

12. **Compose stops being excluded, with a caveat.** Compose consumers get a
    writable token mount (finding 5); decisions 7 and 8 make that survivable. The
    residual — `run/` usable as a dead drop between containers that mount it — is
    accepted and documented, not silently inherited.

## Concept boundaries

- **`$CLIENTVERSION` is not `VERSION`.** Feature options reach `install.sh` as env
  vars named `getSafeId(name)` — uppercased, non-word chars to `_`
  (`containerFeatures.ts:26-29`, v2 branch at `:410-413`). Option `clientVersion`
  arrives as `$CLIENTVERSION`. The repo already has three unrelated `VERSION`
  consts (`devc/version.ts`, `devc-bridge/host/version.ts`,
  `devc-bridge/client/version.ts`) and a `$VERSION` in `install.sh` and both
  workflows.

- **Two different binaries are named `devc-bridge`** — the macOS host CLI and the
  Linux container client. The Feature wants `devc-bridge-client-*`, never
  `devc-bridge-host-*`. `install.sh:207-209` documents why this bites.

- **`ensureToken` changes meaning, so it changes name.** Callers expecting "load
  or create" must not silently become "replace". Rename to `resetToken` so a stale
  call site fails to compile.

- The client **mount** is not gone from the codebase, only from the Feature. It
  remains the dev override (decision 2), so text saying "the client arrives by
  bind mount" needs re-scoping, not deletion.

## Implementation

### `features/devc-bridge/devcontainer-feature.json`

Delete `mounts` entirely. Add:

```json
"options": {
  "clientVersion": {
    "type": "string",
    "default": "",
    "description": "Release version of the Linux client to install. Empty means the version this Feature was published with."
  }
}
```

### `features/devc-bridge/install.sh`

Gains a download step ahead of the existing fenced symlink block, which is
otherwise unchanged. Contract:

- Resolve version: `$CLIENTVERSION` if non-empty, else the Feature's own
  `version`, baked in at authoring time — the script cannot read its own
  `devcontainer-feature.json` at build time. Accept `1.2.3` and `v1.2.3`; asset
  names carry the bare version, URLs carry the `v` (`install.sh:155-164`).
- Resolve arch from `uname -m`: `x86_64|amd64` → `x86_64`, `arm64|aarch64` →
  `aarch64`, anything else a hard failure. Triple is `<arch>-unknown-linux-gnu`.
- Fetch `checksums.txt` and `devc-bridge-client-<bare>-<triple>.tar.gz` from
  `${DEVC_RELEASE_BASE:-https://github.com/bmingles/devc-tools/releases}/download/v<bare>/`.
  Honoring `DEVC_RELEASE_BASE` is what lets tests point at a `file://` fixture,
  as `install.sh:257` does.
- Verify sha256 before anything leaves the temp dir; mismatch aborts the build.
- Unpack to `/usr/local/share/devc-bridge/client/devc-bridge`, `chmod 0755`.
- Then the existing `devc:bridge-client-link` block, unchanged.

The header comment's "Nothing is built or downloaded here" becomes false, as does
its account of where the client comes from.

### `devc/default/devcontainer.json`

Add to `mounts`, replacing the "no devc-bridge mounts here, by design" comment at
`:61-63` with the opposite rationale — it lives here because a Feature cannot
express `readonly`:

```jsonc
// devc-bridge shared-secret token. Read-only: a writable run/ lets a container pin the
// host's token and hands the host a symlink to write through. A Feature cannot declare
// this — its schema has no `readonly` — so it belongs here, next to the other read-only
// binds.
"type=bind,source=${localEnv:HOME}/.config/devc-bridge/run,target=/run/devc-bridge,readonly",
```

### `devc-bridge/host/token.ts`

`ensureToken` → `resetToken(path)`: always generate 32 random bytes, return the
token, no read-existing branch. Mode stays `0644` — the container uid differs and
must still read it, and per finding 3 the mode was never a boundary.

The write is the security-relevant part (decision 8): write to a temp path in
`dirname(path)`, `chmod` it there, `Deno.rename` over `path`, clean up the temp
file on failure. Never `writeTextFile` directly to `path`.

The header comment currently frames the threat model around a read-only mount. It
should say: the file is a delivery channel, the process's in-memory copy is the
authority, and the writer assumes the directory may be container-writable.

### `devc-bridge/host/main.ts`

`ensureToken` call site (`:147`) follows the rename. `clientStatus` (`:342-371`)
no longer describes how containers get a client — it now reports only whether the
**dev override** source is populated. Reword its output and the comment at
`:220-224`, which claims the mount is how every devc container gets one.

### `devc-bridge/host/config.ts`

The pidfile comment (`:38-44`) justifies `base/` partly by "the mount is
read-only". That is now the consumer's choice rather than the Feature's
guarantee, which makes the move load-bearing — say so.

### `devc/default/initialize-command.sh`

Drop the client placeholder block and the `client/` mkdir — nothing mounts that
directory any more. **Keep** the `run/` mkdir: devc's own mount needs it, and it
is what makes devc containers build on a host that never installed the bridge.

### Tests

- `devc/tests/default_config_test.ts` — the assertion at `:363` currently reads
  the Feature's mounts. Retarget it at `devc/default/devcontainer.json`: the
  `run/` bind is present, is a string, and carries `readonly`. That guarantee is
  now *devc's*, and it is exactly the kind of thing that gets "cleaned up" by
  someone normalizing mounts to objects. Add the negative: the Feature file
  declares no `mounts` key at all.
- `devc-bridge/host/tests/` — `resetToken` replaces rather than adopts; **a
  symlinked token path is replaced and the symlink's target is left untouched**
  (the regression test for decision 8).
- `features/devc-bridge/test/` — assert the client is present, root-owned, not
  writable by the remote user, and `devc-bridge version` matches. Drop the
  `readonly` assertion (no longer the Feature's claim). Add a host-side unit test
  of the download against a `file://` `DEVC_RELEASE_BASE` fixture including a
  **checksum-mismatch** case that must abort; `tests/install_test.sh` is the model
  for stubbing `uname` on PATH.

### Docs

- `features/devc-bridge/README.md` — the wiring snippet grows a `mounts` entry and
  must lead with it, since a consumer who copies only the Feature line gets a
  runtime failure. State the failure text so it is searchable. The "What it does"
  table loses the client row; the compose exclusion becomes a caveat (decision
  12); the maintainer note about string mounts is replaced by one explaining why
  the mount is the consumer's and why the Feature must never re-declare it.
- `devc-bridge/README.md` — the architecture diagram shows the client arriving by
  mount; it now arrives with the image. `host/config.ts:46`'s compose/`readonly`
  comment goes.
- `devc/README.md` — the bridge client mount description; the new `run/` mount
  joins the documented list of read-only binds.
- Root `README.md` / `docs/` — check the setup narrative still reads correctly now
  that `devc-bridge start` is not what puts a client where containers can see it.

## Checklist

- [x] `features/devc-bridge/devcontainer-feature.json` — `mounts` removed,
      `clientVersion` option added
- [x] `features/devc-bridge/install.sh` — versioned, arch-matched,
      checksum-verified download ahead of the unchanged symlink block
- [x] `devc/default/devcontainer.json` — readonly `run/` string mount, comment
      inverted
- [x] `devc-bridge/host/token.ts` — `ensureToken` → `resetToken`, always
      regenerate, symlink-safe temp+`rename` write
- [x] `devc-bridge/host/main.ts` — rename call site; `clientStatus` re-scoped
- [x] `devc-bridge/host/config.ts` — pidfile comment's premise updated
- [x] `devc/tests/default_config_test.ts` — inverted: asserts the Feature
      declares **no** `mounts` key
- [x] `devc-bridge/host/tests/` — replace-not-adopt; symlink target untouched
- [x] `features/devc-bridge/test/` — client ownership/version; offline
      checksum-mismatch case
- [x] `features/devc-bridge/README.md`, `devc-bridge/README.md` — re-scoped
- [ ] **BLOCKED** `devc/default/devcontainer.json` — the token mount for devc
      users (decision 6). See "Blocked: who declares devc's token mount" below.
- [ ] BLOCKED `devc/default/initialize-command.sh` — depends on the above
- [ ] BLOCKED `devc/README.md`, root `README.md` — the devc wiring story depends
      on the above
- [ ] `.plans/PLAN.md` — move to Completed, plan doc to `archived/`

## Blocked: who declares devc's token mount

**Decision 6 cannot be implemented as written.** It says devc carries the mount
in its bundled `devcontainer.json` "so devc users still wire up nothing", and
implementation item `initialize-command.sh` says to **keep** the `run/` mkdir
that makes a devc container build on a bridge-less host. That mkdir does not
exist: commit `0d46b51` ("devc: stop creating devc-bridge directories on every
host") deleted it three commits before this plan was written, deliberately —
*"A host that never uses the bridge should not carry directories for it… This
also removes the last devc-only shortcut around the Feature — a devc project and
a non-devc project now have exactly the same prerequisite."*

Adding the mount without the mkdir makes **every devc container fail to create**
on a host that never ran `devc-bridge start` (`--mount type=bind` errors on a
missing source, and `devc/default/devcontainer.json` is copied verbatim into
projects — mounts are not filtered by source existence). Three places encode the
opposite invariant: that commit, the `:61-63` comment in the file itself, and
`devc/tests/default_config_test.ts:335`, whose stated rationale is *"a devc
container must come up on a host that never installed the bridge."*

The devc.json overlay is **not** an escape hatch: `MOUNT_SPEC_RE`
(`devc/overlay.ts:50-68`) rejects `readonly` for the same CLI re-serialization
reason that rules out Feature mounts. A read-only mount can only live in a
`devcontainer.json` `mounts` array.

So it is one of these, and it is a product call:

- **(A) devc baseline carries the mount, and `initialize-command.sh` re-creates
  `~/.config/devc-bridge/run`.** devc keeps zero-config for the bridge. Reverses
  `0d46b51`'s stated goal and re-creates a directory on hosts that never use the
  bridge. Also requires relaxing `default_config_test.ts:335`.
- **(B) devc does not carry it; every project declares the mount itself.**
  Honors `0d46b51` and leaves both tests untouched — but devc **zero-config**
  users have no `devcontainer.json` to put it in (devc materializes one into a
  cache), so this may not be workable for them without a new mechanism.

(A) looks right on those grounds, but reversing a deliberate three-commit-old
decision is the user's call, not the implementer's.

## Validation

- [ ] `deno task check` / `test` / `fmt --check` clean across `devc/` and
      `devc-bridge/host/`
- [ ] `devcontainer-feature.json` validates against the **published Feature
      schema** with no warnings, and `devc/default/devcontainer.json` against the
      base schema — the point of the exercise, so assert it rather than eyeball it
- [ ] Feature `install.sh` harness passes offline against a `file://` fixture:
      right asset per stubbed `uname -m`, checksum mismatch aborts with nothing
      installed, symlink resolves
- [ ] (user, needs Docker) `devcontainer features test` passes: client present,
      executable, correct version
- [ ] (user, needs Docker) a **non-devc** project with the Feature line **and**
      the mount line: `devc-bridge ping test` → `pong`
- [ ] (user, needs Docker) the same project **without** the mount line: creation
      succeeds, and `devc-bridge ping` fails with the client's bind-mount message.
      This is the ergonomic cost of the plan, so confirm it reads well
- [ ] (user, needs Docker) a devc project: works with no wiring, and
      `touch /run/devc-bridge/x` fails with `Read-only file system` — devc's
      `readonly` is real
- [ ] (user, needs Docker) restart the host bridge after a container has written
      the token file — the new token is **not** the container's value
- [ ] (user) with a deliberately **writable** token mount, replace
      `run/token` with a symlink to a throwaway host file and restart the bridge:
      the host file is unchanged and the token path is a regular file again. The
      regression test for decision 8; use a throwaway file, not `authorized_keys`
- [ ] (user, needs Docker) a **compose** devcontainer works end to end
- [ ] (user) dev override still works: `deno task build:client`, bind-mount the
      client dir over `/usr/local/share/devc-bridge/client`, confirm the local
      build shadows the downloaded one and survives a rebuild

## Relevant Files

- `features/devc-bridge/devcontainer-feature.json`, `install.sh`, `README.md`,
  `test/`
- `devc-bridge/host/token.ts`, `main.ts`, `config.ts`, `core.ts` (read only —
  the authoritative-token comparison at `:213` is what the plan relies on),
  `tests/`
- `devc-bridge/client/build-client.sh` — unchanged, but its "the typical user gets
  the same binary in the same place from the release installer" comment is now
  only true of the dev path
- `devc/default/devcontainer.json`, `devc/default/initialize-command.sh`,
  `devc/tests/default_config_test.ts`
- `install.sh`, `.github/workflows/release.yml`,
  `.github/workflows/publish-feature.yml` — read for the asset contract; not
  modified

## Follow-on (not this plan)

- **Drop `client` from the installer's default `DEVC_TOOLS`.** Once the Feature
  downloads its own client, `~/.config/devc-bridge/client` is only the dev
  override. Left out to keep the blast radius on one mechanism: changing installer
  defaults affects existing installs and deserves its own release note.
- **Pin the client by digest rather than version.** The checksum check trusts the
  release's own `checksums.txt` over TLS, as `install.sh` already does. A baked-in
  digest would be stronger, at the cost of a second thing moving in lockstep with
  the tag.
- **A `devc-bridge doctor` / status hint for the missing-mount case.** Decision 10
  accepts a runtime failure; if it proves confusing in practice, the host's
  `status` output is the place to explain it, not a build-time probe.
