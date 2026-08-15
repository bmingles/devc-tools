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

- [ ] `devc-core/`: scaffold, `deno.json`, `package.json`
      (`@devc-tools/core`; plain `devc-core` if the scope is unavailable)
- [ ] `exec.ts` + `errors.ts`: the `child_process` adapter and `isNotFound`
- [ ] Port the pure three first (`posix.ts`, `jsonc_edit.ts`, and `paths.ts`'s
      one `Deno.build.os`) — proves the build and test wiring before anything
      interesting moves
- [ ] Port the fs-only modules: `config.ts`, `overlay.ts`, `worktree.ts`,
      `wizard_apply.ts`, `init.ts`, `mounts.ts`
- [ ] Port `default_config.ts` and move `devc/default/` → `devc-core/default/`
- [ ] Split `container.ts`: lifecycle to core, `attach.ts` to the CLI
- [ ] `devcontainer.ts`: `DevcontainerRunner` + the Node runner;
      `devc/devcontainer_selfexec.ts` keeps the Deno one
- [ ] `devc/container.ts`: the thin pre-bound re-export, so `main.ts` and
      `tui/config_flow.ts` are untouched
- [ ] `execInContainer`: the `stdio` option
- [ ] `devc/deno.json`: `--include ../devc-core/default`, import map entry for
      core, `check` task module list
- [ ] Move the core's tests to `devc-core/tests/`; the shell harnesses
      (`seed_link_test.sh`, `shell_dirs_test.sh`, `project_hook_test.sh`) follow
      `default/scripts/` and their invocations in `devc/README.md` change with
      them — including the `features/shell-dirs` cross-check
- [ ] `devc-core` build: JS + `.d.ts` (TS 5.7's `rewriteRelativeImportExtensions`
      exists for the `./x.ts` specifiers; esbuild handles them natively), and
      `default/` copied beside the output
- [ ] CI: the portability grep, and a `node` smoke run against the built tarball
- [ ] `tests/workflow_guards_test.sh`: extend the pin check to the third pin
- [ ] `devc/deno.lock`: drop the unused `@cliffy/*` entries
- [ ] Docs: `devc-core/README.md`; `devc/README.md` Development section;
      root `README.md` Tools table gains a row
- [ ] `.plans/design/devc-design.md`: the core/CLI boundary

## Validation

- [ ] `deno fmt --check`; `deno task check` and `deno task test` in **both**
      `devc/` and `devc-core/` — 269 + 5 tests still pass, wherever they now live
- [ ] `deno task build`, then the full `devc up` / `exec` / `status` / `mounts` /
      `down` round trip against a real project. This is a refactor: the bar is
      byte-identical behavior, not "it works"
- [ ] **`deno compile` + the bundled assets.** `--include ../devc-core/default`
      must land in the VFS where `new URL('./default/', import.meta.url)` looks
      for it, _and_ `node:fs` must read it back out. Both halves are new. Check
      with a zero-config `devc up` (materializes the default) and a `devc init`
      (copies the whole bundle) from a compiled binary
- [ ] `npm pack` the library, install the tarball into a scratch Node project,
      and drive a real container: `up`, then `execInContainer` with
      `stdio: 'piped'`, then `down`. Node only — no Deno, no `devcontainer` and no
      `devc` on `PATH`
- [ ] The portability grep fails when a `Deno.` is deliberately reintroduced into
      a core module — same negative check the pin assertion got
- [ ] A compiled `devc` still reports Docker as its only prerequisite: run the
      round trip with `node`, `npm` and `devcontainer` off `PATH`
