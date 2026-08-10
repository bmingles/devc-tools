# Testing

Two tiers: **§A** runs entirely inside the devcontainer (no host, no GUI) and is
already automated/verified; **§B** is host-only (macOS + GUI + the devcontainer
tool) and must be run by hand.

Transport is **loopback TCP + a shared token** (a bind-mounted unix socket does
not cross the Docker Desktop VM boundary — see the README). §A exercises this
over `127.0.0.1` inside the container; §B exercises it over
`host.docker.internal`.

## §A — In-container (client + server, no host)

Proves the protocol, token auth, dispatch, allowlist, and injection-safety
without a Mac. Run from `devc-bridge/` inside the devcontainer.

```sh
# 1. Start the headless server on loopback
export DEVC_BRIDGE_HOST=127.0.0.1 DEVC_BRIDGE_PORT=48227
export DEVC_BRIDGE_COMMANDS="$PWD/host/commands"
export DEVC_BRIDGE_STATE=/tmp/devc-bridge/state
export DEVC_BRIDGE_TOKEN_FILE=/tmp/devc-bridge/token
export DEVC_BRIDGE_KEEPAWAKE_IDLE_MS=1500
rm -rf /tmp/devc-bridge
deno run --allow-read --allow-write --allow-run --allow-env --allow-net host/serve.ts &

# 2. Client helper (points at the same loopback + token)
export DEVC_BRIDGE_ADDR=127.0.0.1:48227
client() { deno run --allow-read --allow-net --allow-env=DEVC_BRIDGE_ADDR,DEVC_BRIDGE_TOKEN_FILE client/devc-bridge.ts "$@"; }
```

| Check               | Command                                                         | Expected                                            |
| ------------------- | --------------------------------------------------------------- | --------------------------------------------------- |
| A1 round-trip       | `client echo hello`                                             | `echo: hello`, exit 0                               |
| A2 multi-arg        | `client echo a b c`                                             | `echo: a b c`                                       |
| A2 exit propagation | `client toggle badarg; echo $?`                                 | usage on stderr, exit `2`                           |
| A3 injection safety | `client echo '; touch /tmp/pwned; #'`                           | printed literally; `/tmp/pwned` NOT created         |
| A4 unknown command  | `client nope; echo $?`                                          | `unknown command: nope`, exit 1                     |
| A4 traversal        | `client ../serve.ts; echo $?`                                   | `invalid command name`, exit 1                      |
| AUTH bad token      | `DEVC_BRIDGE_TOKEN_FILE=<file with wrong token> client echo hi` | `unauthorized`, exit 1                              |
| A5 state watcher    | `client toggle on` then `client toggle off`                     | server log shows `active: []` → `["toggle"]` → `[]` |

Cleanup: `pkill -f host/serve.ts; rm -rf /tmp/devc-bridge`.

### §A — keepalive (`ping` builtin + idle-timeout `caffeinate`)

The real `caffeinate` script is macOS-only, so these use a stub `commands/caffeinate`
with `toggle`-style marker semantics (`start` → touch `$DEVC_BRIDGE_STATE/caffeinate`
+ append `start` to an invocation log; `stop` → remove the marker + append `stop`).
Put the log **outside** `$DEVC_BRIDGE_STATE` (e.g.
`$(dirname "$DEVC_BRIDGE_STATE")/caffeinate-invocations.log`) — a file inside
`state/` is read by the active-marker scan and would break A5/regression checks.
Point `DEVC_BRIDGE_COMMANDS` at a directory with that stub (plus `echo`/`toggle`)
instead of `host/commands` for these rows; `DEVC_BRIDGE_KEEPAWAKE_IDLE_MS=1500` in
the setup snippet above keeps the idle window short.

| Check                    | Command                                                    | Expected                                                             |
| ------------------------ | ----------------------------------------------------------- | --------------------------------------------------------------------- |
| K1 round-trip            | `client ping PostToolUse`                                   | `pong`, exit 0 — same response shape as `client echo`                 |
| K2 starts                | `client ping A`                                              | marker `caffeinate` appears; invocation log shows exactly one `start` |
| K3 no double-start       | two more `client ping` calls while active                   | still exactly one `start` in the log                                  |
| K4 expiry stops          | wait ~1.5s after the last ping                               | marker gone; log gains one `stop`                                     |
| K5 re-arm                | `client ping` again after expiry                             | marker returns; log gains a second `start`                            |
| K6 ping gap reset        | ping, wait 1s, ping, wait 1s (each gap < idleMs)             | still active (no `stop` yet); silence afterward then stops            |
| K7 unauthorized          | `client ping` with a wrong token                             | `unauthorized`, exit 1; marker does NOT appear                        |
| K8 `close()` stops       | keepalive armed, `kill -TERM` the server pid                 | marker removed, log gains `stop` (proves the await, not just intent)  |
| K9 fall-through          | serve **without** the two `DEVC_BRIDGE_KEEPAWAKE_*` env vars, then `client ping X` | `unknown command: ping`, exit 1                    |

Cleanup: as above, plus remove the stub commands dir and its invocation log.

## §B — Host verification (macOS)

Requires Deno 2.9+ on the host (only to _build_). Run **in order — stop at the
first failure.**

```sh
# One-time build: self-contained binary with the command scripts embedded.
cd devc-bridge/host && deno task build  # → ./devc-bridge
install devc-bridge /usr/local/bin/     # anywhere on PATH

# GATE: zero-setup start (no hand-created ~/.config) reaches the container over
# host.docker.internal?
rm -rf ~/.config/devc-bridge        # prove first-run seeding (optional; destroys existing config)
devc-bridge start                   # seeds config, writes token, menu-bar icon appears (idle ○)
# → reopen the devcontainer, then INSIDE it:
devc-bridge echo hello              # expect: echo: hello
```

If the gate fails, check in this order:

1. **`cannot read token /run/devc-bridge/token`** → run dir not mounted, or
   server not started. Confirm the repo-root `.devc/devc.json` mount +
   `devc-bridge status` shows `running`.
2. **`cannot connect to host.docker.internal:48227`** → the container can't
   reach host loopback. Try `DEVC_BRIDGE_HOST=0.0.0.0 devc-bridge restart` on
   the host.
3. **`unauthorized`** → stale token in the container's mount;
   `devc-bridge restart` / reopen.
4. **`unknown command: echo`** → commands not seeded; check
   `~/.config/devc-bridge/commands/` exists (it is auto-created on `start`).

| Check               | Where     | Command                                             | Expected                                                                                                                      |
| ------------------- | --------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| B0 zero-setup       | host      | `rm -rf ~/.config/devc-bridge && devc-bridge start` | `started (pid N)`; `~/.config/devc-bridge/{run,state,commands}` + token created; `commands/` has `echo`/`caffeinate`/`toggle` |
| B0 idempotent       | host      | `devc-bridge start` again                           | `already running (pid N)`                                                                                                     |
| B0 status/stop      | host      | `devc-bridge status` then `devc-bridge stop`        | `running (pid N)` (icon shown) → `stopped` (icon gone)                                                                        |
| B1 gate             | container | `devc-bridge echo hello`                            | `echo: hello`                                                                                                                 |
| B2 caffeinate start | container | `devc-bridge caffeinate start`                      | `started`                                                                                                                     |
| B2 assertion        | host      | `pmset -g assertions \| grep -i caffeinate`         | assertion present                                                                                                             |
| B2 status           | container | `devc-bridge caffeinate status`                     | `running`                                                                                                                     |
| B2 stop             | container | `devc-bridge caffeinate stop`                       | `stopped`, assertion gone                                                                                                     |
| B3 tray             | host      | (watch menu bar)                                    | ○→● on start, ●→○ on stop; "Quit" exits                                                                                       |
| B4 no window flash  | host      | `devc-bridge start`/`stop`/`status`                 | no webview window appears (menu-bar only, `--backend raw`)                                                                    |
| B5 real caffeinate  | container | `devc-bridge ping PostToolUse`                      | `pmset -g assertions` (host) shows the caffeinate assertion; tray flips ○→●                                                   |
| B6 idle stop        | host      | stop pinging, wait ~5 min (default idle timeout)    | assertion and marker gone; tray returns to ○                                                                                  |
| B7 quit while armed | host      | Quit the tray mid-keepalive                         | `pmset -g assertions` no longer shows caffeinate (no leak)                                                                    |
| B8 status unchanged | container | `devc-bridge status` while armed                    | still reports `— active: caffeinate` (unchanged code path — confirms nothing regressed)                                       |
| B9 real hook        | container | install the README's `PostToolUse`/`UserPromptSubmit` hook snippet in `settings.json`, run a short Claude session | assertion appears on the first tool call; clears ~5 min after the session goes quiet |

### Notes / gotchas

- **Transport:** a bind-mounted unix socket is refused across the Docker Desktop
  boundary (`ECONNREFUSED` in the container while a host-local `nc -U` works).
  We use loopback TCP via `host.docker.internal` instead; a token file (carried
  over the same mount, since regular files cross fine) authorizes requests.
- **Permissions:** unix/TCP `listen`/`connect` need **`--allow-net`**, not
  `--allow-read/write`. The client also needs `--allow-read` (token file) and
  `--allow-env=DEVC_BRIDGE_ADDR,DEVC_BRIDGE_TOKEN_FILE`. All baked into the
  `deno.json` tasks.
- **`deno desktop` runs from a temp dir**, so paths relative to
  `import.meta.url` point into the bundle, not the CWD. Tray icons are embedded
  (base64) in `host/tray.ts`; command scripts are embedded via
  `deno desktop --include commands` and read back through
  `new URL("./commands", import.meta.url)` in `host/config.ts`, then **seeded**
  to the editable `~/.config/devc-bridge/commands` on first `start` (never
  overwritten thereafter).
