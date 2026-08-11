# devc-bridge

A tiny bridge that lets a **devcontainer** invoke allowlisted commands on the
**host** — so, for example, Claude Code hooks running inside a container can
`caffeinate` the host Mac while a session is active.

A Deno Desktop menu-bar icon (Deno 2.9+ `Deno.Tray`) shows whether anything is
currently active (e.g. the Mac is being kept awake) vs. idle.

```
Host (macOS)                                             Devcontainer
──────────────────────────────────────────────           ────────────────────────────
devc-bridge start   (background menu-bar app)
  ├─ TCP 127.0.0.1:48227 ◄── host.docker.internal ────── devc-bridge <name> [args…]
  │      (token-authorized)                           │  reads token from
  ├─ runs ~/.config/devc-bridge/commands/<name>       │  /run/devc-bridge/token
  │      (args as argv, never a shell string)         ▲  (bind mount)
  ├─ writes token → ~/.config/devc-bridge/run/token ──┘
  ├─ watches ~/.config/devc-bridge/state/ ──► tray
  └─ menu-bar icon: idle ○ / active ●
```

## Commands

Two separate command surfaces share the `devc-bridge` name — one you run on
the **host** to manage the background service, one you run **inside the
container** to invoke an allowlisted host script.

### Host — manage the background service

Run these on the host, outside any container:

| Command               | Does                                                                               |
| --------------------- | ---------------------------------------------------------------------------------- |
| `devc-bridge start`   | Seed `~/.config/devc-bridge/` on first run, then launch the tray in the background |
| `devc-bridge status`  | `running (pid N)` — idle \| active: … — or `stopped`, plus a `client:` line        |
| `devc-bridge stop`    | Stop the background tray                                                           |
| `devc-bridge restart` | `stop` + `start`                                                                   |

### Container — invoke a host command

Run these inside the devcontainer, as `devc-bridge <command> [args...]`. Out
of the box:

| Command                          | Does                                                                                                                                                                                                                                                  |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ping [label]`                   | **The normal way to keep the host awake.** Reserved builtin — records activity and starts/stops `caffeinate` for you on an idle timeout. Wire it into hooks per [Wiring into Claude Code hooks](#wiring-into-claude-code-hooks) and forget it exists. |
| `caffeinate start\|stop\|status` | The keepalive's own on/off switch, exposed directly (macOS-only; runs the real `caffeinate(8)`). Manual/advanced use only — see below.                                                                                                                |
| `echo <args...>`                 | Round-trip smoke test — echoes args back                                                                                                                                                                                                              |
| `toggle on\|off`                 | Demo command that flips a state marker (exercises the tray without needing macOS)                                                                                                                                                                     |

**In normal use you never call `caffeinate` yourself** — `ping` drives it
automatically once it's wired into hooks. Reach for `caffeinate start`/`stop`/
`status` directly only to force the Mac awake outside of any hook activity, or
to debug/inspect state by hand. See [Wiring into Claude Code hooks](#wiring-into-claude-code-hooks)
for how the two interact (adoption, manual-stop-wins, etc.).

These are plain executable scripts in `~/.config/devc-bridge/commands/`
(seeded from `host/commands/` on first `start`, yours to edit) — `ping` is the
one exception, a builtin handled by the server itself, not a script. See
[Writing a command](#writing-a-command) to add your own.

> **Seeding never clobbers.** A script that already exists in
> `~/.config/devc-bridge/commands/` is left alone on every later `start`, so
> changes to `host/commands/` do **not** reach an existing install — edit the
> copy under `~/.config/devc-bridge/commands/`, or delete it and restart to
> re-seed.

### Why `caffeinate -dims`

`-i` is what actually keeps a session alive: no idle system sleep means the CPU
keeps running, Wi-Fi stays associated, and a VPN tunnel survives. `-d` is kept
because a display that never sleeps generally never triggers the display-sleep
screen lock, which some VPN clients drop on. `-s` is documented as valid only on
AC power, so on battery `-i` carries the load; `-m` is near-inert on SSD-only
Macs. Both are harmless.

`-u` is deliberately **not** used. It declares user activity and _wakes the
display if it's off_ — the keepalive arms on a session's first hook ping, so
`-u` would light up a screen you had let sleep. It is also redundant with `-d`,
and with no `-t` its assertion defaults to 5 seconds.

No flag combination survives closing the lid: clamshell sleep needs external
power _and_ an external display to avoid. Verify what is held with
`pmset -g assertions | grep -i caffeinate`.

## Setup (macOS host)

Build the `devc-bridge` binary once (requires Deno 2.9+), then it is
self-contained — no config dir or command files to create by hand.

```sh
# 1. Build the host tool and put it on PATH (Deno 2.9+ needed only for this step).
cd devc-bridge/host && deno task build  # → ./devc-bridge (command scripts embedded)
install devc-bridge /usr/local/bin/     # or move it anywhere on your PATH

# 2. Start it in the background. First run auto-creates ~/.config/devc-bridge/ (run/,
#    state/, commands/, client/), seeds the example command scripts, and writes the token.
devc-bridge start                   # menu-bar icon appears (idle ○)
devc-bridge status                  # -> running (pid N) / client: installed

# 3. Install the Linux client into the dir devc mounts (see "The container client" below).
cd ../client && deno task build:client

# 4. `devc up` any repo. The client is already on PATH inside.
```

(See [Commands](#commands) above for the full `start`/`stop`/`status`/`restart`
lifecycle CLI.)

To skip the build entirely, source the repo's shell integration instead — it
defines a `devc-bridge` function that runs `host/main.ts` from source via Deno:

```sh
source /path/to/devc-tools/scripts/bash_aliases.sh   # add this to ~/.bashrc
```

(`start` still builds the tray `.app` bundle itself, since a menu-bar app must
be launched via LaunchServices; Deno caches that compile.)

Command scripts are seeded to `~/.config/devc-bridge/commands/` on first start
and are **yours to edit** — later starts never overwrite them. To pick up new
example scripts from a rebuilt binary, add them there yourself (or delete the
ones you want re-seeded). During development you can also run the tray in the
foreground with `deno task dev`.

## The container client

The container half is a **devcontainer Feature**, so there is no per-repo
wiring to copy and nothing devc-specific about it. Any project opts in with one
line:

```jsonc
"features": {
  "ghcr.io/bmingles/devc-tools/devc-bridge:0": {}
}
```

The Feature declares two read-only bind mounts (`~/.config/devc-bridge/run` →
`/run/devc-bridge` for the token, `~/.config/devc-bridge/client` →
`/usr/local/share/devc-bridge/client` for the binary) and symlinks
`/usr/local/bin/devc-bridge` at the mounted client. No env vars are needed
either — `DEVC_BRIDGE_ADDR` and `DEVC_BRIDGE_TOKEN_FILE` default to exactly the
address and mount target it sets up (see [Commands](#commands)); set them only
to override. See [its README](../features/devc-bridge/README.md) for the full
rationale, including why the mounts must stay JSON _strings_ and why Docker
Compose devcontainers are unsupported.

[devc](../devc/README.md#devc-bridge-the-feature) containers reference that same
Feature from devc's bundled config, so every devc container has the bridge
already — one mechanism, not two.

**Install the host bridge before adding the Feature.** A Feature has no
host-side hook, so it cannot create its own mount sources, and
`--mount type=bind` errors on a missing source: a standalone project adding the
Feature on a host with no `~/.config/devc-bridge/` fails to build. devc
containers are the exception — devc's own `initializeCommand` creates the dirs
and a placeholder client, so they stay inert instead.

**The client is installed, not built on the fly.** `devc-bridge start` never
compiles one. `~/.config/devc-bridge/client/devc-bridge` is a plain destination
that two paths write to:

| Path         | How                                                                   |
| ------------ | --------------------------------------------------------------------- |
| Typical user | The release installer drops the prebuilt Linux client there           |
| Developer    | `cd client && deno task build:client` cross-compiles to the same path |

Both **overwrite unconditionally** — note the asymmetry with
`~/.config/devc-bridge/commands/`, which is yours to edit and is never
clobbered. The binary is not user-owned: it is a build artifact with a fixed
name, and a stale one is a bug rather than a customization.

The cross-compile target follows the **host** arch (`arm64` →
`aarch64-unknown-linux-gnu`, `x86_64` → `x86_64-unknown-linux-gnu`), since
Docker Desktop runs containers matching the host by default. A container
deliberately run under emulation on the other arch is out of scope — rebuild
with `DEVC_BRIDGE_CLIENT_TARGET` set if you need that.

Because the mount is a live _directory_ mount and the symlink is made
unconditionally, installing the client while a container is already running is
enough: the link resolves on the next invocation, with no rebuild and nothing to
re-run inside. Until then, devc's placeholder makes the gap legible — the
container prints `devc-bridge: no client binary …` and exits 127, and
`devc-bridge status` on the host reports `client: not installed (placeholder)`.
(A standalone Feature project never reaches that state: with no placeholder to
mount, it fails at create instead.)

> **Upgrading from per-repo wiring:** if you previously added the run-dir mount
> to a `devc.json` overlay, copied the two bridge mounts into a project's
> `devcontainer.json`, or installed the client from a
> `.devc/devc-post-create.sh`, **remove all of it**. Mounts colliding with the
> Feature's are not deduped and Docker fails the create with
> `Duplicate mount point`.

### Developing the client

Work on `client/devc-bridge.ts` through `deno task build:client` (or run the
host side from source via `source scripts/bash_aliases.sh`). A compiled host
binary has **no connection to the working tree**: once the container's client
comes from the mount, editing the source and restarting silently keeps running
the previously built client. This matches how the tray already behaves, and
keeps one answer to "where did this binary come from".

Port and bind host are configurable via `DEVC_BRIDGE_PORT` (default `48227`) and
`DEVC_BRIDGE_HOST` (default `127.0.0.1`); if `host.docker.internal` can't reach
loopback in your setup, set `DEVC_BRIDGE_HOST=0.0.0.0` (the token still guards
access).

Verify the container can reach the bridge: `devc-bridge ping test` should
print `pong` (see [Commands](#commands) for the rest of the container CLI).

## Wiring into Claude Code hooks

The bridge keeps the host awake **activity-driven**: a hook fires on every tool
call and pings the bridge — "Claude is still working" — and the host starts
`caffeinate` on the first ping and stops it after a period of silence. Example
`settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "devc-bridge ping PreToolUse >/dev/null 2>&1 || true"
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "devc-bridge ping PostToolUse >/dev/null 2>&1 || true"
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "devc-bridge ping UserPromptSubmit >/dev/null 2>&1 || true"
          }
        ]
      }
    ]
  }
}
```

The `|| true` + redirection are load-bearing: a down/unreachable bridge must
never fail the hook or leak noise into Claude's transcript.

The `ping` builtin (see [Commands](#commands)) is intercepted server-side
before script dispatch and returns `pong` immediately, without blocking on the
`caffeinate` dispatch — so hook latency is unaffected. `args[0]`, when
present, is a free-form diagnostic label (e.g. the hook event name); it never
affects the keepalive's behavior.

Keepalive policy — when to start/stop `caffeinate` — is controlled by two env
vars on the **host**:

| Env var                         | Default      | Notes                          |
| ------------------------------- | ------------ | ------------------------------ |
| `DEVC_BRIDGE_KEEPAWAKE_COMMAND` | `caffeinate` | resolved through the allowlist |
| `DEVC_BRIDGE_KEEPAWAKE_IDLE_MS` | `300000`     | non-numeric/≤0 → default       |

**Set these on `devc-bridge start`, and restart to apply:**

```sh
DEVC_BRIDGE_KEEPAWAKE_IDLE_MS=1200000 devc-bridge restart   # 20 min, for long builds
DEVC_BRIDGE_KEEPAWAKE_IDLE_MS= devc-bridge restart          # empty = back to the default
```

`start` runs in your shell; the tray it launches does not — `open -g` hands off to
LaunchServices, so the app starts under **launchd's** environment. Exporting the
variable and leaving an already-running tray alone therefore does nothing. `start`
bridges the gap by writing whichever of these vars are set in its own env to
`~/.config/devc-bridge/settings.json`, which the tray reads at launch; env wins over
the file, the file wins over the default. The value is read **once**, at launch, so
a change needs a `restart` (plain `start` on a running tray saves the value and says
so, but won't apply it). The same applies to `DEVC_BRIDGE_HOST` and
`DEVC_BRIDGE_PORT`.

**Choosing a value.** The timeout never governs typical commands — every tool call
pings, so the timer resets constantly while a session is active. It only matters in
two moments: a _single_ tool call longer than the timeout (Claude Code caps `Bash` at
10 minutes, so the default covers everything short of a long build), and how long the
Mac stays awake after work stops. Raise it on days you run long builds; the cost is
only idle awake time.

Notes on the semantics:

- **Adoption:** a manual `devc-bridge caffeinate start` with no pings is never
  auto-stopped by the keepalive; the _first_ ping arms the keepalive and hands
  it the lifecycle from then on (`start` is idempotent).
- **Manual stop wins until expiry:** if you run `devc-bridge caffeinate stop`
  while the keepalive is armed, it doesn't fight you — it stays armed until the
  timer expires, then issues a redundant (harmless) `stop`. A manual stop is an
  instruction, and its effect lasting up to the idle timeout is the intended
  reading of it.
- **Timeout guidance:** a hook ping cannot cover the duration of a single tool
  call — a long-running tool fires no pings between its start and its end, and
  a permission prompt fires none at all while Claude waits on the human. The
  idle timeout must exceed the longest plausible **gap between pings** (long
  tool runs, prompt think-time), not just "how fast to notice Claude
  finished." The default (5 minutes) is chosen with that in mind; the cost of
  raising it is a few extra minutes of the Mac staying awake, the cost of
  lowering it too far is the Mac suspending mid-build. See "Choosing a value"
  above for how to change it.
- **Why `PreToolUse` too:** it puts a ping at the _start_ of a tool call, so a
  long build gets the full idle timeout measured from when it began rather than
  from the end of the previous tool. `PostToolUse` alone very nearly does this
  (tools run back to back), but `PreToolUse` makes it exact and costs one extra
  process per tool call.
- **Subagents are covered:** hooks also run inside subagents, so a long `Agent`
  or `Workflow` call pings throughout from its own tool calls rather than going
  silent for its whole duration.
- **A stalled session is safe to let sleep.** Waiting on a permission prompt
  fires no pings, so the Mac may suspend — but the session is already stopped,
  and answering after a wake resumes it no differently. The case worth
  protecting is Claude _actively working_, which the tool-call pings cover.
- **Concurrent sessions** share one keepalive: last-ping-wins is a natural
  refcount — `caffeinate` stops only once _all_ sessions go quiet.
- **Crash robustness:** a container stop or killed session never sends
  `SessionEnd`; because the idle timeout is self-healing, nothing needs to
  explicitly stop `caffeinate`.

An explicit `SessionStart → devc-bridge caffeinate start` hook may still be
layered on for instant-on awake at session start; a `SessionEnd → stop` hook
should be **removed** — the idle timeout is the backstop that makes it
unnecessary (and if you have two sessions sharing the host, the first
session's `SessionEnd` would otherwise kill caffeinate out from under the
second).

## How it works

- **Server** (`devc-bridge`, a single `deno desktop` binary built from
  `host/main.ts`) listens on loopback TCP and watches a state directory.
  `devc-bridge start` launches it **in the background**;
  `stop`/`status`/`restart` manage it. It runs as a **menu-bar-only accessory
  app** — no dock icon and no window. `host/tray.ts` holds the tray,
  `host/core.ts` all the transport/dispatch logic (which also runs headless via
  `host/serve.ts`), and `host/config.ts` resolves paths + seeds the command
  scripts on first start.
- **Client** (`client/devc-bridge.ts`, compiled to `devc-bridge`) runs in the
  container, reads the token, sends one JSON request, prints the script's
  output, and exits with its exit code.
- **Commands** are executable files in `~/.config/devc-bridge/commands/` (seeded
  from `host/commands/`). **The filename is the allowlist** — the container can
  only invoke names that exist there, and it cannot read or edit the scripts
  (they are not mounted).

Protocol (newline-delimited JSON):

```
→ {"token":"…","command":"caffeinate","args":["start"]}
← {"ok":true,"exitCode":0,"stdout":"started\n","stderr":""}
← {"ok":false,"error":"unknown command: foo"}
← {"ok":false,"error":"unauthorized"}
```

### Why TCP and not a bind-mounted unix socket?

A bind-mounted AF_UNIX socket **does not cross the Docker Desktop VM boundary**:
the container sees the socket inode but `connect()` is refused, because a unix
socket needs both endpoints in the same kernel and the mount only shares the
inode. So the server listens on host loopback TCP, and the container reaches it
via `host.docker.internal`. A **shared token** — written by the server into the
bind-mounted run dir (regular files _do_ cross the mount) and read by the client
— authorizes requests, so the loopback port isn't open to every process on the
box. (On OrbStack, unix-over-mount reportedly works; we target Docker Desktop.)

Testing steps (in-container §A + host §B) live in
[`docs/testing.md`](docs/testing.md).

## Security / trust boundary

⚠️ This is a **deliberate hole in container isolation**. Anything running in the
container can invoke any script in `host/commands/`, which runs on the host with
your user's privileges. Treat those scripts as the security surface: keep them
few, simple, and reviewed. Injection is not a concern for _arguments_ — they are
passed as `argv`, never interpolated into a shell — but a malicious or buggy
script is still a malicious or buggy script running on your host.

The bridge listens on host **loopback** TCP and requires a **token** (written to
`~/.config/devc-bridge/run/token`, shared with the container via the bind
mount). This keeps other containers that never mounted the run dir from invoking
commands, but anything that can read that token file — i.e. anything with access
to your home dir — can. It is a convenience boundary for a single-user machine,
not a hardened multi-tenant control.

**Both container mounts are read-only**, and that is load-bearing in each case:

- `run/` carries the token, which the container only ever _reads_ — so read-only
  costs nothing. Writable, a container could rewrite `run/token`: `ensureToken`
  _adopts_ an existing token file rather than regenerating, so it could pin the
  host's shared secret to a value of its choosing across host restarts, and
  deleting the file would no longer rotate it.
- `client/` is executed by every container that has the Feature. Writable, one
  container could rewrite the binary the others run — lateral movement between
  containers, and tampering with host-managed state.

The tray **pidfile lives in `base/`, not in the mounted `run/`** — `stop` reads
it and `Deno.kill`s whatever positive integer it finds, so a container able to
write it could pick the host process that gets SIGTERM. Read-only already closes
that; keeping the file out of the mounted dir is what keeps it closed for Docker
Compose devcontainers, where the Feature's `readonly` does not survive into the
generated compose file. (That is also why the Feature is unsupported there.)

> Pre-release change with no migration: the pidfile moved from
> `run/tray.pid` to `tray.pid`. A tray started before the move writes the old
> path, so a post-move `stop` reports `not running` and leaves it orphaned —
> kill it by hand once.

Because every container with the Feature mounts both dirs, one container's
bridge access is not isolated from another's: they share the token and the
client. That is the same single-user convenience boundary as above, stated at
container scope.

The arch note is a limitation, not a control: the client is cross-compiled for
the host's architecture. A container run under emulation on the other arch will
find a binary it cannot execute.

## Writing a command

Drop an executable script in `host/commands/`. Its filename becomes the command
name. For anything long-running that the tray should reflect, create a marker
file in `$DEVC_BRIDGE_STATE` while active and remove it when done — see
`host/commands/caffeinate` and `host/commands/toggle` for the pattern.

**`ping` is a reserved name.** When the server is configured with keepalive
options (see [Wiring into Claude Code hooks](#wiring-into-claude-code-hooks)),
the `ping` command is a builtin handled by the server itself and shadows any
same-named script in `commands/` — don't put a `ping` script there expecting
it to run.

### Backgrounding a long-running process

A command should **return promptly** — the client blocks until it does. If you
start a long-running process, **detach its stdio** or the call hangs: the bridge
reads the script's output until EOF, and a backgrounded child inherits (and
holds open) those pipes for its entire life, so `output()` never sees EOF until
the child exits.

```bash
caffeinate -dims </dev/null >/dev/null 2>&1 &   # detached — script returns now
caffeinate -dims &                              # WRONG — client hangs until caffeinate dies
```

Record its PID (e.g. in a `$DEVC_BRIDGE_STATE` marker) so a later `stop` can
kill it.

### The script's contract

The bridge guarantees a command script exactly two things:

1. **Args arrive as separate `argv` elements** — properly delimited, never
   re-parsed by a shell. No injection, no word-splitting surprises.
2. **The program that ran is one the host put in `commands/`** — the container
   cannot substitute a different binary.

Everything past that is the script's responsibility. From the script's point of
view, `"$@"` is **untrusted and arbitrary**: any count, any values, any order,
values that may look like flags. Escaping is handled _for_ the script; **meaning
is not**. The script is the only layer that understands its command's semantics,
so it is the only layer that can reject a dangerous-but-well-formed request.

### Safe arg handling — opt in, don't forward

Treat args as a small, explicit vocabulary and _construct_ the real command line
yourself. Never relay `"$@"` to a powerful binary — that exposes the binary's
own destructive flags (`--delete`, `-f`, `--exec`, …) to the container.

```bash
# BEST — fixed verb enum; args select behavior, never supply flags
case "${1:-status}" in
  start) caffeinate -dims & ... ;;
  stop|status) ... ;;
  *) echo "usage: caffeinate {start|stop|status}" >&2; exit 2 ;;
esac

# OK — a free-form value is genuinely needed: validate its SHAPE, pin its position, use --
timeout="$1"
[[ "$timeout" =~ ^[0-9]+$ ]] || { echo "timeout must be an integer" >&2; exit 2; }
caffeinate -t "$timeout"          # container controls a number, not a flag

# BAD — forwards arbitrary flags to a powerful binary
caffeinate "$@"
# BAD — re-introduces a shell interpreter
eval "$1"; bash -c "$1"
# BAD — arg misread as an option (flag injection); guard operands with --
grep "$1" file      →      grep -- "$1" file
```

Rules of thumb:

- **Quote every expansion** (`"$1"`, `"$@"`); never pass args to `eval` /
  `sh -c` / backticks.
- **Prefer a `case` verb enum**; it sidesteps both destructive flags and flag
  injection.
- **If a value must pass through, validate its shape** and place it in a fixed
  argument position; use `--` to stop option parsing for operands that could
  start with `-`.
- **Validate/confine paths** — argv-safety stops shell injection, not path
  traversal.

The bridge deliberately does not filter args (e.g. no global "reject `-…`"
rule): it can't know any command's semantics, and a false sense of safety is
worse than none. Per-command validation is the honest boundary.

### Three nested allowlists

The request picks the **command** (host-defined — the filenames in the commands
dir); the script picks the **behavior** (its verb enum); any free value is
**shape-validated data**, never a flag. And the backdrop for all of it:
everything runs as your host user, so keep the scripts few and simple.

## Layout

Paths are relative to `devc-bridge/` unless noted.

| Path                       | Role                                                                                                                  |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `host/main.ts`             | `devc-bridge` entrypoint — CLI dispatch (`start`/`stop`/`status`/`restart`/`run`)                                     |
| `host/config.ts`           | Path resolution + `ensureConfig`/`seedCommands` (zero-setup on first start)                                           |
| `host/tray.ts`             | Tray layer — wraps core + menu-bar icon (falls back to headless if no GUI)                                            |
| `host/core.ts`             | Headless TCP server + dispatch + state watcher                                                                        |
| `host/serve.ts`            | Headless entrypoint (no tray) — used for testing                                                                      |
| `host/token.ts`            | Generate/persist the shared token                                                                                     |
| `host/commands/`           | Allowlisted host scripts, **embedded** in the binary + seeded to `~/.config/devc-bridge/commands`                     |
| `client/devc-bridge.ts`    | Container client CLI                                                                                                  |
| `client/build-client.sh`   | `deno task build:client` — cross-compile the client into `~/.config/devc-bridge/client/` (dev install)                |
| `../features/devc-bridge/` | The container half as a devcontainer Feature: the two read-only mounts and the PATH symlink                           |
| `../devc/default/`         | devc's side: the Feature reference in `devcontainer.json` and the mount-source placeholder in `initialize-command.sh` |
| `icons/`                   | Source PNGs for the app icon + the tray icons (embedded in `tray.ts`)                                                 |
