# devc-bridge — headless by default, tray as an add-on

## Goal

`devc-bridge start` runs the bridge as a plain detached background process. No
`.app` bundle, no `deno desktop`, no LaunchServices. The menu-bar tray becomes
an opt-in extra rather than the only way to run the thing.

This is what makes the host binary shippable at all, and it deletes work from
[release-and-installer](release-and-installer.md) rather than adding to it.

### Why

The tray serves one purpose — showing idle-vs-active in the menu bar — and it
currently drags three unrelated costs behind it:

1. **A compiled host binary cannot `start`.** It shells out to
   `deno desktop … main.ts` with `cwd` derived from `Deno.mainModule`, which in a
   compiled binary is a virtual path that does not exist. Verified by compiling
   and running it:

   ```
   devc-bridge: building tray app…
   NotFound: Failed to spawn '/usr/local/bin/deno': No such cwd '/tmp/deno-compile-dbtest'
   ```

   It also requires a `deno` on the user's PATH, which a released binary must
   not.
2. **It is the only reason the settings file exists.** `open -g` starts the tray
   under launchd, which does not have the shell's environment, so `start` has to
   capture `DEVC_BRIDGE_*` vars and write them somewhere the tray can read them
   (`config.ts:56` says exactly this). A detached child inherits the environment
   and the whole mechanism becomes unnecessary.
3. **It is the only macOS-GUI-bound part of the bridge.** `core.ts` owns the TCP
   server, dispatch, the state watcher and keepawake; `tray.ts` is a best-effort
   layer that already returns `null` and runs headless when `Deno.Tray` is absent
   (`tray.ts:106`); `serve.ts` is already a headless entrypoint. **Keepawake has
   no dependency on the tray** — `core.ts:174` constructs it regardless.

So the feature everyone actually wants (keep the Mac awake while Claude works)
already runs without a tray. Only `start` insists otherwise.

## Decisions

1. **Headless is the default and the tray is opt-in**, not the reverse. The
   bridge's job is answering the container; the icon is a convenience. Anyone
   who wants it asks for it.
2. **`start` spawns this same program detached, with the `run` subcommand.** No
   build step at all — which is the point, since building was what made a
   compiled binary impossible. `stop` and `status` are untouched: they are
   pidfile-based and already work in a compiled binary.
3. **Relaunching must work from source _and_ compiled.** Under `deno run`,
   `Deno.execPath()` is the `deno` binary and the script path is needed;
   compiled, `execPath()` is the bridge itself. One helper returns the argv for
   both, rather than sprinkling the distinction through `start`. This is the
   same source-vs-compiled question [release-and-installer](release-and-installer.md)
   raised, answered once and in the one place that needs it.
4. **Delete the settings-file mechanism entirely** — `Settings`, `SETTING_ENV`,
   `readSettings`, `persistEnvSettings`, `settingsFile`, and the stored-value
   precedence in `loadConfig`. Environment variables become the only source, as
   they were before the tray forced the workaround. Pre-release, so no
   compatibility shim; a leftover `settings.json` is simply ignored.
5. **The tray keeps working, from source, unchanged.** `deno task dev` and an
   explicit opt-in still reach `runTray`. `tray.ts` itself does not change — it
   stops being on the default path, that is all. **Shipping a tray artifact is
   deliberately out of scope**: bundling is what pulls in `deno desktop`,
   `iconutil` (which cannot cross-build — see release-and-installer finding 3)
   and code signing, and none of that should gate a headless daemon.
6. **Losing the menu-bar icon by default is an accepted UX regression.**
   `devc-bridge status` already reports idle-vs-active and grows a `client:`
   line; that is the supported way to answer "is it working". Re-adding a
   shipped tray is a follow-on, not a debt.
7. **Keepawake is not touched.** `Keepawake` dispatches `start`/`stop` through a
   `run(command, args)` seam to an allowlisted _script_, so the keepalive
   contract is "a script in `commands/` that accepts start|stop" — already
   independent of both the tray and the platform. Linux support is a script plus
   a default, and belongs in its own change.

## Implementation

### `devc-bridge/host/main.ts`

- **`start`**: drop the `deno desktop` build and the `open -g` launch. Spawn the
  relaunch argv (decision 3) detached, with stdin closed and stdout/stderr
  appended to `cfg.logfile`, then wait for the pidfile exactly as today. The
  child must survive the parent exiting and must not hold the terminal open.
  Keep the port-in-use pre-check, the stale-pidfile removal, the 30s readiness
  wait and the log tail on failure — all of that is orthogonal to how the
  process got started, and the failure modes it explains still exist.
- **`run`**: becomes the headless path. `devc-bridge run --tray` is the only way
  to reach `runTray`; bare `run` starts the core directly. `--tray` is the
  pinned spelling, and `USAGE` gains it — this is a user-facing contract, not an
  implementation detail to settle later.
- Remove the `persistEnvSettings` call and the "run `restart` to apply new
  settings" branch, which only existed because settings were read once at tray
  launch.

### `devc-bridge/host/config.ts`

Delete everything named in decision 4. `loadConfig` reads env or built-in
defaults, nothing else. `Config` loses `settingsFile`.

Note this file is also touched by
[devc-bridge-feature](devc-bridge-feature.md), which moves `pidfile` out of
`run/`. Independent edits; whichever lands first does that move.

### `devc-bridge/host/serve.ts` — deleted

Its whole purpose was "the core, without a tray", which is what bare `run` now
is. Keeping it would leave two headless entrypoints that disagree: `serve.ts`
treats keepawake as opt-in (only when a `DEVC_BRIDGE_KEEPAWAKE_*` var is set)
while `Config` always populates it. **Resolve toward `Config`** — keepawake is
always configured, and `ping` is always intercepted. The opt-in existed so one
entrypoint could exercise both the configured and unconfigured paths during the
original keepawake experiment; that is a test concern, and a test can construct
`startServer({ keepawake: undefined })` directly rather than a whole entrypoint
existing to express it.

### `devc-bridge/host/deno.json`

`dev` (the `deno desktop` task) stays — it is how the tray is developed. The
`build` task now produces the plain binary rather than the `.app`.

### `.plans/release-and-installer.md`

That plan's first checklist item and its two `.app` assets are obsoleted by this
one, not implemented by it. Update it in the same change so the sequence stays
coherent: drop `DevcBridge-<target>.app.tar.gz` ×2 (ten archives → eight), drop
the `start`-builds-only-from-source item, and revisit whether the macOS runners
are still needed for anything but signing.

## Checklist

- [ ] `devc-bridge/host/main.ts` — `start` spawns detached; no build, no `open`
- [ ] `devc-bridge/host/main.ts` — relaunch-argv helper covering source and
      compiled
- [ ] `devc-bridge/host/main.ts` — bare `run` is headless, `run --tray` reaches
      the tray, `USAGE` updated
- [ ] `devc-bridge/host/config.ts` — settings-file mechanism deleted
- [ ] `devc-bridge/host/serve.ts` — deleted; keepawake semantics resolve to
      `Config` (always configured)
- [ ] `devc-bridge/host/deno.json` — `build` produces the plain binary
- [ ] Tests for the relaunch-argv helper (both modes) and for `start`'s
      detach-and-wait contract
- [ ] `.plans/release-and-installer.md` — `.app` assets and the `start`
      prerequisite removed
- [ ] `devc-bridge/README.md` — headless default, `status` as the
      idle/active affordance, tray as a from-source extra
- [ ] `.plans/PLAN.md` — status

## Validation

- [ ] `deno task check` / `fmt --check` clean
- [ ] Relaunch-argv helper returns a runnable argv under `deno run` and under a
      compiled binary
- [ ] (user) From source: `devc-bridge start` → `status` reports running;
      `devc-bridge ping test` from a container still returns `pong`
- [ ] (user) **The case that motivates this plan:** `deno task build`, then run
      the _compiled_ binary's `start` on a machine with **no `deno` on PATH** →
      it comes up. This is the exact path that fails today
- [ ] (user) The daemon survives closing the terminal that started it
- [ ] (user) `stop` still stops it; `restart` works; a second `start` reports
      already-running rather than starting a rival
- [ ] (user) Keepalive still works end-to-end with no tray: pings from a
      container start `caffeinate` and it stops after the idle timeout
      (`pmset -g assertions | grep -i caffeinate`)
- [ ] (user) `DEVC_BRIDGE_KEEPAWAKE_IDLE_MS=… devc-bridge restart` takes effect
      **without** the settings file — the inherited environment is the whole
      mechanism now (decision 4)
- [ ] (user) Tray still reachable from source via the opt-in and `deno task dev`

## Relevant Files

- `devc-bridge/host/main.ts` — `start`, `run`, the relaunch helper
- `devc-bridge/host/config.ts` — settings deletion
- `devc-bridge/host/serve.ts` — deleted
- `devc-bridge/host/tray.ts` — unchanged, off the default path
- `devc-bridge/host/deno.json`, `devc-bridge/README.md`
- `.plans/release-and-installer.md` — assets and prerequisite drop out
- `.plans/PLAN.md`

## Follow-on (not this plan)

- **Ship the tray as an optional artifact**, if it is still wanted once
  `status` has been the answer for a while. That is where `deno desktop`,
  `iconutil` and signing come back, and it can be judged on its own.
- **A Linux keepawake command** — a `systemd-inhibit` script in `commands/` plus
  a platform-aware default (decision 7). With the tray off the default path,
  that is the last thing keeping the host macOS-only.
