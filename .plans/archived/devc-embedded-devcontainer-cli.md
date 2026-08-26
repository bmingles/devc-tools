# Embed the devcontainer CLI instead of finding one on PATH

`devc` depends on `@devcontainers/cli` as a pinned npm package, embedded in the
compiled binary by `deno compile`, rather than shelling out to whatever
`devcontainer` happens to be on the user's `PATH`.

What that buys: `devc up` works on a machine with only Docker installed —
neither the CLI nor the Node.js it runs on has to be there — and a released
`devc` can never disagree with a differently-versioned CLI someone installed for
another reason. `install.sh` stops checking for two of its three prerequisites.

Only `devc up` is affected. Everything else — `exec`, `attach`, `stop`, `down`,
status, mounts — already talks to `docker` directly and is untouched.

## Design decisions

- **A child process, not an in-process call.** `@devcontainers/cli` publishes no
  programmatic API: its `package.json` declares only `bin`, and its esbuild
  bundle ends in `0&&(module.exports={doExec})` — the dead-code marker, so it
  exports nothing. Importing it _runs_ the CLI against `process.argv` and
  finishes with `process.exit()`. Calling it in-process would mean handing over
  devc's argv and being killed on the CLI's exit; the alternative, monkeypatching
  `process.exit` and `process.stdout.write` on a minified bundle, is exactly the
  kind of thing that breaks silently on the next version bump.
- **The child is devc itself.** `devc` re-execs `Deno.execPath()` with a hidden
  `__devcontainer` subcommand, which sets `process.argv` and imports the bundle.
  No second binary to ship, no JS to extract to a cache dir at run time, and no
  Node.js on the host. The parent pipes the child's stdout exactly as it piped
  the PATH binary's, so `startContainer`'s JSON-per-line parsing and every
  argument `buildUpArgs` produces are unchanged.
- **The import must not be followed by an exit — or a return.** The bundle's
  entry point is a bare `(async () => { … })()`; nothing exports its promise, so
  `await import(…)` resolves the moment the module _evaluates_, with the whole
  `up` still in flight. Measured: a `Deno.exit(0)` after the import produces a
  silent exit 0 and not one line of the JSON stream devc parses. The child parks
  on a never-resolving promise instead and lets the CLI own the exit.
- **`--allow-run` becomes unscoped, and that is forced rather than chosen.** A
  `devcontainer.json` may declare an `initializeCommand`, which the CLI runs on
  the **host** through `/bin/sh -c` — devc's own bundled default declares one. An
  allowlist containing `/bin/sh` permits every host command, so keeping
  `docker,git,tmux,tty` beside it would only look like a boundary. This reverses
  the note in `install.sh` that called broadening "the wrong trade": the trade is
  no longer available, because the shelling-out moved inside devc's own sandbox.
  The `Info Failed to resolve '<name>' for allow-run` papercut goes away with the
  allowlist — a consolation, not the reason.
- **`--allow-sys` and `--allow-net` are the CLI's, not devc's.** It reads
  `osRelease` at startup (a hard failure without it, measured) and fetches
  Features from OCI registries over its own HTTPS during `up`. Image pulls stay
  daemon-side and need nothing.
- **Pinned, not ranged.** `0.88.0`, matching `DEVCONTAINERS_CLI` in
  `publish-feature.yml`, which pins the same version for the same reason. An
  upgrade is now a `devc` release; both pins move together.
- **The version pin is asserted by a test, not by a comment.** Two comments
  saying "keep these in step" is how they drift.

## Contract

### `devc/devcontainer_cli.ts` (new)

| Export                             | What it is                                                                                                           |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `DEVCONTAINER_SUBCOMMAND`          | `'__devcontainer'` — the hidden first argument. Deliberately absent from `COMMANDS`.                                 |
| `SelfExecRuntime`                  | The three `Deno` fields `devcontainerArgv` reads: `execPath`, `standalone`, `mainModule`.                            |
| `devcontainerArgv(args, runtime)`  | Pure. Compiled → `[__devcontainer, ...args]`. From source → `['run', ...perms, <main.ts>, __devcontainer, ...args]`. |
| `devcontainerCommand(args, opts?)` | The `Deno.Command`, drop-in for `new Deno.Command('devcontainer', …)`.                                               |
| `runEmbeddedDevcontainerCli(args)` | The child half. Never returns.                                                                                       |

- From-source children are spawned with
  `--allow-read --allow-write --allow-env --allow-sys --allow-net --allow-run`,
  the same set `deno compile` bakes into the binary. A spawned process inherits
  no permissions, so the list is spelled out in one place and mirrored by the
  `build` task.
- `runEmbeddedDevcontainerCli` is dispatched in `main.ts` **before** `--version`,
  `--help` and unknown-command handling: from that point the process belongs to
  the CLI and its argv is the CLI's.

### Behaviour that does not change

- `buildUpArgs` and every flag it emits.
- The JSON-outcome parsing, the `dumpBuildOutput` failure path, and the
  `stdout: 'piped'` / `stderr: 'inherit'` stdio.
- `devc --help`, which never mentions `__devcontainer`.

### Prerequisites

`docker`. That is the list. `install.sh`'s `check_prereqs` drops `devcontainer`
and `node`.

## Checklist

- [x] `devc/devcontainer_cli.ts`: the module above
- [x] `devc/container.ts`: `startContainer` uses `devcontainerCommand`
- [x] `devc/main.ts`: `__devcontainer` dispatch, ahead of everything
- [x] `devc/deno.json`: the `npm:@devcontainers/cli@0.88.0` pin; `--allow-sys`
      `--allow-net` and unscoped `--allow-run` on `run`/`build`/`build:release`;
      `devcontainer` dropped from every allowlist; `devcontainer_cli.ts` added to
      `check`; `test` gains `--allow-run` (it spawns the runtime, whose path no
      allowlist entry can name)
- [x] `devc/tests/devcontainer_cli_test.ts`: three pure argv tests (compiled,
      from-source, passthrough) plus two that spawn the CLI for real — a
      `--version` asserting the pin, and an `up` asserting a parseable JSON
      outcome, both routed through the real `devcontainerArgv` so the child's
      permission set is covered too
- [x] `tests/workflow_guards_test.sh`: assert `publish-feature.yml`'s
      `DEVCONTAINERS_CLI` and `devc/deno.json`'s pin are the same version
- [x] `devc/deno.lock`: the npm entry
- [x] `install.sh`: `check_prereqs` is `docker` alone; the allow-run note rewritten
- [x] `devc/README.md`: Install prerequisites, a
      `### The embedded devcontainer CLI` section under How it works, and a
      Development note that `deno task test` now spawns the runtime
- [x] `README.md`: the two Install bullets replaced with one

## Validation

Done:

- [x] `devcontainer_cli_test.ts` — 5 passed, against a copy with the two
      `jsr:@std/*` imports shimmed (`jsr.io` is blocked by this sandbox's egress
      policy, so the repo's own graph cannot resolve here)
- [x] `bash tests/install_test.sh install.sh` — ALL PASS
- [x] `bash tests/workflow_guards_test.sh` — ALL PASS, and the new pin check
      confirmed to fail on a deliberately drifted version
- [x] `deno fmt --check` at the repo root — 134 files, clean

Needs a machine with jsr.io reachable — nothing here is expected to be
interesting, but none of it has been run:

- [ ] `cd devc && deno task check`
- [ ] `cd devc && deno task test` — 269 + 5

Done, in a later environment where `dl.deno.land` and the npm registry are
reachable (this one has no Docker, so the container round trips below still
cannot run here):

- [x] `cd devc && deno task build`, then `./devc __devcontainer --version`
      prints `0.88.0` — i.e. `deno compile` embedded the npm package and resolved
      the dynamic `npm:` specifier. **This was the one load-bearing unknown in
      the whole change**, and it holds: confirmed 2026-08-24, output `0.88.0`,
      exit 0.
- [x] Binary size delta from `deno task build` — 102 MB compiled output,
      consistent with "small" given the node-compat runtime is already in every
      Deno binary and the embedded bundle is 1.9 MB of pure JS.

Still needs Docker, which this environment does not have either:

- [ ] `./devc up` in a real project, on a machine with **no `devcontainer` and no
      `node` on PATH** — the whole point of the change
- [ ] The same on a project whose `devcontainer.json` declares an
      `initializeCommand` (devc's own bundled default does), confirming the host
      `/bin/sh -c` path works from inside the sandbox
- [ ] One cross-compiled target (`DEVC_TARGET=aarch64-apple-darwin deno task
      build:release`) — the package has zero dependencies and no native code, so
      it should cross-compile like the rest of the graph
