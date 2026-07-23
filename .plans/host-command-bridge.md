# Host Command Bridge — Unix Socket + Deno Desktop Tray

## Context

We want a devcontainer to trigger commands on the **host** (e.g. macOS `caffeinate`)
so Claude Code hooks can keep the Mac awake, run notifications, etc. Containers are
isolated from the host by design, so we punch one deliberate, narrow hole:

- A **host server** (Deno) listens on a **unix socket**.
- The socket is **bind-mounted** into the devcontainer.
- A **container client** CLI writes a request to the socket; the server runs a
  matching **host-side shell script** and returns the result.

Design constraints (confirmed with the user):

- **No arbitrary shell.** The server only runs editable scripts that live in a
  host-side `commands/` directory — the filename *is* the allowlist. Args are
  passed as `argv` (never interpolated into a shell string), so command injection
  is structurally impossible regardless of what the client sends.
- **Just make it invokable** with ≥1 parameter (`start`/`stop`/`status`). No hook
  lifecycle is built now — we ship an example script + doc snippet only.
- **Prove the bind-mounted socket round-trip FIRST.** On macOS + Docker Desktop,
  forwarding a host unix socket across the VM boundary is the #1 risk. Validation
  step 1 is the go/no-go gate; if it fails we stop and reconsider transport (TCP
  via `host.docker.internal`) before building anything else.

**Bonus verified:** Deno 2.9's `Deno.Tray` (run via `deno desktop main.ts`) puts an
icon in the macOS menu bar with a menu + click events and supports swapping the icon
at runtime — perfect for an idle-vs-active visual cue. Confirmed via `deno desktop
--help` locally (Deno 2.9.2 installed) and the Deno docs.

## Architecture

```
Host (macOS)                                  Devcontainer (Linux)
───────────────────────────────              ──────────────────────────
deno desktop host/server.ts
  ├─ listens: ~/.config/devc-tools/run/devc.sock ◄──bind mount──►  /run/devc-host/devc.sock
  ├─ dispatch: runs host/commands/<name> <args…>            ▲
  │            (Deno.Command, argv array, NO shell)         │
  ├─ watches: ~/.config/devc-tools/state/  (Deno.watchFs)     devc-host <name> [args…]
  │            → repaints tray icon idle/active            (client CLI)
  └─ tray: menu-bar icon + menu (active list, Quit)
```

**Request/response protocol** — one newline-terminated JSON object each way:

- Request:  `{"command":"caffeinate","args":["start"]}`
- Response: `{"ok":true,"exitCode":0,"stdout":"…","stderr":"…"}`
- Error:    `{"ok":false,"error":"unknown command: foo"}`  (client exits non-zero)

**Command name validation (server):** must match `^[A-Za-z0-9._-]+$` (rejects `/`
and `..`), resolve to a regular, executable file inside `commands/`, else `ok:false`.
Execution: `new Deno.Command(path, { args, env, stdout:"piped", stderr:"piped" })`.

**Tray state, script-owned (decoupled):** the server does NOT hold long-running
children. Each command script owns its own lifecycle and drops a marker file in the
state dir (`start` → write pidfile, `stop` → remove it). The server `Deno.watchFs`
the state dir: ≥1 marker → `active.png` + tooltip lists active commands; none →
`idle.png`. The server passes `DEVC_HOST_STATE` in the script env so scripts know
where to write.

**Trust boundary (document in README):** anything running in the container can invoke
any script in `commands/`. The scripts are the security surface — keep them reviewed
and minimal. The container is NOT given access to `commands/` or `state/` (only the
socket dir is mounted), so it can invoke scripts but not edit them.

## Filesystem layout

Host-only (created once; server `mkdir -p`s state/run on start):
- `~/.config/devc-tools/run/devc.sock`  ← the only thing bind-mounted
- `~/.config/devc-tools/state/`         ← markers, watched by tray

Repo:
```
host/
  server.ts            # Deno Desktop app: unix socket server + dispatch + tray
  deno.json            # tasks (dev/build) + `desktop` config block
  commands/
    echo               # trivial, for the round-trip smoke test
    caffeinate         # example: start|stop|status, writes state marker
client/
  devc-host.ts         # container CLI: connect, send JSON, print, propagate exit code
  deno.json
icons/
  idle.png             # 22×22 template (opaque silhouette), tray idle
  active.png           # 22×22 template, ≥1 command active
  app.png              # app/dock icon for the built bundle
.devcontainer/
  devcontainer.json    # bind-mount socket dir + install client on PATH
README.md              # setup, trust-boundary warning, hook wiring example
```

## Example scripts (exact shape)

`host/commands/echo` — smoke test, no state:
```sh
#!/usr/bin/env bash
echo "echo: $*"
```

`host/commands/caffeinate` — start/stop/status, pidfile marker in state dir:
```sh
#!/usr/bin/env bash
set -euo pipefail
STATE_DIR="${DEVC_HOST_STATE:-$HOME/.config/devc-tools/state}"
mkdir -p "$STATE_DIR"
PIDFILE="$STATE_DIR/caffeinate"
case "${1:-status}" in
  start)
    if [[ -f "$PIDFILE" ]] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
      echo "already running"; exit 0; fi
    caffeinate -dimsu & echo $! > "$PIDFILE"; echo "started" ;;
  stop)
    [[ -f "$PIDFILE" ]] && { kill "$(cat "$PIDFILE")" 2>/dev/null || true; rm -f "$PIDFILE"; }
    echo "stopped" ;;
  status)
    if [[ -f "$PIDFILE" ]] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then echo "running";
    else echo "stopped"; rm -f "$PIDFILE" 2>/dev/null || true; fi ;;
  *) echo "usage: caffeinate {start|stop|status}" >&2; exit 2 ;;
esac
```
Presence of `$STATE_DIR/caffeinate` = the tray "active" marker. Args reach the script
as positional `$1…`; the script must quote `"$@"`.

## Permission flags (bake into `deno desktop`, same as `deno run`)

- Server: `--allow-read=<home>/.config/devc-tools,<repo>/host/commands,<repo>/icons`
  `--allow-write=<home>/.config/devc-tools` `--allow-run` (runs only allowlisted files)
  `--allow-env`. Unix listen is gated by read/write on the socket path; if 2.9 still
  gates unix transport behind unstable, add `--unstable-net` (confirm in validation).
- Client: `--allow-read=<sock> --allow-write=<sock>` (or compiled with these baked in).

## Checklist

- [x] `host/core.ts`: **headless** core — unix socket listener
      (`Deno.listen({ transport:"unix", path })`), JSON line framing, accept loop,
      dispatch, and state-watch that emits an active-set change callback. No tray, no
      `deno desktop` — runnable via plain `deno run` so the agent can test it
      in-container (§A). Config (socket path, commands dir, state dir) via args/env.
- [ ] `host/serve.ts`: thin headless entrypoint that runs `core.ts` and logs
      active-set changes to stdout — the target for the §A in-container experiment.
- [ ] Dispatch: name validation + allowlist-by-file-existence + `Deno.Command` with
      `argv` (no shell), capture stdout/stderr/exitCode into response.
- [ ] `host/server.ts`: Deno **desktop** entrypoint — imports `core.ts`, adds the tray:
      load icon bytes, `new Deno.Tray()`, `setIcon`/`setTooltip`/`setMenu`,
      `menuclick` for Quit + "Open commands folder", initial idle state. Subscribes to
      core's active-set callback to repaint icon/tooltip/menu.
- [x] State watcher lives in `core.ts`: `Deno.watchFs(stateDir)` → recompute active set
      → invoke callback. `mkdir -p` run+state dirs on startup.
- [x] `host/commands/echo`, `host/commands/caffeinate`, `host/commands/toggle`.
- [x] `client/devc-host.ts`: read socket path from `DEVC_HOST_SOCKET`
      (default `/run/devc-host/devc.sock`), `Deno.connect({transport:"unix"})`,
      send `{command, args}`, print stdout/stderr, exit with server's exitCode.
- [x] `deno.json` tasks: host `dev`/`build`/`serve`; client `build` (`deno compile` →
      `devc-host` binary) / `run`.
- [x] `.devcontainer/devcontainer.json`: mount
      `source=${localEnv:HOME}/.config/devc-tools/run,target=/run/devc-host,type=bind`;
      `postCreateCommand` compiles/installs `devc-host` to `/usr/local/bin`.
- [x] Icons: three template PNGs (22×22 idle ring / active disc, 256×256 app).
- [x] `README.md`: prerequisites, run instructions, trust-boundary warning, example
      Claude hook snippet calling `devc-host caffeinate start` / `stop`.
- [x] `.gitignore` for build artifacts (`client/devc-host`, `host/DevcHost.app`).

**Deviations from plan (found during validation):**
- **TRANSPORT PIVOT (the §B1 gate failed as anticipated).** A bind-mounted AF_UNIX
  socket does **not** cross the Docker Desktop VM boundary: on the host, connecting to
  the socket works (`nc -U` gets a reply), but from the container `connect()` returns
  `ECONNREFUSED` — the mount shares the inode, not the listening endpoint. Pivoted to
  **loopback TCP + shared token**: server listens on `127.0.0.1:48227`, container reaches
  it via `host.docker.internal`, and a token written to the bind-mounted run dir
  (regular files cross the mount fine) authorizes requests (`{token,command,args}`;
  mismatch → `unauthorized`). New file `host/token.ts`. Env: `DEVC_HOST_ADDR`,
  `DEVC_HOST_TOKEN_FILE`, `DEVC_HOST_HOST`, `DEVC_HOST_PORT`. Everything else (dispatch,
  scripts, state-watch, tray) unchanged. Re-verified §A over TCP loopback: 12/12 incl. a
  new bad-token → `unauthorized` check. (OrbStack reportedly forwards unix sockets; we
  target Docker Desktop.)
- Deno gates socket `Deno.listen`/`connect` behind **`--allow-net`**, NOT
  `--allow-read`/`--allow-write` (found while still on unix; applies to TCP too).
- `deno desktop` runs the entrypoint from a **temp dir**, so paths relative to
  `import.meta.url` fail (`.../T/…` not found). This bit both icons and commands:
  - Tray PNGs are **embedded as base64 in `server.ts`** (`icons/*.png` stay the source
    of truth + the build-time `--icon` app icon; regenerate with `base64 -w0 icons/idle.png`).
  - Command scripts **can't** be embedded (host-editable by design), so the server reads
    them from a stable absolute path — default `~/.config/devc-tools/commands`, seeded from the
    repo (`ln -sfn "$PWD/host/commands" ~/.config/devc-tools/commands`). This was the cause of the
    observed `unknown command: echo` — the default resolved into the empty temp bundle dir.
- Container wiring is provided by the repo's **devc tool** in `.devc/` (`devc.json`
  mount + env, `devc-postcreate.sh` client install), not `.devcontainer/devcontainer.json`.

## Validation

The agent runs entirely inside the devcontainer, so it **cannot** test the real
host→container flow (no macOS host, no GUI, no cross-VM bind-mount). Validation is
split into what the agent can prove in-container vs. what only the user can verify on
the host. The tray and dispatch logic are decoupled precisely so the socket/protocol
layer is testable without a host.

### A. Agent-testable — in-container client+server experiment

Run the server and client **in the same devcontainer** over loopback TCP + token
(no `host.docker.internal`, no tray, no `deno desktop`). Server is launched as a
headless `deno run` for these tests. This proves the protocol, token auth, dispatch,
allowlist, and injection-safety logic:

All §A checks passed (verified with `deno run` server + both `deno run` and the
**compiled** `devc-host` binary). 13/13 in the assertion suite green.

- [x] **A1. Round-trip.** `devc-host echo hello` → `echo: hello`, exit 0.
- [x] **A2. Dispatch + args.** `echo a b c` → `echo: a b c`; `toggle badarg` propagates
      exit 2; stdout/stderr separated (usage went to stderr, stdout empty).
- [x] **A3. Injection safety.** `echo '; touch /tmp/pwned; #'` printed literally;
      `/tmp/pwned` NOT created — confirms argv (not shell) exec.
- [x] **A4. Allowlist.** `nope` → `unknown command`; `../serve.ts` and `a b` →
      `invalid command name`; all exit 1, nothing ran.
- [x] **A5. State watcher.** `toggle on`/`off` drove the server's active set
      `[]` → `["toggle"]` → `[]` (observed in the `active:` log) — the tray's data source.

### B. User-only — host verification (macOS, requires GUI + Docker Desktop)

- [x] **B1. Transport gate.** `devc-host echo hello` in the container → `echo: hello`,
      over token-authorized TCP via `host.docker.internal`. Confirms the pivot works
      across the Docker Desktop boundary.
- [ ] **B2. Caffeinate.** `devc-host caffeinate start` → `pmset -g assertions` shows a
      caffeinate assertion + `state/caffeinate` marker; `status` → `running`; `stop`
      clears both.
- [x] **B3. Tray visual + dispatch + state.** `devc-host toggle on` flipped the menu-bar
      icon ○ → ● (and created `state/toggle`); `toggle off` reverted it. Confirms
      `Deno.Tray`, dispatch, and the state watcher end to end.
- [ ] **B4. Bundle.** `deno task build` produces `DevcHost.app` that behaves the same
      when double-clicked.

## Relevant Files (all new — greenfield repo)

- `host/core.ts` — headless TCP server, dispatch, token check, state watcher (agent-testable)
- `host/token.ts` — generate/persist the shared token
- `host/serve.ts` — headless entrypoint for the in-container §A experiment
- `host/server.ts` — desktop entrypoint: wraps core + tray
- `host/deno.json` — dev/build tasks + `desktop` config block
- `host/commands/echo`, `host/commands/caffeinate` — example allowlisted scripts
- `client/devc-host.ts` — container client CLI
- `client/deno.json` — client build task
- `.devc/devc.json` + `.devc/devc-postcreate.sh` — socket bind-mount + client install
- `icons/idle.png`, `icons/active.png`, `icons/app.png` — tray/app icons
- `README.md` — setup, trust-boundary warning, hook wiring example
