# Host `devc-tools` lifecycle CLI + zero-setup seeding

## Context

The host bridge is a `deno desktop` app (`host/server.ts`) that runs only in the foreground
and requires manual setup (`mkdir ~/.config/devc-tools/run` + symlink `commands`). We want a
single self-contained `devc-tools` executable that: (1) supports `devc-tools start` /`stop`
/`status`/`restart` to manage a **background** tray, and (2) auto-creates its config dir and
seeds command scripts on first start, so a shared binary "just works" on PATH.

Approach: one `deno desktop` entrypoint (`host/main.ts`) that dispatches on argv. CLI
subcommands run fast and exit; `run` runs the tray. `start` re-launches the same executable
(`Deno.execPath()`) with `run`, detached, and records the PID. Command scripts are embedded
via `deno compile --include` and read at runtime via `new URL("./commands", import.meta.url)`
(verified working from a compiled binary regardless of cwd), then seeded to the editable
commands dir if absent.

## Checklist

- [x] `host/config.ts`: path resolution (`base`/`run`/`state`/`commands`/`token`/`pidfile`/
      `logfile`) honoring existing env overrides + new `DEVC_HOST_BASE`; `ensureConfig()`
      (mkdir run/state/commands + seed); `seedCommands()` reads embedded `./commands`, writes
      any missing target file `0755`, never overwrites.
- [x] `host/tray.ts`: `runTray(cfg)` — the tray wiring moved out of `server.ts` (no top-level
      side effects); server + pidfile + SIGINT/SIGTERM handler set up first, then best-effort
      tray on top (falls back to headless if the Tray API is absent — also makes `run` testable
      in-container); "Quit"/signal handlers remove the pidfile; keeps embedded base64 icons.
- [x] `host/main.ts`: argv dispatch — `start`/`stop`/`status`/`restart`/`run`/(none)/usage.
      Detached spawn via `/bin/sh -c 'exec "$@" >>LOG 2>&1 </dev/null'` (stable PID) + `unref()`;
      compiled → `["run"]`, dev → `["desktop","-A",<script>,"run"]`; post-spawn liveness poll.
- [x] Remove `host/server.ts` (body relocated to `tray.ts`).
- [x] `host/deno.json`: `dev` (`main.ts run`), `build` (`--output devc-tools --backend raw
      --include commands --icon ../icons/app.png … main.ts`), `start`/`stop`/`status` tasks, keep `serve`.
- [x] `README.md`: replace manual setup with `devc-tools start`/`stop`/`status`; document
      auto-seed + build → PATH; update Layout table.
- [x] `docs/testing.md`: drop symlink from §B; add lifecycle + auto-seed checks.
- [x] `.gitignore`: add `/host/devc-tools`.

## Validation

- [x] `seedCommands()` into a fresh temp base creates `echo`/`caffeinate`/`toggle` (`0755`);
      a 2nd call leaves an edited file untouched.
- [x] Headless-`run` compiled variant: on a clean base `start` → `started (pid N)` + creates
      run/state/commands + token; 2nd `start` → `already running`; `status` → `running (pid N)`;
      `stop` → `stopped` and PID gone; 2nd `stop` → `not running`; logfile exists. Also
      round-tripped `echo`/`toggle` through the backgrounded server; `toggle on` → `status`
      shows `active: toggle`; port released after `stop`.
- [x] `deno check host/*.ts` clean (lint `no-import-prefix` is a pre-existing repo-wide style).
- [ ] (host, user) `deno task build` → `devc-tools` on PATH; clean-machine `start` shows tray
      with no window flash, seeds config; `devc-host echo hello` works; `status`/`stop` behave.
      Confirm `--backend raw` still shows `Deno.Tray`; if not, drop to the default webview
      backend (the tray layer already keeps the window-hiding hack).

## Relevant Files

- `host/config.ts` — new: paths + ensureConfig + seedCommands
- `host/tray.ts` — new: `runTray()` (from `server.ts`)
- `host/main.ts` — new: argv dispatch + lifecycle + detached spawn
- `host/server.ts` — removed
- `host/deno.json` — task changes
- `host/core.ts`, `host/token.ts`, `host/serve.ts` — unchanged (imported)
- `README.md`, `docs/testing.md`, `.gitignore` — docs/ignore updates
