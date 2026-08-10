# devc-bridge keepalive — `ping` builtin with idle-timeout caffeinate

## Context

Today the bridge's caffeinate support is explicitly managed: Claude Code hooks
call `devc-bridge caffeinate start` on `SessionStart` and `stop` on
`SessionEnd` (README's wiring example). We want activity-driven management
instead: a hook fires on **every tool call** and pings the bridge — "Claude is
still working" — and the host side starts `caffeinate` if it isn't running and
stops it after a short period of silence. The tray already reflects
active-vs-idle via the state-dir marker the `caffeinate` script maintains, and
keeps doing so with **no tray changes at all**.

Why this is better than what exists:

- **Crash robustness.** A container stop or killed session never sends
  `SessionEnd`; explicit management leaks a `caffeinate -dimsu` forever.
  Idle-timeout is self-healing by construction.
- **Concurrent sessions.** Two Claude sessions sharing the host: today the
  first session's `SessionEnd` kills caffeinate out from under the second.
  Last-ping-wins is a natural refcount — caffeinate stops only when _all_
  sessions go quiet.

### Scope discipline

The whole feature is: **a ping resets a timer; caffeinate runs while the timer
is unexpired.** The state is two fields (`armed`, `lastPingAt`) and one
`setTimeout`. Anything that does not serve that sentence — status files,
sweep loops, marker reconciliation, live countdowns — was considered and cut;
see §Deliberately not built for what was dropped and why, so a later reader
does not "restore" it as an oversight.

### Decision: the state machine lives in the server, not a command script

The idle timeout needs a **persistent timer**. A command script is a one-shot
process — a script-side `caffeinate ping` verb would have to spawn a detached
watcher loop and manage its PID/orphans across every edge case. The server in
`host/core.ts` is already long-running and already drives the tray. So:
keepalive **policy** (when to start/stop) is a new server-side builtin; the
`caffeinate` script stays the dumb **mechanism** (`start|stop|status`,
host-editable, owns the marker/pidfile). This also keeps the whole feature
testable in-container via `host/serve.ts` (§A), which a bash reaper would not
be.

### Rejected alternatives

- **`caffeinate ping` script verb + background reaper loop** — orphan process
  management, PID races, untestable headless. See above.
- **Generic "any authorized request counts as activity"** with configured
  on-active/on-idle commands — arguably more elegant (bridge in use ⇒ stay
  awake), but implicit: nothing in the hook config says what's keeping the Mac
  awake, and any stray one-off command (a manual `echo`) would arm it. An
  explicit `ping` builtin is self-documenting and predictable.
- **Session registration** (`SessionStart`/`SessionEnd` hooks passing the
  `session_id` from the hook's stdin JSON; caffeinate runs while ≥1 session is
  registered, ping/timeout as crash backstop) — tighter semantics, but more
  moving parts for marginal gain over a well-chosen timeout. Not built now; a
  possible later layer.

### The timeout is the one real design trap

Silence does not mean idle. A 10-minute `Bash` tool call fires `PreToolUse` at
T0 and `PostToolUse` at T0+10m — **no pings in between** — and while Claude
waits on a permission prompt no tool events fire at all. Hook pings cannot
cover the duration of a single tool call, so the timeout must exceed the
longest plausible ping _gap_ (long tool runs, human think time at prompts), not
merely "how fast to notice Claude finished." The cost of overshooting is the
Mac staying awake a few extra minutes; the cost of undershooting is the Mac
suspending the VM mid-build. Default: **5 minutes**, configurable.

## Contract

### Protocol: reserved `ping` builtin

Request (unchanged envelope; args optional):

```
→ {"token":"…","command":"ping","args":["PostToolUse"]}
← {"ok":true,"exitCode":0,"stdout":"pong\n","stderr":""}
```

- `args[0]`, when present, is a free-form **event label** (e.g. the hook event
  name) recorded as `lastEvent`. It is diagnostic only — it never affects the
  keepalive's behavior.
- The response shape is identical to a script-dispatch response, so the client
  (`client/devc-bridge.ts`) needs **no changes**.
- Token auth applies exactly as for script dispatch: a bad token gets
  `{"ok":false,"error":"unauthorized"}` and must **not** arm the keepalive.
- The intercept happens in `core.ts`'s request loop **after auth, before script
  dispatch**, and only when the server was configured with keepalive options.
  When not configured (bare `serve.ts` without the env vars), `ping` falls
  through to normal dispatch — i.e. `unknown command: ping` unless the host
  dropped a `ping` script in `commands/`.

### `host/keepawake.ts` (new) — the state machine

```ts
export interface KeepawakeOptions {
  /** Allowlisted script to drive, e.g. "caffeinate". */
  command: string;
  /** Stop after this much ping silence. */
  idleMs: number;
  /** Dispatch seam — core's script dispatch (runs the allowlisted script). */
  run: (command: string, args: string[]) => Promise<unknown>;
  log?: (msg: string) => void;
}

export interface KeepawakeStatus {
  /** Keepalive currently holding the command started. */
  active: boolean;
  /** Epoch ms of last ping; 0 = never pinged. */
  lastPingAt: number;
  /** Last ping's event label, if any. */
  lastEvent: string | null;
  idleMs: number;
  /** ms until auto-stop; 0 when inactive. */
  remainingMs: number;
}

export class Keepawake {
  constructor(opts: KeepawakeOptions);
  /** Record activity. Never blocks the caller and never throws. */
  ping(event?: string): void;
  status(): KeepawakeStatus;
  /** Clear the timer; if active, stop the command (awaited). */
  close(): Promise<void>;
}
```

The entire implementation is this shape:

```ts
ping(event) {
  this.lastPingAt = Date.now();
  this.lastEvent = event ?? null;
  clearTimeout(this.timer);
  this.timer = setTimeout(() => this.expire(), this.idleMs);
  if (!this.armed) {
    this.armed = true;
    this.enqueue(['start']);
  }
}
```

Semantics:

- **The timer is the whole reaper.** Each `ping()` clears and re-arms one
  `setTimeout(idleMs)`. There is no polling loop and no sweep interval —
  expiry is exact, and there is no "within one sweep" fuzz anywhere in this
  design.
- `ping()` is **fire-and-forget**: it flips `armed` synchronously, then queues
  the dispatch. The TCP response never waits on the script (hook latency
  matters); dispatch errors are logged, not thrown.
- On expiry: `armed = false`, queue `run(command, ["stop"])`.
- **Serialization is a promise tail**, not a lock:
  `this.queue = this.queue.then(() => this.run(...)).catch(log)`. Start/stop
  dispatches therefore run in issue order and can never overlap. This is both
  simpler and stricter than a busy-flag — nothing is dropped and nothing races.
- **Adoption semantics:** a manual `caffeinate start` with no pings is never
  auto-stopped (keepalive stays `inactive`); the first ping arms the keepalive
  and hands it the lifecycle (`start` is idempotent — the script already prints
  "already running"). Documented in the README as: any ping hands lifecycle
  management to the keepalive.
- **Manual stop wins until expiry.** If someone runs `caffeinate stop` while
  the keepalive is armed, the keepalive does not notice and does not fight it —
  it stays armed until the timer expires, then issues a redundant `stop` (a
  no-op; the script tolerates a missing pidfile). This is deliberate: a manual
  stop is an instruction, and its effect lasting up to `idleMs` is the right
  reading of it. See §Deliberately not built.
- `close()` stops the command if `armed` — quitting the tray must never leak a
  `caffeinate -dimsu`. It **awaits** the dispatch, since the process exits
  immediately after.

### Config (`host/config.ts`)

`Config` gains `keepawake: { command: string; idleMs: number }`:

| Env var                         | Default      | Notes                          |
| ------------------------------- | ------------ | ------------------------------ |
| `DEVC_BRIDGE_KEEPAWAKE_COMMAND` | `caffeinate` | resolved through the allowlist |
| `DEVC_BRIDGE_KEEPAWAKE_IDLE_MS` | `300000`     | non-numeric/≤0 → default       |

Two knobs, both meaningful to a user. There is no sweep interval to configure
and no status-file path to configure.

### `host/core.ts` touchpoints

- `ServerOptions` gains `keepawake?: { command: string; idleMs: number }`.
  Present → construct a `Keepawake`, wire `run` to the existing `dispatch`,
  intercept `ping`. Absent → no interception (fall-through described above).
- `RunningServer` gains `keepawake(): KeepawakeStatus | null` — for tests and
  any future tray display.
- `close()` becomes `Promise<void>`: it now also awaits the keepalive's close
  (stop-if-active).

### `close()` call sites

`close()` going async touches exactly three call sites (verified by grep):

- `host/tray.ts:72` — inside `shutdown`, which is shared by the `SIGINT`
  listener, the `SIGTERM` listener, **and** the tray's `quit` menuclick
  handler. Make `shutdown` async and `await server.close()` before
  `Deno.exit(0)`; all three paths are fixed by that one edit.
- `host/serve.ts:41` and `host/serve.ts:45` — two separate inline signal
  handlers, each needs its own `await`.

That is the tray's **only** required change.

### Hook wiring (README snippet — replaces the SessionStart/SessionEnd example)

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "*",
        "hooks": [
          { "type": "command", "command": "devc-bridge ping PostToolUse >/dev/null 2>&1 || true" }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          { "type": "command", "command": "devc-bridge ping UserPromptSubmit >/dev/null 2>&1 || true" }
        ]
      }
    ]
  }
}
```

The `|| true` + redirection are load-bearing: a down/unreachable bridge must
never fail the hook or leak noise into Claude's transcript. The README keeps a
note that an explicit `SessionStart → caffeinate start` may be layered on for
instant-on at session start, and that `SessionEnd → stop` should be removed
(the timeout is the backstop that makes it unnecessary).

The client needs **no changes**: `client/devc-bridge.ts:60` does
`const [command, ...args] = Deno.args` and forwards both verbatim, never
enumerating valid command names. `devc-bridge ping` with no label also works —
`args` is `[]`, so `args[0]` is undefined and `lastEvent` is `null`.

### Hook latency: measured, and where it actually goes

`PostToolUse` fires on **every tool call** and hooks block, so the ping's cost
is paid per tool call. Measured in-container against `host/serve.ts` with the
`deno compile`d client (20 sequential runs each):

| Path                                              | Per call    |
| ------------------------------------------------- | ----------- |
| Client binary startup alone (no args, no TCP)     | **77.6 ms** |
| + token read + TCP round trip (no script spawned) | **85.3 ms** |
| + server spawns a bash command script             | **91.1 ms** |

So a ping costs **~85 ms, and 91% of it is starting the 104 MB compiled Deno
binary.** The token read and the TCP round trip together are ~8 ms.

Two consequences for this design:

- **Keep `ping()` fire-and-forget, but do not oversell it.** Not awaiting the
  `caffeinate` dispatch saves the ~6 ms bottom row, not the 78 ms top row. It
  is still correct and free, just not where the time goes.
- **Do not micro-optimize the server for ping latency.** Nothing on the server
  side can move the number that matters; it is paid before the connection is
  opened.

Whether ~85 ms/tool-call is acceptable is a judgment call to make with the
number in hand, not a blocker — for reference, a 500-tool-call session pays
~40 s of added wall time, spread out. If it is ever felt in practice, the
escape hatch is below.

## Deliberately not built

Each of these was in an earlier draft and cut as unjustified complexity. Do not
add them back as part of this plan.

- **`run/keepawake.json` status file + a `devc-bridge status` suffix.** Its
  only payload was a live countdown. `status` **already** prints
  `— active: caffeinate` from the state-dir marker (`main.ts:149-153`), so the
  file bought a cosmetic detail in exchange for: a write on every ping, a
  partial-read tolerance rule, parent-dir creation, a config knob, and a
  "must not be written into `state/` or it becomes a phantom marker" hazard.
  **`host/main.ts` is unchanged by this plan.**
- **A sweep/reaper interval and its `DEVC_BRIDGE_KEEPAWAKE_SWEEP_MS` knob.** A
  single re-armed `setTimeout` is the timer. No polling, no third env var.
- **`isMarkerActive` seam + marker reconciliation.** A whole constructor seam
  and a sweep rule existing only to detect an external `caffeinate stop`.
  Without it the behavior is "manual stop wins until expiry," which is fine and
  self-heals within `idleMs`. Its removal also deletes the
  "keepalive-active vs. marker-active can disagree" concept boundary.
- **Tray live countdown (~1 Hz repaint) and enriched tooltip.** A forever-
  running interval animating a menu that is usually closed. The ●/○ icon
  already reflects caffeinate via the existing state-dir watcher, with zero
  tray changes.
- **"Stop caffeinate now" tray menu item, and the `RunningServer.run()` it
  required.** `devc-bridge caffeinate stop` already does this from anywhere.
- **A lightweight bash ping client.** Verified working: bash's `/dev/tcp`
  speaks the identical wire protocol in **1.9 ms** vs the Deno client's 85 ms
  (45× faster), because it skips the binary startup entirely —

  ```bash
  exec 3<>/dev/tcp/$HOST/$PORT
  printf '{"token":"%s","command":"ping","args":["%s"]}\n' "$(cat "$TOKEN_FILE")" "$1" >&3
  exec 3<&- 3>&-
  ```

  Not adopted **now**: it is a second client implementation that duplicates the
  protocol inside a hook string, to fix a cost that may never be felt. Recorded
  here — with the numbers and the working snippet — so that if hook latency
  does bite, the fix is a known quantity rather than a re-investigation. Note
  it requires `bash` specifically (`zsh` has no `/dev/tcp`; it uses `ztcp`).

If the countdown or the menu item is genuinely missed in use, both are additive
on top of `RunningServer.keepawake()`, which this plan already exposes.

## Concept boundaries

- **`ping` builtin vs. a `commands/ping` script.** When keepalive is
  configured the builtin shadows any same-named script; `ping` is a reserved
  name, documented in the README's "Writing a command" section.
- **Explicit `caffeinate start|stop|status` remains** a valid allowlisted
  command alongside the builtin — the keepalive drives it, it is not replaced.

## .gitignore

No new repo-local artifacts, and (with the status file cut) no new runtime
artifacts at all. Nothing to add.

## Checklist

- [x] `host/keepawake.ts`: `Keepawake` per the contract — re-armed `setTimeout`
      idle timer, fire-and-forget `ping()`, promise-tail serialization,
      `close()` stop-if-active. No sweep loop, no marker seam, no status file.
- [x] `host/core.ts`: `ServerOptions.keepawake`; construct + wire the keepalive
      (`run` → existing `dispatch`); reserved-`ping` intercept after auth
      (unauthorized ping does not arm); `RunningServer.keepawake()`;
      `close()` → `Promise<void>` awaiting keepalive close.
- [x] `host/config.ts`: `Config.keepawake` from the two env vars with the
      default/validation behavior above.
- [x] `host/tray.ts`: make `shutdown` async and `await server.close()` — this
      covers the `SIGINT`/`SIGTERM` listeners and the `quit` menuclick handler
      that share it. Nothing else in the tray changes.
- [x] `host/serve.ts`: read the two env vars and pass keepalive opts (so §A can
      inject a tiny `idleMs`); `await server.close()` in **both** signal
      handlers.
- [x] `host/main.ts`: **no change** — verify none crept in.
- [x] `README.md`: replace the hooks example with the PostToolUse/
      UserPromptSubmit ping snippet; document the reserved `ping` builtin, the
      two env vars, adoption semantics, manual-stop-wins-until-expiry, and
      timeout guidance (must exceed the longest ping gap — long tool runs,
      permission prompts; default 5 min).
- [x] `docs/testing.md`: new §A rows (ping round-trip, marker appears on ping,
      no double-start, expiry stops, re-arm, unauthorized ping doesn't arm,
      `close()` stops, fall-through when unconfigured) and §B rows (pmset
      assertion appears on ping and vanishes after idle; Quit while armed
      clears the assertion).
- [x] `.plans/PLAN.md`: move this plan's entry to `## Completed` and set its
      `## Development Phases` row to `complete`, then move this file to
      `.plans/archived/`. Update the entry text — it currently promises a tray
      countdown, "Stop caffeinate now", and a `status` suffix via
      `run/keepawake.json`, all of which are cut here.

## Validation

Run from `/workspaces/devc-tools/devc-bridge` unless noted.

### A. Agent-testable (in-container)

The real `caffeinate` script is macOS-only, so §A uses a stub commands dir: a
`caffeinate` stub with `toggle`-style marker semantics (`start` →
`: > "$DEVC_BRIDGE_STATE/caffeinate"` + append `start` to an invocation log;
`stop` → remove marker + append `stop`) — the invocation log is what lets tests
assert no-double-start. The log file must live **outside** `$DEVC_BRIDGE_STATE`
(e.g. `$(dirname "$DEVC_BRIDGE_STATE")/caffeinate-invocations.log`), since a
file inside `state/` is read by `scanActive()` as an active marker and would
break the A5/regression checks.

Extend the existing §A setup snippet (`docs/testing.md`'s "1. Start the
headless server") with `export DEVC_BRIDGE_KEEPAWAKE_IDLE_MS=1500`.

- [x] `deno check host/main.ts` passes; `deno fmt --check` and `deno lint` are
      clean (run in `host/`).
- [x] Ping round-trip: `client ping PostToolUse` → `pong`, exit 0; response
      shape identical to `client echo`'s.
- [x] Ping starts: marker `caffeinate` appears; invocation log shows exactly
      one `start`.
- [x] No double-start: two more pings while active → still exactly one `start`
      in the log.
- [x] Expiry stops: ~1.5s after the last ping the marker is gone and the log
      shows one `stop`.
- [x] Re-arm: ping again after expiry → marker returns, log shows a second
      `start`.
- [x] Ping gap reset: ping, wait 1s, ping, wait 1s → still active (no `stop`
      yet), then silence → stops. This is the core behavior — the timer resets
      rather than accumulating.
- [x] Unauthorized: wrong-token `ping` → `unauthorized`, marker does NOT
      appear.
- [x] `close()` stops: with the keepalive armed, SIGTERM the server → marker
      removed, log shows `stop` (proves the await, not just the intent).
- [x] No keepalive configured: serve without the env vars → `client ping`
      falls through to `unknown command: ping`.
- [x] Regression: full existing §A table (A1–A5, AUTH) still passes unchanged.

### B. User-only (host, macOS + GUI)

- [ ] Real caffeinate: `devc-bridge ping PostToolUse` from the container →
      `pmset -g assertions` shows the assertion; tray flips ○→●.
- [ ] Idle stop: stop pinging → assertion and marker gone ~5 min later; tray
      returns to ○.
- [ ] Quit while armed: Quit the tray mid-keepalive → `pmset -g assertions` no
      longer shows caffeinate (no leak).
- [ ] `devc-bridge status` still reports `— active: caffeinate` while armed
      (unchanged code path — confirms nothing regressed).
- [ ] Real hook: with the README snippet installed in the container's Claude
      `settings.json`, run a short Claude session — the assertion appears on
      the first tool call and clears ~5 min after the session goes quiet.

## Relevant Files

| File                       | Change                                                                       |
| -------------------------- | ---------------------------------------------------------------------------- |
| `host/keepawake.ts`        | **New** — ping/idle state machine (~40 lines; contract above).               |
| `host/core.ts`             | Keepalive wiring, `ping` intercept, `RunningServer.keepawake()`, async close. |
| `host/config.ts`           | `Config.keepawake` from two env vars.                                        |
| `host/serve.ts`            | Env-driven keepalive opts for §A; await close in both signal handlers.       |
| `host/tray.ts`             | `shutdown` becomes async + awaits close. Nothing else.                       |
| `README.md`                | Ping hook snippet, reserved name, env vars, adoption + timeout guidance.     |
| `docs/testing.md`          | New §A/§B rows.                                                              |
| `host/main.ts`             | **No change.**                                                               |
| `client/devc-bridge.ts`    | **No change** (response shape is unchanged).                                 |
| `host/commands/caffeinate` | **No change** (keepalive drives it as-is).                                   |
