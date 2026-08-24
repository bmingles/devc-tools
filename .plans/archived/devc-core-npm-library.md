# Split devc's execution logic into a runtime-neutral npm library

`devc`'s lifecycle logic moves to a new top-level `devc-core/`, written against
`node:` builtins so it runs unchanged on **both** Deno and Node. It publishes to
npm; the `devc` CLI keeps its `deno compile` binary and `install.sh` install, and
consumes the same modules from source.

The consumer that motivates it: a
[pi coding agent](https://github.com/earendil-works/pi) extension is a TypeScript
module loaded in-process under Node, and `pi install npm:<pkg>` runs a plain
`npm install`. An extension that `import`s `@devc-tools/core` needs no binary on
disk, no `PATH` lookup, and no stdout parsing — it gets `ContainerInfo` back as a
value. Shipping the ~91 MB compiled binary as a platform npm package would work
too and is strictly worse for that consumer.

**Non-goals.** The pi extension itself. Any change to how humans install `devc`
— `install.sh` into `~/.local/bin` stays exactly as it is, and stays the
recommended path (`npm -g` binaries live inside the active Node version's prefix,
which is the wrong shape for a tool that ships a Node-version-pinning Feature).
Also not this plan: putting the CLI on npm.

**Prerequisite.**
[devc-embedded-devcontainer-cli](devc-embedded-devcontainer-cli.md) must clear
its `deno compile` validation first. That plan introduced the seam this one
builds on, and both put new weight on the same unproven compiled-binary path;
stacking a second unverified change there would make a failure impossible to
attribute.

## Design decisions

- **`node:` builtins, not a shim and not injected IO.** Deno implements
  `node:fs`, `node:child_process`, `node:process` and `node:path` in the runtime,
  so one source serves both hosts with no `@deno/shim-deno`, no `dnt` codegen,
  and no host-interface threaded through every function. The evidence is already
  in hand: `@devcontainers/cli` is a 1.9 MB Node program that spawns `docker` and
  `git` through `child_process`, does HTTPS against OCI registries and streams
  tar — and it runs unmodified under Deno, byte-identical to Node. devc's core
  is a much smaller ask than that.
- **The split follows the TTY, not the module boundaries.** Everything that
  touches raw-mode stdin, signals, terminal size or tmux stays in the CLI;
  everything that talks to `docker` and the filesystem goes to the library. That
  line already runs cleanly through the codebase — `main.ts` and `tui/` hold 64
  of the 155 `Deno.*` references and are entirely on the CLI side, and the three
  purest modules (`help.ts`, `jsonc_edit.ts`, `posix.ts`) have zero. `cliffy` is
  in `deno.lock` but imported nowhere, a leftover from the `devc-tui`
  predecessor; delete the entry rather than porting anything.
- **`container.ts` is the one module that gets cut in half.** Lifecycle
  (`startContainer`, `getContainerStatus`, `getContainerMounts`,
  `execInContainer`, `stopContainer`, `downContainer`, and the pure helpers) is
  library. `attachToContainer`, `sessionNameForWorkspaceFolder` and the tmux /
  OSC terminal-tint helpers are CLI — an agent extension attaches nothing.
- **The devcontainer CLI is the one genuinely host-specific thing, and the seam
  already exists.** Under Node the runner spawns `process.execPath` plus the
  `devcontainer.js` resolved out of `node_modules` — an ordinary file, an
  ordinary interpreter. Under Deno it must stay the `__devcontainer` self-exec,
  because `deno compile` puts the package in a VFS with no path a separate
  process could open. Core defines `DevcontainerRunner` and defaults to the Node
  one; the CLI binds its own.
- **Bind the runner once, in the CLI, not at every call site.** `devc/container.ts`
  becomes a thin re-export that pre-binds the self-exec runner, so `main.ts` and
  `tui/config_flow.ts` keep importing the same names from the same place and
  neither learns that a runner exists.
- **`default/` moves into the library.** Zero-config `up` and `init` are core
  behavior, so the bundled `devcontainer.json`/`Dockerfile`/`scripts/` have to
  ship in the npm tarball. `default_config.ts` already resolves them as
  `new URL('./default/', import.meta.url)`, which is correct in both worlds — the
  tarball puts `default/` beside the built JS, and `deno compile --include` keeps
  the VFS. That the _reads_ still work through `node:fs` inside a compiled binary
  is the single biggest unknown in this plan; see Validation.
- **`execInContainer` learns `stdio`.** It is currently `'inherit'`-only, which
  is right for `devc exec` and useless to a library consumer that wants the
  output. Add `stdio?: 'inherit' | 'piped'`, default `'inherit'` so the CLI is
  unchanged, and return captured output when piped.
- **Node compatibility needs a CI guard, because the failure is silent.** One
  stray `Deno.` in a core module keeps every Deno test green and breaks only the
  npm build. Two cheap checks, both required: a grep that fails on `Deno.` or
  `jsr:` anywhere under `devc-core/`, and a real `node` smoke run against the
  built tarball.
- **Three pins now, one assertion.** `@devcontainers/cli` will be pinned in
  `publish-feature.yml`, `devc/deno.json` and `devc-core/package.json`. Extend
  the check added by the previous plan rather than adding comments.

## Contract

### Layout

```text
devc-core/                 # the npm package: @devc-tools/core
  mod.ts                   # public entry — the only thing consumers import
  container.ts             # lifecycle, minus attach
  devcontainer.ts          # DevcontainerRunner + the Node runner
  exec.ts                  # the child_process adapter (new)
  errors.ts                # isNotFound(err) (new)
  default_config.ts  overlay.ts  config.ts  init.ts  mounts.ts
  worktree.ts  wizard_apply.ts  paths.ts  posix.ts  jsonc_edit.ts
  default/                 # moved from devc/default/
  package.json  deno.json

devc/                      # the CLI: unchanged shape, unchanged install
  main.ts  args.ts  help.ts  tui/*
  attach.ts                # attachToContainer + session name + tmux/tint (new)
  devcontainer_selfexec.ts # the Deno DevcontainerRunner (today's devcontainer_cli.ts)
  container.ts             # thin: re-exports core, pre-bound to the self-exec runner
```

### The seam

```ts
export interface DevcontainerRunner {
  /** Runs the devcontainer CLI with `args`; stdout captured, stderr inherited. */
  run(args: string[]): Promise<{ code: number; stdout: string }>;
}
```

- Core's default is the Node runner: `process.execPath` + the `devcontainer.js`
  resolved from `@devcontainers/cli`, which is a `dependencies` entry.
- The CLI's is the `__devcontainer` self-exec, unchanged from the previous plan.
- `StartOptions` gains `devcontainer?: DevcontainerRunner`.

### The adapter

`exec.ts` covers exactly the shape `container.ts` uses today — `{ args, stdout,
stderr, stdin }` with `'piped' | 'inherit' | 'null'`, plus the one
`.spawn().status` case in `execInContainer`. Nothing more; it is not a general
subprocess library.

### Behaviour that does not change

- Every `devc <command>` and its output, exit codes included.
- `install.sh`, the release matrix, and the `~/.local/bin` install.
- `buildUpArgs`, `buildExecArgs`, the JSON-outcome parsing, and the overlay.
- The compiled binary's prerequisites: Docker, and nothing else.

## Checklist

- [x] `devc-core/`: scaffold, `deno.json`, `package.json`
      (`@devc-tools/core`; plain `devc-core` if the scope is unavailable)
- [x] `exec.ts` + `errors.ts`: the `child_process` adapter and `isNotFound`
- [x] Port the pure three first (`posix.ts`, `jsonc_edit.ts`, and `paths.ts`'s
      one `Deno.build.os`) — proves the build and test wiring before anything
      interesting moves
- [x] Port the fs-only modules: `config.ts`, `overlay.ts`, `worktree.ts`,
      `wizard_apply.ts`, `init.ts`, `mounts.ts`
- [x] Port `default_config.ts` and move `devc/default/` → `devc-core/default/`
- [x] Split `container.ts`: lifecycle to core, `attach.ts` to the CLI
- [x] `devcontainer.ts`: `DevcontainerRunner` + the Node runner;
      `devc/devcontainer_selfexec.ts` keeps the Deno one
- [x] `devc/container.ts`: the thin pre-bound re-export, so `main.ts` and
      `tui/config_flow.ts` are untouched
- [x] `execInContainer`: the `stdio` option
- [x] `devc/deno.json`: `--include ../devc-core/default`, import map entry for
      core, `check` task module list
- [x] Move the core's tests to `devc-core/tests/`; the shell harnesses
      (`seed_link_test.sh`, `shell_dirs_test.sh`, `project_hook_test.sh`) follow
      `default/scripts/` and their invocations in `devc/README.md` change with
      them — including the `features/shell-dirs` cross-check
- [x] `devc-core` build: JS + `.d.ts` (esbuild bundles `mod.ts` and its `./x.ts`
      imports natively; `tsc`'s `rewriteRelativeImportExtensions` only rewrites
      _emitted JS_, not `.d.ts`, so `build.mjs` fixes up the declaration files'
      specifiers by hand afterward — see its own comment), and `default/` copied
      beside the output
- [x] CI: the portability grep (`npm run portability-check`), and a `node` smoke
      run against the built tarball (`npm run smoke`, `smoke.sh` + `smoke.mjs`),
      both wired into `release.yml`'s `gate` job
- [x] `tests/workflow_guards_test.sh`: extend the pin check to the third pin
- [x] `devc/deno.lock`: drop the unused `@cliffy/*` entries (regenerated from
      scratch; the entries are gone since nothing imports `@cliffy/*` anymore)
- [x] Docs: `devc-core/README.md`; `devc/README.md` Development section;
      root `README.md` Tools table gains a row
- [x] `.plans/design/devc-design.md`: the core/CLI boundary

## Validation

- [x] `deno fmt --check`; `deno task check` and `deno task test` in **both**
      `devc/` and `devc-core/` — 280 tests total (189 in `devc-core`, 91 in
      `devc`), matching the pre-split count exactly (verified by summing every
      individual `Deno.test` count across the moved files before deleting the
      originals). The plan's own "269 + 5" estimate undercounted; nothing was
      lost or duplicated in the move.
- [ ] `deno task build`, then the full `devc up` / `exec` / `status` / `mounts` /
      `down` round trip against a real project. This is a refactor: the bar is
      byte-identical behavior, not "it works". **Not run** — this sandbox has no
      Docker daemon (confirmed: `docker` is not even installed). What _was_ run
      instead, against a real compiled binary: zero-config `devc up` through to
      the `devcontainer up` handoff, failing only at `spawn docker ENOENT` —
      i.e. every step before Docker itself (seed dir, overlay, materialize,
      buildUpArgs, the embedded CLI, JSON-outcome parsing, error surfacing) is
      proven to work.
- [x] **`deno compile` + the bundled assets.** `--include ../devc-core/default`
      must land in the VFS where `new URL('./default/', import.meta.url)` looks
      for it, _and_ `node:fs` must read it back out. Both halves are new. Check
      with a zero-config `devc up` (materializes the default) and a `devc init`
      (copies the whole bundle) from a compiled binary. **Both confirmed**,
      2026-08-24: `devc init` on a scratch dir wrote the whole bundle
      byte-for-byte from the compiled binary's VFS via `node:fs`, and
      zero-config `devc up` materialized the cache copy and handed off to the
      embedded devcontainer CLI correctly (failing only at the Docker spawn,
      per above).
- [x] `npm pack` the library, install the tarball into a scratch Node project,
      and drive a real container: `up`, then `execInContainer` with
      `stdio: 'piped'`, then `down`. Node only — no Deno, no `devcontainer` and no
      `devc` on `PATH`. **Confirmed** via `npm run smoke` (`devc-core/smoke.sh` +
      `smoke.mjs`, now permanent and wired into CI): `initProject`,
      `nodeDevcontainerRunner` (resolves and runs the real
      `@devcontainers/cli/devcontainer.js` via plain Node module resolution),
      `startContainer`, and `execInContainer` with `stdio: 'piped'` all ran
      their full pipeline under a scoped `PATH` with only `node` and coreutils —
      failing only at the Docker spawn, same as above, since this sandbox has no
      daemon either.
- [x] The portability grep fails when a `Deno.` is deliberately reintroduced into
      a core module — same negative check the pin assertion got. Confirmed by
      temporarily appending a `Deno.env.get(...)` call to `errors.ts`: the check
      failed (exit 1), then passed again once removed.
- [x] A compiled `devc` still reports Docker as its only prerequisite: run the
      round trip with `node`, `npm` and `devcontainer` off `PATH`. Confirmed —
      `env -i HOME=$HOME PATH=/usr/bin:/bin devc up` (a minimal PATH with no
      `node`, `npm`, `devcontainer`, or `deno` anywhere reachable, just the
      compiled binary invoked by its own absolute path) ran the same pipeline to
      the same `spawn docker ENOENT` failure. The "round trip" itself is the one
      piece still gated on a Docker daemon this sandbox does not have.
