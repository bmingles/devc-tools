# Plan Status

> Reading archived plans: they are history, not current behavior. In particular,
> plans named `devc-tui-*` describe the predecessor tool in `devc-tui/`, which
> became `devc/` — its config dir is `~/.config/devc/`, it no longer mirrors
> selections into a `.code-workspace`, and the sidebar/step wizard those plans
> built has been replaced (see `.plans/design/wizard/` for the current screens).
> Current behavior lives in `.plans/design/devc-design.md` and `devc/README.md`.

## Status

### Pending

Splitting pieces of devc's baseline out as publishable devcontainer Features.
Read [design/devc-feature-split.md](design/devc-feature-split.md) first — it
settles, once, which pieces **can** be a Feature (a Feature can declare no
`initializeCommand`, no read-only mount, and no string mount) and the rules all
five plans inherit.

All three Features still pending have a host-coupled half that the Feature
cannot declare. That does **not** make them devc-only: a host bind mount and an
`initializeCommand` belong to the **consumer's `devcontainer.json`**, which every
devcontainer project has. devc is one consumer — it writes those lines for you.
The shipped `devc-bridge` Feature already works exactly this way (it declares no
mounts; non-devc projects copy one line from its README). Hence the rule every
plan inherits and proves with a scenario: **`"<feature>": {}` must install
cleanly and do something useful**, and no option may default to a devc path.

The other big rule: **copy, don't move.** Every plan below leaves
`devc/default/` running exactly as it does today; swapping devc onto the
published Features is a later plan, deliberately not written yet, because a
baseline that references an unpublished `ghcr.io` ref breaks every `devc up` —
the failure [devc-bridge-feature](archived/devc-bridge-feature.md) already had to
reverse once.

The machinery they land on is already generalized —
[features-collection](archived/features-collection.md) made `features/` a real
collection, so each of the three below only adds a directory: no edit to
`publish-feature.yml`, and `features/README.md` gains a row. Order among the
three does not matter — [feature-node-nvmrc](archived/feature-node-nvmrc.md) went
first and is done. **But
[feature-independent-versions](feature-independent-versions.md) should land
before all three**, so a new Feature joins at its own `0.1.0` rather than at the
repo's version and then needing a correction. Its manifest contract in each of
the three has already been updated to say so.

- [feature-independent-versions](feature-independent-versions.md) — **Reverses a
  stated decision**, `design/devc-feature-split.md`'s "One repo, one tag": every
  Feature currently republishes at the repo's version on every `v*` tag. The
  decision that was borrowed from ([release-and-installer](archived/release-and-installer.md)
  decision 8) is about the **installer** resolving one version across the eight
  tarballs it fetches, and it never mentions Features — nothing in the repo
  needs the coupling, since `devc` detects devc-bridge by Feature name at any tag
  (`default_config_test.ts:857-860` pins bare, `:0`, `:1` and `:0.1.0` all
  matching). What it costs is churn (a byte-identical `node-nvmrc` gets a new
  digest because devc's tmux handling changed), misleading semver (`:0.1` freezes
  forever when devc goes 0.2.0, so anyone pinned to it silently stops getting
  fixes), and a one-line Feature fix needing a full four-runner binary release.
  Each Feature gets its own `version`, and publishing moves to a push on `main`
  under `features/` — measured safe: `@devcontainers/cli@0.88.0` skips a version
  already in the registry and only advances the floating tags when the new
  version is the max satisfying one, so a run that changes nothing publishes
  nothing. **Nothing is published yet, so there is no migration** — both Features
  keep `0.1.0` and stop moving in lockstep from here. The 40-line inline version
  guard leaves YAML for `tests/features_test.sh`, which takes most of
  `tests/workflow_guards_test.sh` with it: the `awk` that scrapes the guard's
  `run:` block out of the workflow by indentation, and the checks asserting the
  extracted bash iterates a glob and names no Feature, exist only because the
  guard was not callable. `guards_both` stays — whether a publish step is gated
  on both the ref and `!inputs.dry_run` can only be read off the YAML, and it
  guards the one mistake here that cannot be walked back. One guard is **added**,
  covering a hazard the tag trigger was accidentally handling: `devc-bridge`'s
  `FEATURE_VERSION` becomes `DEVC_TOOLS_RELEASE` (it names a release to download
  from, not a Feature version — the two were only ever equal because the rule
  forced it), and publishing checks that release exists. That guard is **why the
  workflow publishes one Feature per matrix job** rather than the collection in
  one command: `features publish ./features` is all-or-nothing, so devc-bridge's
  unmet pin would block `node-nvmrc` — which downloads nothing and pins nothing —
  until a devc release was tagged, reintroducing in CI the exact coupling this
  plan removes. Measured to make that possible: `features publish` accepts a
  single Feature directory and lands on the identical `ghcr.io/<ns>/<id>` ref.
  The cost is recorded, not hidden — every run also pushes a
  `devcontainer-collection.json` describing only what that run packaged, which
  nothing here reads. Explicitly **not** adopted from
  `devcontainers/feature-starter`: `generate-docs` and its documentation PR.
- [feature-shell-dirs](feature-shell-dirs.md) — the sourcing **mechanism** for
  `*.sh` directories becomes the Feature. A bare `{}` gives the **project layer**
  (the repo's own `.devcontainer/shell/`), which is the layer most consumers
  want. A second layer of _personal host_ scripts needs a read-only bind the
  Feature cannot declare, so the consumer declares it and passes `userDir` —
  devc writes those lines for its own containers, and the README gives everyone
  else the same two lines pointing at a path of their choosing.
  The Feature's copy keeps the `devc:shell-dirs` markers and the two
  `*_SHELL_DIR` assignment names so `devc/tests/shell_dirs_test.sh` runs against
  it **unmodified** — that is what stops the two copies drifting. Carries a real
  ordering finding: Features install after the Dockerfile, so a Feature's
  `~/.bashrc` block lands _after_ devc's `DEVC_ATTACH` `PROMPT_COMMAND` snapshot,
  which the swap plan has to deal with.
- [feature-git-config](feature-git-config.md) — LFS filters,
  `worktree.useRelativePaths` and `safe.directory` are pure container scope and
  become the Feature — three of the four settings, working from a bare `{}`. The
  fourth, your **identity**, is the one thing here a container genuinely cannot
  invent: `user.name`/`user.email` live on the host. A Feature can neither read
  nor mount them, but a consumer's `initializeCommand` + read-only bind can, so
  the README ships that recipe with the devc paths taken out. The seam is a dumb
  `identityIncludePath` option the Feature never parses.
- [feature-claude-config](feature-claude-config.md) — the largest split, and the
  only plan with a question that **must be measured before it can be finished**:
  whether `${localWorkspaceFolderBasename}` substitutes inside Feature `mounts`.
  If it does, the two per-workspace volumes move into the Feature; if it does
  not, declaring them would give every project **one shared** Claude auth/history
  volume — worse than declaring nothing. `${localEnv:HOME}` is measured working,
  but that is a different variable class, so the plan says measure it rather than
  reason about it. The `devc:seed-link` block is copied verbatim so
  `devc/tests/seed_link_test.sh` runs against the Feature unchanged.

### Completed

- [feature-node-nvmrc](archived/feature-node-nvmrc.md) — Publish
  `ghcr.io/bmingles/devc-tools/node-nvmrc`: the Node version a workspace pins in
  `.nvmrc`, installed at create time and selected in every interactive shell,
  including on `cd`. The first of the four splits and the only one with **no host
  coupling at all** — it reads the workspace, writes the container, declares no
  mounts — so a bare `{}` is the whole Feature rather than half of it. Copied out of
  `devc/default/scripts/node-setup.sh` and the nvm lines in `bashrc-additions.sh`;
  **both devc copies are untouched and still running**, per the copy-don't-move rule.
  The generalizations that mattered were the ones about not owning the image:
  hardcoded `vscode` becomes `id -u`/`id -g` (whoever the hook runs as), `sudo`
  becomes `command -v sudo` plus `sudo -n` so an image whose sudo wants a password
  fails instantly instead of hanging create on a prompt nobody can answer, and every
  failure mode is graded — **no `.nvmrc` is silent success** (the Feature has to be
  safe to leave enabled in a repo that pins nothing, or the one-line opt-in is
  worthless), **missing nvm warns and exits 0** (failing create over a documented
  prerequisite turns a one-line misconfiguration into a container you cannot open to
  fix it), and **`nvm install` failing is fatal** (a container quietly on the wrong
  Node is worse than one that fails while you are watching). `installsAfter`, not
  `dependsOn`: `dependsOn` would install the upstream node Feature with _this_
  Feature choosing its `version`/`pnpmVersion`/`nvmVersion`, which are exactly what a
  consumer wants to choose, so the prerequisite is documented and only the ordering
  is declared. The manifest's `postCreateCommand` takes no arguments, so `install.sh`
  bakes the four options into the copies it places by rewriting their
  `VAR="${VAR:-default}"` lines and **failing the build if a rewrite does not take** —
  a rename upstream would otherwise leave an option silently unwired with the default
  standing in for whatever the consumer asked for.
  **Three deviations from devc's copy, not two.** The plan specifies two, both
  implemented: the `cd()` override is conditional on nvm having actually loaded (devc
  redefines `cd` unconditionally, which in an image with no nvm leaves every directory
  change calling a missing command), and the block cannot leave a non-zero `$?` at the
  first prompt. The third is the plan being wrong: it copies devc's `cd` one-liner
  verbatim, and that one-liner returns **1 from every `cd` into a directory without a
  `.nvmrc`**, so `cd somewhere && make` silently stops before `make`. That is the same
  wart as the `$?` one the plan does fix, for the same reason (devc's PS1 only colors
  the status), so `cd` now preserves the builtin's status on failure and returns 0 on
  success. Recorded and pinned by tests rather than done quietly.
  Verified here: the offline `nvm_use_test.sh` (31 checks over the `devc:nvm-use`
  block **extracted from the real `install.sh`**, so the test cannot drift from what
  lands in `~/.bashrc`), `tests/workflow_guards_test.sh` (10 checks, now covering the
  new Feature's id/version), `deno fmt --check` (121 files), and — beyond the plan —
  `install.sh` and the installed `post-create.sh` run offline with `SHARE_DIR` and
  `_REMOTE_USER_HOME` in temp dirs, covering all four options, append idempotency and
  all four create-time paths, plus the appended block sourced against the **real** nvm
  in this devcontainer.
  **Not verified here (no Docker):** every `devcontainer features test` scenario. All
  three are written — the autogenerated default is `{}` on a base image with no nvm
  (which is both the hostile case and the design doc's bare-`{}` case), and
  `test/scenarios.json` adds `with_nvmrc` (pinning `20` while the node Feature installs
  `lts`, so "the pinned version won" is observable) and `no_nvmrc` — but none has been
  run. **The plan's one must-measure item is still unmeasured:** the cwd of a
  Feature-declared `postCreateCommand`. What is recorded in
  [design/devc-feature-split.md](design/devc-feature-split.md) open question 1 is a
  **source read**, not a measurement — the CLI computes
  `remoteCwd = remoteWorkspaceFolder || homeFolder` once and passes it to every
  lifecycle hook, Feature-contributed ones included — so `${PROJECT_PATH:-$PWD}` stays
  and the `with_nvmrc` scenario is what will actually settle it, since its first check
  fails if the hook did not find a `.nvmrc` written at the workspace root.
  One change outside this Feature: `test/run-features-test.sh` now stages the whole
  `test/` directory minus itself instead of only `test.sh`, or a `scenarios.json`
  would never reach the command; `devc-bridge`'s copy was updated identically, because
  that file is meant to be byte-identical in every Feature, and `features/README.md`
  documents both the widened staging and the scenario conventions.
- [features-collection](archived/features-collection.md) — Make `features/` a
  real collection before four more Features arrive, rather than a directory that
  happens to contain one. `features publish ./features` already walked the whole
  tree while the version guard read `features/devc-bridge/` literally, so the
  second Feature would have published **unguarded** — the kind of failure nobody
  sees until they pull a Feature whose version disagrees with the tag it shipped
  under. The guard is now one loop over `features/*/devcontainer-feature.json`
  that checks three things per Feature — `id` equals the directory basename
  (`features package` names the artifact from it, and a mismatch otherwise
  surfaces as a baffling packaging error), `version` equals the tag minus its
  `v`, and the baked `FEATURE_VERSION` **only where one exists**, since only
  `devc-bridge` names a release asset to download and a Feature that fetches
  nothing must not be made to invent a version. It reports every offender with
  its directory before exiting, because "which of the five?" is the only question
  a failed release run has to answer, and it **fails on an empty glob**: a guard
  that finds nothing to check must not pass, which is the exact failure mode the
  plan existed to prevent. What deliberately did **not** change is what fires it:
  `on:` is untouched, publishing stays tag-triggered with `dry_run` defaulting
  true, and the version guard stays gated on the ref alone — a dry run against a
  tag should still check. Widening the guard's coverage was the work; widening
  its trigger was not. The staging wrapper for `devcontainer features test` now
  copies the whole Feature directory minus `test/` instead of a per-Feature file
  list, so a Feature shipping `scripts/*.sh` cannot stage an incomplete copy that
  fails deep inside a container build; it is byte-identical between Features and
  meant to be copied unchanged. New `features/README.md` carries the collection
  layout, the one-repo-one-version rule, the published-refs table and the
  no-shared-code / no-host-mounts constraints; the root README's Releasing
  section and `docs/manual-verification.md` §3 stop saying "all four" versions
  and say "every Feature under `features/`". `tests/workflow_guards_test.sh`
  gained two offline sections: the guard's `run:` block must name **no** Feature
  id literally and must iterate the collection glob, and every Feature's `id`
  must match its directory with all versions equal — the one-repo-one-version
  rule, checkable without a tag and the thing most likely to rot between
  releases. Nothing about the published `devc-bridge` artifact changes.
  **Not verified here (no Docker):** `bash features/devc-bridge/test/run-features-test.sh`
  against the widened staging copy, left unchecked in the archived plan — what
  was checked is the staged tree itself, via a stub CLI. Everything else was run:
  the harness (10 checks, plus both new sections confirmed to fail when the guard
  is hardcoded or a Feature's version drifts), and the guard's `run:` block
  extracted through a real YAML parse and executed against this tree (passes on
  `v0.1.0`, fails naming `features/devc-bridge` on `v9.9.9`) and against
  synthetic collections covering the empty glob, two Features with and without
  `FEATURE_VERSION`, and all three per-Feature failures at once.
- [devc-bridge-client-download](archived/devc-bridge-client-download.md) — Stop
  resting the devc-bridge Feature's security on `readonly` surviving into
  `docker run --mount`, which the published Feature schema cannot express and the
  CLI honors only as an accident of string passthrough (`generateMountCommand`
  passes a string verbatim but rebuilds an object as `type=,src=,dst=`). Verified
  both ways: the old manifest is **invalid** against the published schema, the new
  one validates. The client mount goes away entirely — the binary is already a
  release asset, so the Feature downloads and checksum-verifies it at build time
  and owns it root-owned in an image layer, which _ends_ the cross-container
  tamper vector instead of blocking it, and drops the host-bridge prerequisite for
  the `devcontainer features test`. The token stays a mount, but not the
  Feature's: `devcontainer.json`'s schema takes `anyOf: [Mount, string]` and defers
  to Docker's `--mount` syntax, so `readonly` is specified there rather than
  accidental — and the Feature now declares **no mounts at all**, retiring the last
  unspecified thing it leaned on (`${localEnv:HOME}` inside a Feature mount).
  **Who declares that mount for devc was the plan's one real error** and stopped
  implementation for a call: the plan assumed an `initialize-command.sh` mkdir that
  `0d46b51` had deliberately deleted, so putting the mount in devc's bundled
  default would have failed _every_ devc create on a bridge-less host. Resolved a
  third way — devc injects it into the config it **materializes**, in zero-config
  mode only, and only when a devc.json opts into the Feature; the bundled default
  and `initialize-command.sh` stay untouched, so `0d46b51` stands and
  `default_config_test.ts:336` passes unchanged. Project-mode users declare the
  mount themselves, like any non-devc project — the one documented asymmetry. The
  devc.json overlay could never carry it (`MOUNT_SPEC_RE` rejects `readonly` for
  the same re-serialization reason), which is what makes injection the only route
  rather than the tidiest. Host-side, `ensureToken` → `resetToken` regenerates
  instead of adopting, closing the token-pinning escalation; since that makes the
  host a _writer_ into a possibly-writable directory and a container can plant a
  symlink there (measured), every token write goes through a same-dir temp +
  `rename`. Host permissions are **not** an alternative: Docker Desktop shares
  through `fakeowner`, where an unprivileged container user overwrites a
  `root:root 0400` file, while the `ro` flag stops even root. Lifts the Docker
  Compose exclusion to a caveat.
  **Not verified here (no Docker, no macOS host):** `devcontainer features test`,
  both devc modes end to end, the compose devcontainer, the live symlink check and
  the dev-override shadowing — all left unchecked in the plan.
- [release-and-installer](archived/release-and-installer.md) — Publish prebuilt
  binaries from a tagged GitHub release and install them with one `curl | sh`, so
  nobody needs Deno to _use_ these tools. Covers `devc` (4 targets), the
  devc-bridge host CLI (macOS) and the Linux container client — the destination
  [devc-bridge-client-mount](archived/devc-bridge-client-mount.md) already fixed.
  Eight plain-binary archives named by Deno's own target triples (one vocabulary
  between the workflow and the installer, not two mappings to keep in step),
  built natively on a runner of each architecture, verified against a
  `checksums.txt`, and installed without `sudo` into `~/.local/bin`. The Linux
  client is arch-matched to the **host**, not the installer's own platform — the
  one selection here that is easy to get backwards, so it is what the installer
  tests lead with. Both `devc-bridge` binaries gained a `VERSION` and
  `version`/`--version`/`-V`, which is what makes each build job's smoke test an
  assertion rather than a formality; the version guard requires all three
  `VERSION` consts to agree and, on a tag, to equal it — **strict equality, so a
  `v0.1.0-rc.1` tag needs `VERSION` to read `0.1.0-rc.1`**, documented in the
  root README's new Releasing section. `install.sh` ships as a release asset with
  the tag stamped in, not from `main`, so the `latest/download` URL always serves
  the script that release was tested with.
  **The release workflow has never been run against a real tag — or at all.**
  There is no Actions access, no macOS host and no Docker here, so what was
  verified is the workflow's own `run:` steps, extracted from the parsed YAML and
  executed against the real tree: the version guard (passing on `v0.1.0`, failing
  on `v9.9.9`, and synthesizing a version on a branch ref for `dry_run`), the
  smoke test, the archive step, and the publish job's collect/checksums and
  install.sh stamping. All four targets were cross-built locally through the new
  `build:release` tasks, yielding exactly the eight expected archives with the
  right architecture in each (ELF `e_machine`, Mach-O `cputype`) and mode 0755
  surviving tar; `sha256sum -c` passed on the generated `checksums.txt`, and a
  missing or extra asset each fails the collect step. Then the **stamped**
  `install.sh` was run end to end against those archives over `file://` and
  installed working binaries. A new `tests/install_test.sh` (34 cases, offline,
  `uname` stubbed on PATH so the real detection code runs) pins the triple→asset
  mapping for all four platforms, the four failure paths, all three
  version-resolution sources, the `DEVC_TOOLS` knobs, the PATH warning and
  upgrade-in-place; it also greps the workflow's spelled-out asset list, so the
  installer and the workflow cannot drift apart on a name silently. Left for a
  human, in the order that answers the most: a `workflow_dispatch` **dry run**
  (the only thing that can tell us whether `ubuntu-24.04-arm` is available to
  this repo, and the first time the macOS signing and the `macos-14` arm64 smoke
  test run at all), then a prerelease tag, then installing it on a Mac to confirm
  `devc-bridge start` from the installed binary with no `deno` on PATH and a
  container `ping` through the host-matched client.

- [devc-bridge-tray-decouple](archived/devc-bridge-tray-decouple.md) — Make
  `devc-bridge start` run the bridge as a plain detached background process: no
  `.app`, no `deno desktop`, no LaunchServices, with the menu-bar tray demoted to
  an opt-in extra behind `run --tray`. This is what makes the host binary
  shippable — a compiled binary's `start` used to shell out to
  `deno desktop … main.ts` with a cwd derived from `Deno.mainModule`, which in a
  compiled binary is a virtual `/tmp/deno-compile-*` path, and it needed a `deno`
  on PATH that a released binary must not assume. `start` now relaunches _the
  program it was invoked as_ with the `run` subcommand, detached; one helper
  returns that argv for both modes, keyed off `Deno.build.standalone` — **not** a
  path probe, because a compiled binary can stat its own virtual `main.ts` even
  though nothing it spawns can reach it. Nothing of substance is lost: `core.ts`
  owns the server, dispatch and keepawake, and `tray.ts` already degraded
  headless when `Deno.Tray` is absent. `serve.ts` is deleted — bare `run` is what
  it was — and its opt-in keepawake resolves toward `Config`, which always
  configures it. The settings file goes too: it existed only because `open -g`
  started the tray under launchd without the shell's environment, and a detached
  child inherits that environment directly.
  Verified here, all on Linux with no GUI, which is itself the result: the
  compiled binary's `start`/`status`/`restart`/`stop` on a PATH with **no
  `deno`** (the case that blocked shipping), a `ping` from the client arming and
  expiring a stub keepalive with `status` reporting `active: caffeinate`,
  `DEVC_BRIDGE_KEEPAWAKE_IDLE_MS` taking effect through the inherited environment
  with no `settings.json` written, `run --tray` coming up (headless, as it must
  without `Deno.Tray`), and a new 10-test host suite covering the relaunch argv
  in both modes plus `start`'s detach-and-wait contract. **One real bug was found
  by validating rather than assuming:** `nohup`'s SIG_IGN does not survive Deno's
  own signal setup, so the daemon died when the terminal that started it closed —
  fixed with an explicit SIGHUP listener and pinned by a test. Left for a human,
  all macOS-only: the real `caffeinate(8)`/`pmset` assertions, a container→host
  `ping`, and whether a menu-bar icon actually appears under `deno task dev`
  (this container's `deno desktop` never executes the bundle it builds). Also
  updated [release-and-installer](archived/release-and-installer.md) in the same change,
  as planned: its first checklist item and both `.app` assets are gone (ten
  archives → eight) and its decisions 5 and 6 are marked withdrawn.

- [devc-bridge-feature](archived/devc-bridge-feature.md) — Repackage the container half
  of devc-bridge as a published devcontainer Feature, so any project (devc or
  not) opts in with one line, and devc's bundled config consumes the same
  Feature instead of carrying its own mounts — one mechanism, not two. Two
  assumptions were tested rather than assumed, with a throwaway Feature under
  `test/`: `${localEnv:HOME}` **is** substituted in Feature mounts, and a mount
  written as a **string** is passed through verbatim so `readonly` survives
  (`RW=false`), while the object form is re-serialized and drops it. The string
  form is unspecified by the published schema, so the probe is kept as a
  regression harness. Features cannot declare `initializeCommand`, so the
  Feature cannot create its own mount sources: standalone users must install the
  host bridge first (documented), while devc keeps its own host-side hook and
  stays inert-when-absent. Docker Compose is out of scope — the string form
  emits the wrong syntax there — which is why the pidfile also moves out of
  `run/`, making a writable token mount harmless rather than a way to feed
  `devc-bridge stop` an arbitrary PID.
  Merged. Verified here: `deno task check`/`test` (269/269) and repo-wide
  `deno fmt --check` clean, the Feature's `install.sh` symlink harness (moved
  from devc's tests and retargeted) passing all five cases, devc's other four
  shell harnesses unchanged, and a new unit test pinning the two mounts to the
  **string** form with `readonly`. Left for a human, all needing Docker or a
  real host: the `devcontainer features test` scenario (written, not run), a
  standalone non-devc project reaching `pong`, a devc project with no
  duplicate-mount error, the two failed `touch`es, the never-installed-bridge
  difference between the devc and standalone paths, live client healing, and
  `stop` against the moved pidfile. **The Feature must be published before
  devc's bundled config is used**, this repo's own container included: that
  config is materialized into a cache dir, so it can only reference a published
  ref. Deviations recorded in the archived plan: `:0` rather than `:1` (a 0.1.0
  publish has no `1` tag), and a staging wrapper for `devcontainer features
  test`, which insists on a `src/`+`test/` collection layout that
  `features publish` does not.
  **Partly superseded — two of this plan's decisions were reversed after it
  landed** (`b513800`, `0d46b51`), so read the paragraphs above as history:
  1. **devc's bundled config does _not_ consume the Feature.** Putting a Feature
     ref in the bundled default made every `devc up` anywhere depend on that ref
     resolving — so an unpublished (or renamed, or yanked) Feature breaks devc
     for everyone, and it broke it immediately, since nothing was published.
     devc-bridge is now opt-in via `additionalFeatures` in a user-level
     `~/.config/devc/devc.json` or a project-level `devc.json`, which the
     overlay already supported. `devc/tests/default_config_test.ts` asserts the
     **absence** of the Feature from the default; the test covering the
     Feature's own readonly string mounts is unchanged.
  2. **devc no longer pre-creates the mount sources.** The
     `devc:bridge-placeholder` fence in `initialize-command.sh` (and
     `devc/tests/initialize_command_test.sh` with it) is deleted: a host that
     never uses the bridge should not carry directories for it, and the host
     bridge seeds `~/.config/devc-bridge/` itself on `start`
     (`devc-bridge/host/config.ts`). So the "devc stays inert / standalone
     fails" asymmetry above is gone — installing the host bridge first is now
     the same prerequisite for everyone, which is what "one mechanism" should
     have meant in the first place.

     Unchanged by this: the Feature itself, its mounts, and the requirement to
     publish it before any `ghcr.io/...` ref resolves. Pre-publish testing goes
     through a project whose own `.devcontainer/devcontainer.json` references
     `./features/devc-bridge` — a relative local path resolves against that
     file's folder, and needs no overlay and no registry.

- [devc-bridge-client-mount](archived/devc-bridge-client-mount.md) — Ship the devc-bridge
  container client by **read-only bind mount** from devc's bundled
  `devcontainer.json`, so every devc container gets it with no per-project
  wiring — the current `.devc/devc-post-create.sh` builds from source that only
  exists in this repo, so it cannot be the distribution mechanism. The mounts
  must live in `devcontainer.json` rather than a `devc.json` overlay because
  only verbatim string mounts there can carry `readonly`. Mounts the client's
  _directory_ (a file mount pins the inode, so a rebuilt client would go stale)
  into devc's namespace, plus an unconditional PATH symlink that heals the
  moment the host builds the client — shell-init healing does not work, since
  devc's `~/.bashrc` additions sit after Ubuntu's non-interactive guard and
  `devc claude` runs `bash -lc`. A host-side placeholder keeps the dangling link
  self-explanatory. Nothing is built on the fly: the mount source is a
  destination that the release installer (typical user) or `deno task build:client`
  (dev) writes to, so `start` needs no embedded source, arch derivation or
  build-failure handling. Also hardens the existing `run/` mount to `readonly`,
  which closes a live issue: it is writable today, and `stop` `Deno.kill`s
  whatever PID a container can write into `run/tray.pid`. **Requires migration**
  — this repo's overlay mounts the same target (Docker fails on duplicate mount
  points) and its `.devc/devc-post-create.sh` is deleted, leaving devc-tools
  consuming the bridge like any other project.
  Merged and in use; its remaining end-to-end checks were deliberately not run
  standalone, because [devc-bridge-feature](archived/devc-bridge-feature.md) replaces
  this mechanism and re-tests the same behaviors more thoroughly.

- [devc-project-post-create-hook](archived/devc-project-post-create-hook.md) —
  Restore the project create-time hook as `devc-post-create.sh`, found at
  `.devc/` then `.devcontainer/` (first-hit-wins, the overlay's own order) and
  run last by `post-create.sh` via a new `scripts/project-hook.sh` step.
  `devc-container-feature` dropped the old hook because the top-level
  `postCreateCommand` was then free; `devc-drop-feature` gave that slot back to
  devc's own baseline and its `post-create.user.sh` replacement never shipped,
  leaving **zero-config projects with no create-time extension point at all** —
  the overlay cannot express a command, since only three keys have a
  `devcontainer up` flag and adding one would mean rewriting the project's
  `devcontainer.json`. A script the baseline _calls_ composes additively by
  construction, so the "does this override `devcontainer.json`?" question never
  arises. Deliberate change from the old behavior: **existence selects,
  executability is enforced** — a present-but-non-executable hook (or a dangling
  symlink) fails the create naming the path instead of being silently skipped,
  and never falls through to the other location. The fence the shell test
  extracts encloses the whole body including `set -e` and the `cd`; putting them
  outside it let the block pass without them, which the tests caught. Verified
  end-to-end without a rebuild: the step discovered this repo's own hook, built
  and installed the `devc-bridge` client, and `devc-bridge ping test` returned
  `pong` on the client's built-in defaults — which also confirms the `containerEnv`
  key deleted from `.devc/devc.json` was pure redundancy (the overlay never
  supported it; it warned and dropped it). Then confirmed on a **real rebuild**:
  the client is installed by `postCreateCommand` → `post-create.sh` →
  `project-hook.sh` → `.devc/devc-post-create.sh` (its mtime falls after PID 1's
  start, so it is the hook's work, not the earlier direct run), `ping` returns
  `pong`, and the project still has no `.devcontainer/` — zero-config extension
  works end to end. One pre-existing unrelated test failure
  (`jsonc_edit_test.ts:111`) is unchanged.

- [devc-mounts-to-overlay](archived/devc-mounts-to-overlay.md) — The wizard's
  two managed mount fences (`devc:source`, `devc:skills`) now live in the
  project's `devc.json` overlay instead of the tracked `devcontainer.json`.
  `devc config` writes an existing overlay in place, else creates
  `.devcontainer/devc.jsonc` (or `.devc/devc.jsonc` when the project has no
  `.devcontainer/`) — and no longer writes or scaffolds `.devcontainer/` at all,
  so the standalone invariant is structural rather than conventional. Mount
  specs are re-serialized to the exact form `devcontainer up --mount` accepts
  and validated against the CLI's own regex at load, which drops `readonly` and
  `consistency`: neither is expressible, and every workaround costs `SYS_ADMIN`
  (Docker's default seccomp profile fixes the `mount` allowance at create time,
  so even `docker exec --privileged` cannot restore it) — the archived plan
  records the full investigation. Verified live: `devcontainer up` accepted the
  emitted spec, `devc mounts` listed it `rw`, and a hand-written `readonly`
  overlay mount fails the command naming the file, index and field. No
  migration by design — **the old fences in this repo's
  `.devcontainer/devcontainer.json` still need deleting by hand** (until then
  `~/code/thirdparty/agent-tools` is mounted twice, at two different targets).
  Two pre-existing test failures (`default_config_test.ts:654`,
  `jsonc_edit_test.ts:111`) are unrelated and unchanged.

- [devc-attach-exit-code](archived/devc-attach-exit-code.md) — Stop crashing
  on detach: `attachToContainer` now resolves to the attached shell/command's
  own `docker exec` exit code (e.g. 130, an ordinary signal-driven shell exit)
  instead of throwing on any non-zero code, mirroring `execInContainer`'s
  existing contract; `main.ts`'s `attach()` wraps the call in try/catch,
  exiting with that code on success or printing `devc: …` + exit 125 on a
  real infra failure, matching `exec`'s pattern exactly. `devc/README.md`'s
  `attach`/`claude` bullet documents the same contract the `exec` bullet
  already did. `deno check`/`deno fmt --check`/`deno lint` are clean (30
  pre-existing, unrelated `no-import-prefix` lint findings elsewhere in the
  repo are unchanged by this work). The plan's live-Docker validation steps
  (attaching to a real container and observing `exit`/`exit 130`/a non-zero
  `devc claude` exit/an infra-failure `PATH` case/`--build`+`--no-clear`
  regression) were **not run** — no Docker available in this environment —
  and are left unchecked in the archived plan for a human to verify.

- [devc-bridge-keepawake](archived/devc-bridge-keepawake.md) — Activity-driven
  caffeinate: a reserved `ping` builtin in the bridge server starts the
  allowlisted `caffeinate` script on the first ping and stops it after a
  configurable idle timeout (default 5 min — must exceed the longest ping gap
  from long tool runs and permission prompts). Deliberately minimal: a
  re-armed `setTimeout` in a new `host/keepawake.ts` is the whole reaper, the
  existing state-dir marker still drives the tray ○/●, and `main.ts` and the
  client are unchanged. The tray's only change is an async `shutdown` that
  awaits `server.close()` so quitting never leaks a started `caffeinate`.
  Config (`DEVC_BRIDGE_KEEPAWAKE_COMMAND`/`_IDLE_MS`) is always-on for the
  tray; the headless `serve.ts` keeps `ping` opt-in (only enabled when one of
  those vars is set) so §A can test the unconfigured fall-through too.
  §A (in-container) validation fully passes: ping round-trip, start/no-double-
  start/expiry/re-arm/gap-reset, unauthorized-doesn't-arm, `close()` awaits
  stop, fall-through when unconfigured, and the full existing regression
  table. §B (macOS/GUI: real `pmset` assertions, tray icon, a real Claude
  session) was **not run** — no macOS host available in this environment —
  and is left unchecked in the archived plan for a human to verify.

- [devc-config-overlay](archived/devc-config-overlay.md) — Reintroduce a
  `devc.json` overlay (`mounts`/`additionalFeatures`/`remoteEnv` →
  `--mount`/`--additional-features`/`--remote-env`) that merges onto whichever
  base config is in play, in project mode as well as zero-config — the reference
  implementation only ever consulted it when the project had no
  `devcontainer.json`. Adds a user-level `~/.config/devc/devc.json` applying to
  every project, and a sparse `~/.config/devc/templates/` that overrides bundled
  assets per file and is re-applied every run, so a devc upgrade keeps shipping
  its new defaults.

- [devc-init-command](archived/devc-init-command.md) — Add a non-interactive
  `devc init [PATH]` that scaffolds the bundled default `.devcontainer/` into a
  project verbatim — the same files `devc config` writes on first creation,
  minus the wizard and minus the two managed mount fences. Refuses to clobber an
  existing config, and never triggers the first-run global-config wizard.

- [devc-picker-free-navigation](archived/devc-picker-free-navigation.md) — Make
  the configured roots a shortcut list rather than a boundary: `←` walks to the
  real parent everywhere and wraps to the shortcut list at `/`, so any folder
  can be picked. Roots stay unselectable. Because that makes out-of-root
  worktrees reachable, `resolveWorktree` stops calling them invalid and instead
  mirrors both the worktree's and the primary `.git`'s container targets from a
  shared base — the configured root when it holds the primary, else their common
  ancestor (what the devcontainer CLI does for a worktree project).

- [devc-picker-derived-mounts](archived/devc-picker-derived-mounts.md) — Show
  the auto-added primary repo `.git` mount in the source picker's
  `Source Folders` list the moment its worktree is picked, marked `◎` and inert
  (the picks cursor skips it) so it cannot be unticked while a worktree
  requiring it is picked. One shared helper backs both the picker display and
  the written fence, so they cannot disagree (introduced here as
  `impliedPrimaryMounts`; since replaced by `resolvePickedMounts` — see
  [devc-picker-free-navigation](archived/devc-picker-free-navigation.md)).
  Display-only: the fence contents are unchanged.

- [devc-wizard-modernize](archived/devc-wizard-modernize.md) — Replace the
  full-screen sidebar wizard (mnemonic `N`/`B`/`A` keys) with a modern inline
  sequential flow plus a multi-select, type-to-filter folder picker, zero new
  dependencies, on the existing `tui/term.ts`+`tui/keys.ts`.

- [devc-wizard-screens](archived/devc-wizard-screens.md) — Re-skin the
  folder-picker screens to the mockups in `.plans/design/wizard/` (screen
  banner, Title Case section headings, no mid divider, `>` filter line, `◎`
  pinned marker), and retire the superseded sidebar/step-table wizard
  description in the design doc.

- [devc-build-command](archived/devc-build-command.md) — Add a top-level
  `devc build` (recreate the container, `--no-cache` to drop the layer cache)
  and make `devc config` change-aware: it prompts for a rebuild only when the
  apply actually altered `devcontainer.json`, so toggling folders back to their
  original state prints "no changes" instead.

- [devc-drop-feature](archived/devc-drop-feature.md) — Remove the local
  devcontainer Feature entirely; deliver the baseline via the bundled Dockerfile
  (build-time) + a top-level `postCreateCommand` running
  `scripts/post-create.sh` (create-time), so zero-config and `devc config`
  projects share one transform-free `.devcontainer/` shape. Composition is
  preserved by the developer editing the project's own `post-create.sh` — the
  `post-create.user.sh` hook that plan proposed was dropped before it shipped,
  and no such file exists. Publishing a standalone OCI feature is explicitly
  dropped as a goal.

- [devc-worktree-mounts](archived/devc-worktree-mounts.md) — Worktree-aware
  `devc config` bind mounts: keep the source target's sub-path relative to the
  configured code root, and for a picked git worktree also mount the primary
  repo's `.git` at the mirror location (only when the worktree uses relative
  paths and the primary lives under the same root). Invalid worktrees are
  flagged live in the folder picker and skip the primary mount.

- [devc-container-feature-fix](archived/devc-container-feature-fix.md) — Fix
  zero-config `devc up`: a local Feature can't load from devc's out-of-tree
  bundled config, so the bundled default carries its baseline itself (Dockerfile
  build-time + top-level postCreateCommand runtime) while `devc config` projects
  keep the composable Feature. Also drops in-container tmux.

- [devc-help-output](archived/devc-help-output.md) — Clap-style
  `--help`/`--version`: structured top-level help with a `Commands:` list,
  `-V`/`--version`, and per-command `devc <cmd> --help` blocks (verbatim from
  the design doc), in a new pure `help.ts` module.

- [devc-config-wizard](archived/devc-config-wizard.md) — The four-step
  `devc config` project wizard writing `.devcontainer/` via two comment-fenced
  mount blocks (`devc:source`/`devc:skills`) over the kept `jsonc_edit.ts`;
  opt-in per-folder skills with a remembered last-selection seed.
- [devc-global-config](archived/devc-global-config.md) — Global user config
  (`codeRoots`/`skillsRoots` at `~/.config/devc/config.json`), first-run flow,
  and the reusable step-based wizard TUI shell (reusing
  `tui/term.ts`+`tui/keys.ts`) with the Global config step.
- [devc-container-feature](archived/devc-container-feature.md) — Repackage the
  baseline setup (Claude CLI, `.claude` volume/symlink, shell additions) as a
  custom devcontainer Feature so a project's own top-level `postCreateCommand`
  composes instead of clobbering it; make skills opt-in in the zero-config
  default.
- [devc-lifecycle-core](archived/devc-lifecycle-core.md) — Replace the
  fence-based tool with the container-lifecycle CLI
  (`up`/`attach`/`claude`/`exec`/`mounts`/`stop`/`down`/`status`) + bundled
  default, ported from the reference `@devcontainers/cli`+`docker`
  implementation (tmux-attach and `.devc` overlay dropped).
- [devc-tui-home-paths](archived/devc-tui-home-paths.md) — Home directory
  support: expand `~`/`$HOME` in host-side config values, and write mount
  `source=` paths under home as `${localEnv:HOME}/...`.
- [devc-tui-host-folder-paths](archived/devc-tui-host-folder-paths.md) — Fix the
  `devc-tui:folders` fence, which writes container paths into a workspace file
  VS Code opens on the host: write host paths relative to the workspace file,
  and move the selection read-back with them.
- [devc-tui-folder-tree](archived/devc-tui-folder-tree.md) — Make the
  interactive tree mirror the scanned directory layout: worktree groups shown in
  place instead of re-parented under their primary, collapsed by default, and
  the fold column reserved for fold state.
- [devc-tui-ui](archived/devc-tui-ui.md) — The interactive checkbox folder tree
  on top of the core: scrollable tri-state tree, filter, skills section, writing
  through the same apply path as the CLI.
- [devc-tui-core](archived/devc-tui-core.md) — New `devc-tui/` tool: scan a
  configured root for repos and worktrees, and toggle them as bind mounts in
  `.devcontainer/devcontainer.json` plus folders in the `.code-workspace`, via
  comment-fenced managed blocks. Headless CLI + tests.
- [host-command-bridge](archived/host-command-bridge.md) — Loopback-TCP + token
  bridge letting a devcontainer invoke allowlisted host scripts (e.g.
  `caffeinate`), with a Deno Desktop menu-bar tray showing idle/active state.
- [host-lifecycle-cli](archived/host-lifecycle-cli.md) — Single self-contained
  `devc-bridge` executable with `start`/`stop`/`status`/`restart` background
  lifecycle and zero-setup config/command seeding.

## Development Phases

| Phase                                                                                    | Plan                                                                       | Status   |
| ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | -------- |
| Host command bridge (socket server + client + tray)                                      | [host-command-bridge](archived/host-command-bridge.md)                     | complete |
| Host `devc-bridge` lifecycle CLI + zero-setup seeding                                    | [host-lifecycle-cli](archived/host-lifecycle-cli.md)                       | complete |
| devc-tui core — scan, model, fenced-region file surgery                                  | [devc-tui-core](archived/devc-tui-core.md)                                 | complete |
| devc-tui interactive UI — checkbox project tree                                          | [devc-tui-ui](archived/devc-tui-ui.md)                                     | complete |
| devc-tui tree reshape — folder tree, collapsed by default                                | [devc-tui-folder-tree](archived/devc-tui-folder-tree.md)                   | complete |
| devc-tui workspace folders — host paths, not container paths                             | [devc-tui-host-folder-paths](archived/devc-tui-host-folder-paths.md)       | complete |
| devc-tui home directory support — `$HOME` in config, `${localEnv:HOME}` in mounts        | [devc-tui-home-paths](archived/devc-tui-home-paths.md)                     | complete |
| devc lifecycle core — container commands + bundled default (ported)                      | [devc-lifecycle-core](archived/devc-lifecycle-core.md)                     | complete |
| devc baseline as a devcontainer Feature — composable postCreate                          | [devc-container-feature](archived/devc-container-feature.md)               | complete |
| devc global config + wizard TUI foundation                                               | [devc-global-config](archived/devc-global-config.md)                       | complete |
| devc config wizard — project `.devcontainer/` via managed fences                         | [devc-config-wizard](archived/devc-config-wizard.md)                       | complete |
| devc help output — clap-style `--help`/`--version` + per-command help                    | [devc-help-output](archived/devc-help-output.md)                           | complete |
| devc container baseline fix — out-of-tree Feature + drop in-container tmux               | [devc-container-feature-fix](archived/devc-container-feature-fix.md)       | complete |
| devc wizard modernize — inline sequential flow + multi-select folder picker              | [devc-wizard-modernize](archived/devc-wizard-modernize.md)                 | complete |
| devc worktree-aware mounts — root-relative source targets + primary `.git` mount         | [devc-worktree-mounts](archived/devc-worktree-mounts.md)                   | complete |
| devc `~/.claude` seed dir — one read-only directory bind, symlinked in postCreate        | [devc-claude-seed-dir](archived/devc-claude-seed-dir.md)                   | complete |
| devc `init` command — scaffold the bundled default `.devcontainer/` into a project       | [devc-init-command](archived/devc-init-command.md)                         | complete |
| devc drop Feature — Dockerfile + top-level `postCreateCommand`; `scripts/` + user hook   | [devc-drop-feature](archived/devc-drop-feature.md)                         | complete |
| devc `build` command + change-aware `config` rebuild prompt                              | [devc-build-command](archived/devc-build-command.md)                       | complete |
| devc wizard screens — picker chrome per `.plans/design/wizard/` mockups                  | [devc-wizard-screens](archived/devc-wizard-screens.md)                     | complete |
| devc picker derived mounts — implied primary `.git` shown in the picks list              | [devc-picker-derived-mounts](archived/devc-picker-derived-mounts.md)       | complete |
| devc picker free navigation — roots as shortcuts + worktree mirror base                  | [devc-picker-free-navigation](archived/devc-picker-free-navigation.md)     | complete |
| devc config overlay — `devc.json` in both modes + user template layer                    | [devc-config-overlay](archived/devc-config-overlay.md)                     | complete |
| devc-bridge keepalive — `ping` builtin + idle-timeout caffeinate                         | [devc-bridge-keepawake](archived/devc-bridge-keepawake.md)                 | complete |
| devc attach exit-code handling — stop crashing on non-zero `docker exec`                 | [devc-attach-exit-code](archived/devc-attach-exit-code.md)                 | complete |
| devc mounts to overlay — wizard fences move into `devc.json`, out of `devcontainer.json` | [devc-mounts-to-overlay](archived/devc-mounts-to-overlay.md)               | complete |
| devc project post-create hook — restore `devc-post-create.sh` for zero-config projects   | [devc-project-post-create-hook](archived/devc-project-post-create-hook.md) | complete |
| devc-bridge client by read-only mount — every container, no per-repo build               | [devc-bridge-client-mount](archived/devc-bridge-client-mount.md)           | complete |
| devc-bridge as a devcontainer Feature — one opt-in line, one mechanism                   | [devc-bridge-feature](archived/devc-bridge-feature.md)                     | complete |
| devc-bridge tray decoupling — headless by default, tray as an add-on                     | [devc-bridge-tray-decouple](archived/devc-bridge-tray-decouple.md)         | complete |
| releases + installer — GH Action builds every binary; `curl \| sh` installs them         | [release-and-installer](archived/release-and-installer.md)                 | complete |
| `features/` as a real collection — guard and test every Feature, not just the bridge     | [features-collection](archived/features-collection.md)                     | complete |
| `node-nvmrc` Feature — `.nvmrc` install at create, `nvm use` on `cd`                     | [feature-node-nvmrc](archived/feature-node-nvmrc.md)                       | complete |
| Features version independently — unpin the collection from the repo tag                  | [feature-independent-versions](feature-independent-versions.md)            | pending  |
| `shell-dirs` Feature — sourced `*.sh` layers; devc keeps the read-only user layer        | [feature-shell-dirs](feature-shell-dirs.md)                                | pending  |
| `git-container-config` Feature — container-scope git settings; identity stays devc's     | [feature-git-config](feature-git-config.md)                                | pending  |
| `claude-config` Feature — agent CLIs + `~/.claude` wiring; seed stays devc's             | [feature-claude-config](feature-claude-config.md)                          | pending  |
