# devc-bridge — ship the client by read-only bind mount, not a per-repo build

## Goal

Make the bridge available in **every** devc container without per-project
wiring, by mounting a host-built Linux client read-only from devc's bundled
`devcontainer.json`. Harden the existing run-dir mount to `readonly` at the same
time.

After this, the host-side sequence is the whole setup:

```sh
devc-bridge start     # builds the tray AND cross-compiles the Linux client
devc up               # any repo — the client is already on PATH inside
```

### Why

`.devc/devc-post-create.sh` builds the client from `devc-bridge/client/` source,
which only exists in this repo. Any other project has nothing to build, so the
bridge is unavailable there — the hook cannot be the distribution mechanism.

A mount can be, and it must be **read-only**: a writable mount of a host file
lets a container rewrite an artifact other containers execute (lateral movement
between containers), and lets it tamper with host-managed state. The
`devc.json` overlay **cannot** express `readonly` — the CLI re-serializes
`--mount` and drops the field — but a **string mount inside a
`devcontainer.json` `mounts` array is passed through verbatim**
(`overlay.ts:60-62`), which is exactly how the existing `claude-seed`,
`gitconfig-identity` and `shell` mounts stay read-only. So the mounts belong in
`devc/default/devcontainer.json`, not in an overlay.

**This also closes a live issue.** `run/` is bind-mounted **writable** today.
`readPid` (`host/main.ts:197`) reads `run/tray.pid` and validates only that it is
a positive integer; `stop` (`host/main.ts:160-166`) then `Deno.kill`s it. A
container can therefore write any PID into `tray.pid` and have the next host-side
`devc-bridge stop` send it SIGTERM — container-controlled input to a host
process kill. The container only ever _reads_ the token, so `run/` can be
`readonly` with no loss, which removes the vector entirely.

## Decisions

1. **Mounts live in `devc/default/devcontainer.json`**, as string mounts so
   `readonly` survives. Accepted tradeoff: they apply to every devc container,
   including users who never installed the bridge. That is acceptable only
   because they are **inert when absent** — `initialize-command.sh` creates empty
   sources, so the mounts succeed and contribute nothing but an unused directory
   and a placeholder that explains itself.
2. **Mount the client's _directory_, not the binary file.** A single-file bind
   mount pins the inode, so a client rebuilt on the host would go stale inside a
   running container until it was recreated. A directory mount is live for both
   first appearance and later replacement — the same property the `shell` mount
   already documents ("Read-only and live").
3. **Target is devc's namespace**, `/usr/local/share/devc/bridge-client/`,
   matching every other bind in that file, with a symlink onto `PATH`. Mounting
   onto `/usr/local/bin` directly would either shadow the directory or leave a
   bare file there for users without the bridge.
4. **The symlink is created unconditionally** at post-create, even when the
   target does not exist yet. It then heals the instant the host builds the
   client, with **zero container action** — which matters because the obvious
   alternative (link on shell init) does not work: devc's additions sit at
   `~/.bashrc:162`, _after_ Ubuntu's non-interactive early-return guard at line
   8, so `devc claude` (`/bin/bash -lc`, non-interactive) never runs them. Only
   an interactive `devc attach` would heal it.
5. **A host-side placeholder makes the dangling symlink self-explanatory.** It
   must live inside the mounted directory (a placeholder written into the
   container would shadow the mount and never heal). It is the reason decision 4
   costs nothing in clarity.
6. **`initialize-command.sh` creates the placeholder only when absent.** It runs
   on the host before _every_ `up`, so an unconditional write would clobber the
   real client on every container start.
7. **Nothing is built on the fly.** `devc-bridge start` does **not** compile the
   client. `~/.config/devc-bridge/client/devc-bridge` is a plain **destination**
   that two installation paths write to:
   - **Typical user** — the release installer (curl + `.sh`, binaries as GitHub
     release assets) drops the prebuilt Linux client there. Separate plan; this
     one only fixes the destination it must use.
   - **Developer** — `deno task build:client` cross-compiles to that same path.

   This is why `start` needs no embedded client source, no arch derivation and no
   build-failure handling: it never builds a client. It is also the reason the
   placeholder matters — between installing devc and installing the bridge, the
   destination legitimately holds nothing.
8. **The client binary is never user-owned**, unlike `commands/` ("Seeding never
   clobbers"). Both installation paths overwrite it unconditionally. Document
   the asymmetry.
9. **Cross-compile target follows the host arch** (`aarch64-*` →
   `aarch64-unknown-linux-gnu`, `x86_64-*` → `x86_64-unknown-linux-gnu`), since
   Docker Desktop runs containers matching the host by default. This applies to
   the dev build task now and to the installer's asset selection later. A
   container deliberately run under emulation on the other arch is out of scope
   and should be documented as such, not worked around.
10. **Developing the client requires running `devc-bridge` from source.** Once
    the container's client comes from the mount, a compiled host binary has no
    connection to the working tree — you would edit `client/devc-bridge.ts`,
    restart, and silently keep running the previously built client. Rather than
    add source-resolution fallbacks, document the requirement: use
    `deno task build:client` (or `source scripts/bash_aliases.sh`) while working
    on client code. This matches how the tray already behaves and keeps one
    answer to "where did this binary come from".

## Implementation

### `devc/default/devcontainer.json`

Add to `mounts`, alongside the existing read-only binds:

```jsonc
// devc-bridge: token written by the host bridge. Read-only — the container only ever
// reads the token, and a writable run/ lets a container feed `devc-bridge stop` an
// arbitrary PID to SIGTERM on the host.
"type=bind,source=${localEnv:HOME}/.config/devc-bridge/run,target=/run/devc-bridge,consistency=cached,readonly",

// devc-bridge: host-built Linux client. A *directory* mount so a rebuilt client shows
// through live (a file mount would pin the inode). scripts/bridge-client-link.sh puts it
// on PATH.
"type=bind,source=${localEnv:HOME}/.config/devc-bridge/client,target=/usr/local/share/devc/bridge-client,consistency=cached,readonly",
```

`/run/devc-bridge` is unchanged as the target, so the client's built-in
`DEVC_BRIDGE_TOKEN_FILE` default keeps working with no env vars.

### `devc/default/initialize-command.sh`

Append before the final `exit 0`, inside a `# devc:bridge-placeholder` fence:

```bash
# devc-bridge mount sources. Created empty so the binds resolve on a host that has never
# installed the bridge; `devc-bridge start` fills the client dir in.
mkdir -p "$HOME/.config/devc-bridge/run" "$HOME/.config/devc-bridge/client"

# Placeholder so the container's PATH symlink always resolves. Created ONLY when absent —
# this script runs before every `up`, and an unconditional write would clobber the real
# client that `devc-bridge start` put there.
placeholder="$HOME/.config/devc-bridge/client/devc-bridge"
if [ ! -e "$placeholder" ]; then
  cat > "$placeholder" <<'PLACEHOLDER'
#!/bin/sh
echo "devc-bridge: no client binary — host bridge not started, or its client build failed" >&2
exit 127
PLACEHOLDER
  chmod 0755 "$placeholder"
fi
```

Exit `127` is the shell's own "command not found" convention. The message is
diagnostic rather than instructional because a failed cross-compile leaves the
placeholder in place too.

### `devc/default/scripts/bridge-client-link.sh` (new)

```bash
#!/bin/bash
# Put the mounted devc-bridge client on PATH. The link is unconditional: the mount is
# live, so a link made before the host has built the client starts working the moment it
# does, with nothing to re-run in the container.
set -e

# devc:bridge-client-link (start)
BRIDGE_CLIENT="${BRIDGE_CLIENT:-/usr/local/share/devc/bridge-client/devc-bridge}"
BRIDGE_LINK="${BRIDGE_LINK:-/usr/local/bin/devc-bridge}"
ln -sfn "$BRIDGE_CLIENT" "$BRIDGE_LINK"
# devc:bridge-client-link (end)
```

Unconditional, with no guard against an existing non-symlink at that path. Step
order settles every create-time case on its own: `project-hook.sh` runs _after_
this step, so a project installing its own client at the same path wins on every
create. A guard would only protect a hand re-run of this step inside an already
running container — not worth the branch.

This repo's `.devc/devc-post-create.sh` is the only thing that ever wrote that
path, and it is deleted by this plan (see Migration), so no collision remains.

### `devc/default/post-create.sh`

Insert **before** the project hook, so a project hook can still override the
link:

```bash
bash "$scripts/bridge-client-link.sh"  # put the mounted devc-bridge client on PATH
bash "$scripts/project-hook.sh"        # the project's own .devc/devc-post-create.sh, if it has one
```

### `devc-bridge/host/config.ts`

Add `client: join(base, 'client')` and `clientBin: join(client, 'devc-bridge')`;
`ensureConfig` creates the dir. `start` does **not** build a client — these paths
exist so the dir is present and so `status` can report on it.

### `devc-bridge/host/main.ts` — `status` only

No change to `start`. In `status`, report the client alongside the tray state, so
"why doesn't the container see it" is answerable from the host:

- `clientBin` missing → `client: not installed`
- present and it is the placeholder → `client: not installed (placeholder)`
- otherwise → `client: installed`

Detect the placeholder by content (it is a tiny `#!/bin/sh` script), not by size
or mtime.

### `devc-bridge/client/deno.json` — the dev build task

```jsonc
"build:client": "deno compile --allow-read --allow-net --allow-env=DEVC_BRIDGE_ADDR,DEVC_BRIDGE_TOKEN_FILE --target <host-arch-linux> --output \"$HOME/.config/devc-bridge/client/devc-bridge\" devc-bridge.ts"
```

Since a `deno.json` task cannot branch on arch, make it a thin wrapper over a
small script that resolves the target per decision 9 and compiles to a temp path
in the **same directory**, then renames into place — a rename inside the mounted
dir is atomic, so a container never sees a half-written binary. The existing
`build` task (repo-local output) stays for anyone wanting the artifact itself.

The release installer will later write the same path the same way; that is the
whole contract between the two paths.

### Migration — required, or `devc up` fails

Two working-tree changes in this repo, both under the gitignored `.devc/`:

1. **`.devc/devc.json` — delete the `run` mount.** It already mounts
   `~/.config/devc-bridge/run` at the same target the bundled config now uses.
   Overlay mounts colliding with base mounts are **not** deduped — Docker fails
   with `Duplicate mount point` (`devc/README.md`). The `agent-tools` mount stays.
2. **`.devc/devc-post-create.sh` — delete it.** Its only job was building and
   installing the client, which the mount now supplies. Deleting it is what
   removes the last writer of `/usr/local/bin/devc-bridge` other than the link
   step, and leaves this repo consuming the bridge exactly like any other project.

The README must tell existing users to do the same with any equivalent wiring of
their own.

## Checklist

- [ ] `devc/default/devcontainer.json` — two read-only bind mounts added
- [ ] `devc/default/initialize-command.sh` — fenced block creating both dirs and
      the create-if-missing placeholder
- [ ] `devc/default/scripts/bridge-client-link.sh` — new, fenced, mode 0755
- [ ] `devc/default/post-create.sh` — link step added before the project hook
- [ ] `devc-bridge/host/config.ts` — `client`/`clientBin` paths, dir created by
      `ensureConfig`
- [ ] `devc-bridge/host/main.ts` — `status` reports
      `installed` / `not installed` / `not installed (placeholder)`; `start`
      unchanged
- [ ] `devc-bridge/client/deno.json` — `build:client` task compiling to
      `~/.config/devc-bridge/client/devc-bridge` for the host-matched Linux
      target, via temp file + rename in the same dir
- [ ] `.devc/devc.json` — the now-duplicate `run` mount removed
- [ ] `.devc/devc-post-create.sh` — deleted (the mount supplies the client)
- [ ] `devc/tests/default_config_test.ts` — assert both mounts present and each
      carries `readonly`; add `scripts/bridge-client-link.sh` to the two
      expected-file lists
- [ ] `devc/tests/bridge_client_link_test.sh` — new, fence-extracted
- [ ] `devc/tests/initialize_command_test.sh` — new, fence-extracted
- [ ] `devc/README.md` — document the bridge mounts and the PATH symlink; note
      that overlay mounts of the same targets must be removed
- [ ] `devc-bridge/README.md` — Setup section: no per-repo hook; the client is
      **installed, not built on the fly**, by the release installer (typical) or
      `deno task build:client` (dev), into
      `~/.config/devc-bridge/client/devc-bridge`; the two mounts ship in devc's
      default. Document the overwrite-always asymmetry vs `commands/` seeding,
      and add a **Developing the client** note (decision 10): a compiled host
      binary has no link to the working tree, so use `build:client` or run from
      source — otherwise you silently keep testing the previously built client.
      Add the `run/` read-only hardening and the arch limitation to Security.

## Validation

- [ ] `cd devc && deno task check` and `deno task test` pass (the pre-existing
      `jsonc_edit_test.ts:111` failure excepted)
- [ ] `bash devc/tests/bridge_client_link_test.sh devc/default/scripts/bridge-client-link.sh`
      — link created when the target is absent (dangling), idempotent on re-run,
      a stale symlink is repointed, and the link resolves once the target appears
      (create the target after linking, assert it now executes)
- [ ] `bash devc/tests/initialize_command_test.sh devc/default/initialize-command.sh`
      — placeholder created 0755 when absent; an existing file is **not**
      modified (byte-compare before/after)
- [ ] `bash devc/tests/project_hook_test.sh devc/default/scripts/project-hook.sh`
      still passes
- [ ] `deno fmt --check` clean at repo root
- [ ] Placeholder behaves: `sh <placeholder>` exits 127 and prints to stderr, and
      `devc-bridge ping x >/dev/null 2>&1 || true` is silent and non-fatal
- [ ] (user, macOS host) `deno task build:client` writes an
      `aarch64-unknown-linux-gnu` binary to `~/.config/devc-bridge/client/devc-bridge`
      (`file` reports ELF, not Mach-O), and `devc-bridge status` then reports
      `client: installed`
- [ ] (user) **Client first:** `deno task build:client` + `devc-bridge start`,
      then `devc build` in a repo that is **not** devc-tools →
      `devc-bridge ping test` prints `pong`. This is the case that proves the
      whole point: a repo with no bridge wiring of its own.
- [ ] (user) **Container first:** with `~/.config/devc-bridge/client` holding only
      the placeholder, `devc build` → `devc-bridge ping test` prints the
      placeholder message and exits 127, and `devc-bridge status` reports
      `client: not installed (placeholder)`; then `deno task build:client` on the
      host → the **same running container**, no rebuild, `devc-bridge ping test`
      prints `pong`
- [ ] (user) Read-only holds: `touch /run/devc-bridge/x` and
      `touch /usr/local/share/devc/bridge-client/x` both fail
- [ ] (user) A host with no `~/.config/devc-bridge` at all still builds and runs
      (mounts inert, placeholder created by `initialize-command.sh`)

## Relevant Files

- `devc/default/devcontainer.json` — the two read-only mounts
- `devc/default/initialize-command.sh` — source dirs + placeholder
- `devc/default/scripts/bridge-client-link.sh` — new PATH symlink step
- `devc/default/post-create.sh` — invoke the link step before the project hook
- `devc/tests/default_config_test.ts` — mount assertions + expected-file lists
- `devc/tests/bridge_client_link_test.sh` — new
- `devc/tests/initialize_command_test.sh` — new
- `devc-bridge/host/config.ts` — client dir/binary paths
- `devc-bridge/host/main.ts` — `status` reports client state (`start` unchanged)
- `devc-bridge/client/deno.json` — `build:client` task → mount destination
- `devc/README.md`, `devc-bridge/README.md` — docs
- `.devc/devc.json` — remove the duplicate run mount (gitignored; working-tree
  change only)
- `.devc/devc-post-create.sh` — delete (same, gitignored)
- `.plans/PLAN.md` — register this plan

## Follow-on (not this plan)

The release installer — prebuilt `devc` and `devc-bridge` binaries as GitHub
release assets, fetched by a `curl | sh` script. Its only contract with this plan
is the destination: the Linux client goes to
`~/.config/devc-bridge/client/devc-bridge`, arch-matched per decision 9, and
overwrites whatever is there. Everything else here works unchanged whether the
binary arrives from the installer or from `build:client`.

No change to `devc/default/Dockerfile` (`COPY scripts/` is wholesale with
`chmod -R 0755`) or to `installBundledAssets` (it exec-bits every
`scripts/*.sh`).
