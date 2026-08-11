# devc-bridge (devcontainer Feature)

Gives a devcontainer the [devc-bridge](../../devc-bridge/README.md) client, so
code inside the container can invoke allowlisted commands on the **host** (e.g.
`caffeinate` the Mac while a Claude Code session runs).

```jsonc
"features": {
  "ghcr.io/bmingles/devc-tools/devc-bridge:0": {}
}
```

That is the whole wiring. No mounts to copy, no post-create step, no env vars —
`DEVC_BRIDGE_ADDR` and `DEVC_BRIDGE_TOKEN_FILE` already default to the address
and mount target this Feature sets up.

> The tag tracks the repo's version line. It is `:0` while devc-tools is
> pre-1.0; it becomes `:1` at the first 1.x release.

## Install the host bridge first — this Feature cannot do it for you

**Prerequisite: `~/.config/devc-bridge/run` and `~/.config/devc-bridge/client`
must already exist on the host.** They do as soon as you have run
`devc-bridge start` once — see
[devc-bridge Setup](../../devc-bridge/README.md#setup-macos-host).

If they do not, container creation **fails** with a Docker error like:

```
Error response from daemon: invalid mount config ...
bind source path does not exist: /Users/you/.config/devc-bridge/run
```

This is not something the Feature can work around. A Feature's five lifecycle
hooks all run _inside_ the container, and Features cannot declare an
`initializeCommand` — the one hook that runs on the host — so there is no point
at which it could create its own mount sources. `--mount type=bind` errors on a
missing source rather than creating it.

(devc containers are the exception: devc's bundled config has its own
host-side `initializeCommand`, which creates both dirs and a placeholder client.
So a devc container still builds on a host that never installed the bridge; a
standalone project using only this Feature does not.)

## What it does

Two read-only bind mounts, plus a PATH symlink:

| Host                           | Container                             | Why                                                   |
| ------------------------------ | ------------------------------------- | ----------------------------------------------------- |
| `~/.config/devc-bridge/run`    | `/run/devc-bridge`                    | The shared-secret token the client authenticates with |
| `~/.config/devc-bridge/client` | `/usr/local/share/devc-bridge/client` | The host-installed Linux `devc-bridge` binary         |

`install.sh` symlinks `/usr/local/bin/devc-bridge` at the mounted client.

Deliberate details:

- **Both mounts are read-only.** The container only ever _reads_ them. A
  writable `client/` would let one container rewrite a binary every other
  container executes; a writable `run/` would let a container pin the host's
  shared secret by rewriting `run/token` (the host _adopts_ an existing token
  rather than regenerating it).
- **`client/` is mounted as a directory, not as the binary file.** A single-file
  bind pins the inode, so a client reinstalled on the host would go stale inside
  a running container. A directory mount is live for both the first appearance
  and later replacements.
- **The symlink is made unconditionally,** at image build time, before the mount
  exists. That is not a bug: the mount is live, so the link starts working the
  moment a client appears — with no rebuild and nothing to re-run.

Smoke test, from inside the container:

```sh
devc-bridge ping test    # → pong
```

## Not supported: Docker Compose devcontainers

Use this Feature only with **image-** or **Dockerfile-based** devcontainers
(`"image"` or `"build"` in `devcontainer.json`). For a compose-based
devcontainer the mount strings above are emitted into the generated compose
file, where `,readonly` is not compose's syntax (`:ro` is) — see
[devcontainers/cli#881](https://github.com/devcontainers/cli/issues/881).

The mounts cannot be written as objects instead: the object form is
re-serialized by the CLI and **drops `readonly`**, which the client mount cannot
tolerate.

## Maintainer notes

**The mounts in `devcontainer-feature.json` must stay JSON _strings_.** A string
mount is passed through to Docker verbatim, so `readonly` survives
(`docker inspect` → `"RW": false`). The object form the published Feature schema
documents is re-serialized through the CLI's `Mount` interface, which has no
`readonly` field — converting these two mounts to objects silently makes both of
them writable. `devc/tests/default_config_test.ts` asserts the string form and
the `readonly` flag; do not "fix" the schema warning by defeating that test.

`${localEnv:HOME}` substitution in Feature mounts and `readonly` survival are
both **unspecified** by the published schema — they are measured behavior of the
current CLI. That is why `test/` exists.

### Tests

No Docker needed — exercises the fenced symlink block from `install.sh` against
temp dirs:

```sh
bash features/devc-bridge/test/install_link_test.sh features/devc-bridge/install.sh
```

Needs Docker, and a host with the bridge installed (same prerequisite as above).
Builds a real container from this Feature and asserts, _inside_ it, that
`${localEnv:HOME}` was substituted, that `readonly` survived, and that
`devc-bridge` is on PATH:

```sh
bash features/devc-bridge/test/run-features-test.sh
```

### Publishing

`.github/workflows/publish-feature.yml` publishes this folder to
`ghcr.io/bmingles/devc-tools/devc-bridge` on a `v*` tag. The `version` field
above moves in lockstep with the repo tag, and the workflow fails if the two
disagree — a published Feature must not disagree with the commit it claims.
