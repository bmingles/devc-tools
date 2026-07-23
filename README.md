# Devcontainer Tools

A tiny bridge that lets a **devcontainer** invoke allowlisted commands on the **host**
— so, for example, Claude Code hooks running inside a container can `caffeinate` the
host Mac while a session is active.

A Deno Desktop menu-bar icon (Deno 2.9+ `Deno.Tray`) shows whether anything is
currently active (e.g. the Mac is being kept awake) vs. idle.

```
Host (macOS)                                    Devcontainer
────────────────────────────                   ───────────────────────
deno desktop host/server.ts
  ├─ TCP 127.0.0.1:48227 ◄── host.docker.internal ──  devc-host <name> [args…]
  │      (token-authorized)                             │  reads token from
  ├─ runs ~/.config/devc-tools/commands/<name> <args…>          │  /run/devc-host/token
  │      (argv, never a shell string)                   ▲  (bind mount)
  ├─ writes token → ~/.config/devc-tools/run/token ──── bind mount ──┘
  ├─ watches ~/.config/devc-tools/state/ ──► tray
  └─ menu-bar icon: idle ○ / active ●
```

### Why TCP and not a bind-mounted unix socket?

A bind-mounted AF_UNIX socket **does not cross the Docker Desktop VM boundary**: the
container sees the socket inode but `connect()` is refused, because a unix socket needs
both endpoints in the same kernel and the mount only shares the inode. So the server
listens on host loopback TCP, and the container reaches it via `host.docker.internal`.
A **shared token** — written by the server into the bind-mounted run dir (regular files
*do* cross the mount) and read by the client — authorizes requests, so the loopback
port isn't open to every process on the box. (On OrbStack, unix-over-mount reportedly
works; we target Docker Desktop.)

## How it works

- **Server** (`host/server.ts`, run with `deno desktop`) listens on loopback TCP and
  watches a state directory. It runs as a **menu-bar-only accessory app** — no dock icon
  and no window (`deno desktop` always creates an implicit webview window; `server.ts`
  hides the dock, adopts that window, points it at a blank URL, and hides it).
  `host/core.ts` holds all the transport/dispatch logic and runs headless too
  (`host/serve.ts`).
- **Client** (`client/devc-host.ts`, compiled to `devc-host`) runs in the container,
  reads the token, sends one JSON request, prints the script's output, and exits with
  its exit code.
- **Commands** are executable files in `~/.config/devc-tools/commands/` (seeded from
  `host/commands/`). **The filename is the allowlist** — the container can only invoke
  names that exist there, and it cannot read or edit the scripts (they are not mounted).

Protocol (newline-delimited JSON):

```
→ {"token":"…","command":"caffeinate","args":["start"]}
← {"ok":true,"exitCode":0,"stdout":"started\n","stderr":""}
← {"ok":false,"error":"unknown command: foo"}
← {"ok":false,"error":"unauthorized"}
```

Testing steps (in-container §A + host §B) live in [`docs/testing.md`](docs/testing.md).

## Security / trust boundary

⚠️ This is a **deliberate hole in container isolation**. Anything running in the
container can invoke any script in `host/commands/`, which runs on the host with your
user's privileges. Treat those scripts as the security surface: keep them few, simple,
and reviewed. Injection is not a concern for *arguments* — they are passed as `argv`,
never interpolated into a shell — but a malicious or buggy script is still a malicious
or buggy script running on your host.

The bridge listens on host **loopback** TCP and requires a **token** (written to
`~/.config/devc-tools/run/token`, shared with the container via the bind mount). This keeps
other containers that never mounted the run dir from invoking commands, but anything
that can read that token file — i.e. anything with access to your home dir — can. It is
a convenience boundary for a single-user machine, not a hardened multi-tenant control.

## Setup (macOS host)

Requires Deno 2.9+ on the host.

```sh
# 1. Create the run dir the container mounts (must exist before container start) and
#    seed the command scripts to a stable host path (symlink keeps the repo authoritative)
mkdir -p ~/.config/devc-tools/run
ln -sfn "$PWD/host/commands" ~/.config/devc-tools/commands

# 2. Start the host server (menu-bar app). It writes ~/.config/devc-tools/run/token on startup.
cd host && deno task dev          # or: deno task build  → DevcHost.app

# 3. (Re)open the devcontainer. Its post-create step compiles `devc-host` onto PATH.
```

Container wiring lives in `.devc/` for this repo's devcontainer tool: `.devc/devc.json`
adds the run-dir bind mount and sets `DEVC_HOST_ADDR` / `DEVC_HOST_TOKEN_FILE`, and
`.devc/devc-postcreate.sh` builds/installs the `devc-host` binary. If you use plain Dev
Containers instead, put the equivalent `mounts` + `containerEnv` + `postCreateCommand`
in `.devcontainer/devcontainer.json`.

Port and bind host are configurable via `DEVC_HOST_PORT` (default `48227`) and
`DEVC_HOST_HOST` (default `127.0.0.1`); if `host.docker.internal` can't reach loopback
in your setup, set `DEVC_HOST_HOST=0.0.0.0` (the token still guards access).

Then, from inside the container:

```sh
devc-host caffeinate start    # keep the Mac awake
devc-host caffeinate status   # -> running
devc-host caffeinate stop
```

## Wiring into Claude Code hooks

Have hooks call the client. Example `settings.json` (adjust events to taste):

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "devc-host caffeinate start" }] }
    ],
    "SessionEnd": [
      { "hooks": [{ "type": "command", "command": "devc-host caffeinate stop" }] }
    ]
  }
}
```

## Writing a command

Drop an executable script in `host/commands/`. Its filename becomes the command name.
For anything long-running that the tray should reflect, create a marker file in
`$DEVC_HOST_STATE` while active and remove it when done — see `host/commands/caffeinate`
and `host/commands/toggle` for the pattern.

### Backgrounding a long-running process

A command should **return promptly** — the client blocks until it does. If you start a
long-running process, **detach its stdio** or the call hangs: the bridge reads the
script's output until EOF, and a backgrounded child inherits (and holds open) those
pipes for its entire life, so `output()` never sees EOF until the child exits.

```bash
caffeinate -dimsu </dev/null >/dev/null 2>&1 &   # detached — script returns now
caffeinate -dimsu &                              # WRONG — client hangs until caffeinate dies
```

Record its PID (e.g. in a `$DEVC_HOST_STATE` marker) so a later `stop` can kill it.

### The script's contract

The bridge guarantees a command script exactly two things:

1. **Args arrive as separate `argv` elements** — properly delimited, never re-parsed by
   a shell. No injection, no word-splitting surprises.
2. **The program that ran is one the host put in `commands/`** — the container cannot
   substitute a different binary.

Everything past that is the script's responsibility. From the script's point of view,
`"$@"` is **untrusted and arbitrary**: any count, any values, any order, values that may
look like flags. Escaping is handled *for* the script; **meaning is not**. The script is
the only layer that understands its command's semantics, so it is the only layer that can
reject a dangerous-but-well-formed request.

### Safe arg handling — opt in, don't forward

Treat args as a small, explicit vocabulary and *construct* the real command line yourself.
Never relay `"$@"` to a powerful binary — that exposes the binary's own destructive flags
(`--delete`, `-f`, `--exec`, …) to the container.

```bash
# BEST — fixed verb enum; args select behavior, never supply flags
case "${1:-status}" in
  start) caffeinate -dimsu & ... ;;
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

- **Quote every expansion** (`"$1"`, `"$@"`); never pass args to `eval` / `sh -c` / backticks.
- **Prefer a `case` verb enum**; it sidesteps both destructive flags and flag injection.
- **If a value must pass through, validate its shape** and place it in a fixed argument
  position; use `--` to stop option parsing for operands that could start with `-`.
- **Validate/confine paths** — argv-safety stops shell injection, not path traversal.

The bridge deliberately does not filter args (e.g. no global "reject `-…`" rule): it can't
know any command's semantics, and a false sense of safety is worse than none. Per-command
validation is the honest boundary.

### Three nested allowlists

The request picks the **command** (host-defined — the filenames in the commands dir); the
script picks the **behavior** (its verb enum); any free value is **shape-validated data**,
never a flag. And the backdrop for all of it: everything runs as your host user, so keep
the scripts few and simple.

## Layout

| Path | Role |
| --- | --- |
| `host/core.ts` | Headless TCP server + dispatch + state watcher |
| `host/serve.ts` | Headless entrypoint (no tray) — used for testing |
| `host/server.ts` | Desktop entrypoint — wraps core + menu-bar tray |
| `host/token.ts` | Generate/persist the shared token |
| `host/commands/` | Allowlisted, editable host scripts (seeded to `~/.config/devc-tools/commands`) |
| `client/devc-host.ts` | Container client CLI |
| `.devc/` | Devcontainer tool config: run-dir bind-mount + env + client install |
| `icons/` | Source PNGs for the app icon + the tray icons (embedded in `server.ts`) |
