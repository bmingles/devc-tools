# @devc-tools/core

`devc`'s dev container lifecycle logic — start/rebuild/stop/down, status,
mounts, exec, the `devc.json` overlay, and the config wizard's pure helpers —
as a runtime-neutral library. It is written against `node:` builtins only, so
the exact same source runs unchanged on both Deno (`devc`'s own `deno compile`
binary consumes it from source) and Node (this package, published to npm).

This is **not** a new tool. It is the library
[`devc`](../devc/README.md) has always had, split out so a programmatic
consumer — a coding-agent extension, a script — can call `startContainer` and
get a `ContainerInfo` back as a value, without a `devcontainer`/`devc` binary
on disk or stdout to parse. `devc`'s own CLI, install, and behavior are
unchanged; see [`.plans/devc-core-npm-library.md`](../.plans/devc-core-npm-library.md)
for the full design.

## Install

```sh
npm install @devc-tools/core
```

Requires Node 20+. `docker` is the only external prerequisite at runtime — the
`devcontainer` CLI is an ordinary `dependencies` entry
(`@devcontainers/cli`), resolved and spawned for you.

## Usage

```ts
import {
  downContainer,
  execInContainer,
  startContainer,
} from '@devc-tools/core';

const info = await startContainer('/path/to/project');
console.log(info.containerId, info.remoteWorkspaceFolder);

const { code, stdout } = await execInContainer('/path/to/project', {
  cmd: ['npm', 'test'],
  stdio: 'piped', // capture output instead of inheriting the parent's stdio
});

await downContainer('/path/to/project');
```

Everything importable is re-exported from the package root (`mod.ts` /
`dist/mod.js`) — see that file for the full surface, grouped by module:
`container.ts` (lifecycle), `overlay.ts` (`devc.json`), `config.ts` (global
user config), `worktree.ts` + `mounts.ts` + `wizard_apply.ts` (the config
wizard's pure helpers), `init.ts` (scaffold the bundled default
`.devcontainer/`), `default_config.ts` (the bundled default and
`devcontainer.json` variable substitution), and `jsonc_edit.ts` / `posix.ts` /
`paths.ts` (small primitives the rest is built on).

### The devcontainer CLI seam

`startContainer`/`rebuildContainer`/`execInContainer` accept an optional
`devcontainer: DevcontainerRunner` in their options, defaulting to
`nodeDevcontainerRunner` — a plain `process.execPath` + the resolved
`devcontainer.js` from `node_modules`. A consumer embedding its own copy of
the devcontainer CLI, or needing a different one, can supply its own
`DevcontainerRunner`:

```ts
export interface DevcontainerRunner {
  run(args: string[]): Promise<{ code: number; stdout: string }>;
}
```

(`devc`'s own CLI binds a different one — a hidden self-exec subcommand, since
a `deno compile` binary has no `node_modules` a separate process could open.
See `devc/devcontainer_selfexec.ts`.)

## What's deliberately not here

Attaching an interactive shell (`devc attach` / `devc claude`) — tmux window
titles, OSC terminal-tint escapes, raw-mode TTY handling — stays in `devc`'s
own `attach.ts`. None of it means anything to a library consumer that isn't
holding a terminal.

Also not here: the `devc` CLI itself, and any change to how humans install it.
`devc` still ships as a single `deno compile` binary via `install.sh`; this
package is an additional distribution channel for the logic underneath it,
not a replacement for the CLI.

## Development

```sh
deno task check   # type-check under Deno — the primary suite, since both hosts
deno task test    # read the exact same source (`devc`'s own `deno task test`,
                   # run from ../devc, covers the CLI half: attach, args, help)

npm run build              # esbuild → dist/mod.js, tsc → dist/*.d.ts, default/ copied in
npm run check               # tsc --noEmit, the npm-facing type check
npm run portability-check   # fails if a `Deno.` or `jsr:` reference sneaks back in
```

The portability check exists because the failure it catches is otherwise
silent: a stray `Deno.` in a module here keeps every `deno test` green and only
breaks the npm build. CI runs both `deno task test` here and a real
`npm pack` + scratch-project `node` smoke run (`smoke.mjs`) against the built
tarball, with no Deno, no `devcontainer`, and no `devc` on PATH.

`default/` is the bundled zero-config `devcontainer.json` + `Dockerfile` +
lifecycle scripts, shared by `devc`'s zero-config path and `devc init`. It
ships inside the npm tarball (`npm run build` copies it beside `dist/mod.js`)
and inside the compiled `devc` binary (`deno compile --include ../devc-core/default`,
from `devc/deno.json`) — same files, two delivery mechanisms.
