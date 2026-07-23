# Testing

Two tiers: **§A** runs entirely inside the devcontainer (no host, no GUI) and is
already automated/verified; **§B** is host-only (macOS + GUI + the devcontainer tool)
and must be run by hand.

Transport is **loopback TCP + a shared token** (a bind-mounted unix socket does not
cross the Docker Desktop VM boundary — see the README). §A exercises this over
`127.0.0.1` inside the container; §B exercises it over `host.docker.internal`.

## §A — In-container (client + server, no host)

Proves the protocol, token auth, dispatch, allowlist, and injection-safety without a
Mac. Run from the repo root inside the devcontainer.

```sh
# 1. Start the headless server on loopback
export DEVC_HOST_HOST=127.0.0.1 DEVC_HOST_PORT=48227
export DEVC_HOST_COMMANDS="$PWD/host/commands"
export DEVC_HOST_STATE=/tmp/devc-host/state
export DEVC_HOST_TOKEN_FILE=/tmp/devc-host/token
rm -rf /tmp/devc-host
deno run --allow-read --allow-write --allow-run --allow-env --allow-net host/serve.ts &

# 2. Client helper (points at the same loopback + token)
export DEVC_HOST_ADDR=127.0.0.1:48227
client() { deno run --allow-read --allow-net --allow-env=DEVC_HOST_ADDR,DEVC_HOST_TOKEN_FILE client/devc-host.ts "$@"; }
```

| Check | Command | Expected |
| --- | --- | --- |
| A1 round-trip | `client echo hello` | `echo: hello`, exit 0 |
| A2 multi-arg | `client echo a b c` | `echo: a b c` |
| A2 exit propagation | `client toggle badarg; echo $?` | usage on stderr, exit `2` |
| A3 injection safety | `client echo '; touch /tmp/pwned; #'` | printed literally; `/tmp/pwned` NOT created |
| A4 unknown command | `client nope; echo $?` | `unknown command: nope`, exit 1 |
| A4 traversal | `client ../serve.ts; echo $?` | `invalid command name`, exit 1 |
| AUTH bad token | `DEVC_HOST_TOKEN_FILE=<file with wrong token> client echo hi` | `unauthorized`, exit 1 |
| A5 state watcher | `client toggle on` then `client toggle off` | server log shows `active: []` → `["toggle"]` → `[]` |

Cleanup: `pkill -f host/serve.ts; rm -rf /tmp/devc-host`.

## §B — Host verification (macOS)

Requires Deno 2.9+ on the host. Run **in order — stop at the first failure.**

```sh
# One-time setup: run dir (mounted) + seed command scripts to a stable path
mkdir -p ~/.config/devc-tools/run
ln -sfn "$PWD/host/commands" ~/.config/devc-tools/commands   # from repo root

# GATE: does the container reach the host bridge over host.docker.internal?
cd host && deno task dev            # menu-bar icon appears (idle ○); writes ~/.config/devc-tools/run/token
# → reopen the devcontainer, then INSIDE it:
devc-host echo hello               # expect: echo: hello
```

If the gate fails, check in this order:
1. **`cannot read token /run/devc-host/token`** → run dir not mounted, or server not
   started (it writes the token on startup). Confirm `.devc/devc.json` mount + that
   `deno task dev` is running.
2. **`cannot connect to host.docker.internal:48227`** → the container can't reach host
   loopback. Try `DEVC_HOST_HOST=0.0.0.0 deno task dev` on the host.
3. **`unauthorized`** → stale token in the container's mount; restart the server / reopen.
4. **`unknown command: echo`** → `~/.config/devc-tools/commands` not seeded (the symlink step).

| Check | Where | Command | Expected |
| --- | --- | --- | --- |
| B1 gate | container | `devc-host echo hello` | `echo: hello` |
| B2 caffeinate start | container | `devc-host caffeinate start` | `started` |
| B2 assertion | host | `pmset -g assertions \| grep -i caffeinate` | assertion present |
| B2 status | container | `devc-host caffeinate status` | `running` |
| B2 stop | container | `devc-host caffeinate stop` | `stopped`, assertion gone |
| B3 tray | host | (watch menu bar) | ○→● on start, ●→○ on stop; "Quit" exits |
| B4 bundle | host | `cd host && deno task build` | `DevcHost.app` behaves the same double-clicked |

### Notes / gotchas

- **Transport:** a bind-mounted unix socket is refused across the Docker Desktop
  boundary (`ECONNREFUSED` in the container while a host-local `nc -U` works). We use
  loopback TCP via `host.docker.internal` instead; a token file (carried over the same
  mount, since regular files cross fine) authorizes requests.
- **Permissions:** unix/TCP `listen`/`connect` need **`--allow-net`**, not
  `--allow-read/write`. The client also needs `--allow-read` (token file) and
  `--allow-env=DEVC_HOST_ADDR,DEVC_HOST_TOKEN_FILE`. All baked into the `deno.json` tasks.
- **`deno desktop` runs from a temp dir**, so paths relative to `import.meta.url` break.
  Tray icons are embedded (base64) in `server.ts`; command scripts can't be embedded
  (they're host-editable), so the server reads them from `~/.config/devc-tools/commands`.
