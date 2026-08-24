# Prepare `devc-core` for its first out-of-tree consumer

Four changes to `devc-core/`, all driven by the same thing: a
[pi coding-agent extension](https://github.com/emeraldwalk/pi-dev-extensions)
is about to `import '@devc-tools/core'` and call `startContainer` **in-process,
inside a long-running TUI**. Everything below is a property core gets away with
while `devc` the CLI is its only consumer, and stops getting away with the
moment a second copy of core exists on the machine.

One is a real bug that predates the consumer (and predates the npm split);
two are seams the consumer otherwise has to work around with hacks; one is
packaging polish. `devc`'s own behavior does not change — that is the bar for
all four.

**Non-goals.** The pi extension itself (that plan lives in the other repo). Any
change to `devc`'s CLI output, its `install.sh`, or its Docker-only
prerequisite. Publishing `@devc-tools/core` — the `devc-tools` npm org is
claimed, but the version to publish is a separate decision.

## Design decisions

### 1. The zero-config cache is a shared mutable path, and that is the bug

`materializeDefaultConfig` (`default_config.ts:262`) `rm -rf`s
`~/.cache/devc/default` and rewrites it from its own bundled `default/` on
**every** zero-config start, and `container.ts:626` calls it with the hardcoded
default path — `StartOptions` cannot override it. One path, every project,
rewritten unconditionally.

Three separate problems fall out of that, and they compound:

- **Per-project flip-flop, today, with no npm consumer involved.** `bridge` is
  `declaresBridgeFeature(loadMergedOverlay(localFolder))` — resolved _per
  project_ — while the cache dir is shared across _all_ projects. A bridge
  project and a non-bridge project write different `devcontainer.json` content
  to the same path. Sequentially this self-corrects, because each start
  rewrites immediately before `runner.run(args)`; it is only latent.
- **Version skew, once the extension ships.** An installed `devc` binary and
  pi's embedded core each carry their own bundled `default/`. Alternating
  between them rewrites the config under the other, which `devcontainer up`
  reads as a changed config — container rebuild churn from nothing the user
  did.
- **A real race, once there are concurrent starters.** The unconditional
  `rm -rf` + full tree copy can land while another process's `devcontainer up`
  is reading that same config. A long-running pi session is exactly the second
  starter that makes this reachable.

**The fix is to make the path a pure function of the inputs, and the write
atomic.** Content-address the directory and skip the write entirely on a hit:

```text
key    = sha256(bundled default tree ‖ templates tree ‖ bridge flag)[:12]
target = ~/.cache/devc/default-<key>/

hit  → return target/devcontainer.json, write nothing
miss → materialize into ~/.cache/devc/.tmp-<pid>-<rand>/, then rename() into place
rename loses (EEXIST/ENOTEMPTY) → another process won; rm the tmp, use target
```

All three problems close at once. Distinct versions, bridge flags and template
revisions get distinct directories, so nothing clobbers anything. `rename` is
atomic on one filesystem, so no reader ever sees a half-written tree. And
identical inputs give an identical path, so the absolute
`initialize-command.sh` baked into the config is stable and nothing rebuilds
spuriously.

It is also **cheaper than today**: every `devc up` — and every
`execInContainer`, which calls `startContainer` — currently pays an `rm -rf`
plus a full tree copy. A hit becomes a hash and a stat.

- **The templates tree must be in the key.** Skip-on-hit silently ignores any
  input outside the key, so an un-keyed `~/.config/devc/templates` edit would
  appear to do nothing. This is the one way to get the design wrong.
- **Two functions, not one changed signature.** `materializeDefaultConfig`
  keeps meaning "write the tree exactly here, unconditionally" — pure, directly
  testable, and what `tests/default_config_test.ts` already asserts against a
  temp dir. The caching layer is a **new** `ensureDefaultConfig` that computes
  the key, does the hit/miss/rename dance, and calls the materializer for the
  miss. `container.ts` switches to it; the existing tests keep passing
  untouched.
- **The path rewrite has to target the final directory, not the temp one.**
  `materializeDefaultConfig` bakes `${cacheDir}/initialize-command.sh` into the
  config. Materializing into a temp dir and renaming would leave that pointing
  at a path that no longer exists — the trap in this whole change. The target
  path _is_ known before the write (the key depends only on inputs), so pass it
  in: a `finalDir` option that the two rewrites resolve against, defaulting to
  `cacheDir` so every existing caller and test is unaffected.
- **Garbage is not worth machinery.** Each keyed directory is ~30 KB. Prune
  `default-*` entries untouched for 30 days on a miss, or do nothing; either is
  defensible. Do not build a refcount.
- **Existing users take exactly one rebuild**, because the path is baked into
  the generated config. Unavoidable with any path change; it belongs in the
  release notes, not in a compatibility shim.

### 2. Core writes to the terminal, which a TUI consumer cannot allow

Seven sites print user-facing notices straight to `console.log` /
`console.error`: `container.ts:445` (rename conflict), `:505–516`
(`dumpBuildOutput`, many lines), `:601` (seed dir created);
`default_config.ts:199` (template file ignored), `:365` (bridge mount not
injectable), `:512` (remoteEnv unreadable); and `overlay.ts:303` (unknown
overlay key). In-process those are pi's stdout and stderr, and they corrupt its
display.

**A module-level logger, not a `StartOptions` field.** I originally suggested
threading `log` through `StartOptions`; reading the call sites says otherwise.
They sit in three modules at varying depths, several inside otherwise-pure
helpers (`injectBridgeMount`, `overlayDirFrom`, `loadResolvedRemoteEnv`) that
no `StartOptions` reaches. Threading a parameter to all seven would put a
logging argument on functions that have no other reason to know a caller
exists. There is exactly one core instance per process and exactly one consumer
driving it, so a module-level sink is the honest shape:

- the default sink reproduces today's behavior exactly — `notice` →
  `console.log`, `warning` → `console.error` — so `devc`'s output stays
  byte-identical and the CLI sets nothing;
- a library consumer calls `setLogger` once at load and every line arrives as
  a value.

Keeping the two levels matters: it is the stdout/stderr split the CLI needs,
and collapsing them would change `devc`'s behavior.

### 3. The consumer needs the Node runner's stderr as data

`nodeDevcontainerRunner` runs `devcontainer up` with **stderr inherited** —
correct for a CLI, wrong inside a TUI, and not overridable. Without a seam the
consumer hand-rolls an entire `DevcontainerRunner` and re-derives
`devcontainer.js`'s path through
`createRequire(import.meta.resolve('@devc-tools/core'))` — a dependency on a
module-private implementation detail.

A factory fixes both: `createNodeDevcontainerRunner({ onStderr })` pipes stderr
and forwards chunks; called with no options it inherits, exactly as today.
`nodeDevcontainerRunner` stays as the no-options instance, so nothing that
imports it changes. `devcontainerJsPath()` gets exported too — trivial, and it
saves the next consumer the same re-derivation.

This needs one small addition in `exec.ts`: `output()` gains optional
`onStdout`/`onStderr` chunk callbacks, firing alongside the existing
collection. They are only meaningful for a `'piped'` stream.

`devc`'s own `devcontainer_selfexec.ts` runner is untouched — it implements the
same interface and never went through the Node one.

### 4. Packaging

`devc-core/` has no `LICENSE`, so the tarball ships none despite
`"license": "MIT"` (the repo root has one). `package.json` has no `repository`
field. Both are one line each.

## Contract

### `default_config.ts`

```ts
/**
 * Content-addressed zero-config cache. Returns the path to a materialized
 * `devcontainer.json` for the current bundled default + templates + bridge
 * flag, writing nothing when a matching directory already exists.
 */
export function ensureDefaultConfig(
  cacheRoot?: string, // default `${homeDir()}/.cache/devc`
  templatesDir?: string, // default TEMPLATES_DIR
  opts?: { bridge?: boolean },
): Promise<string>; // <cacheRoot>/default-<key>/devcontainer.json

/** Unchanged, plus one option. Writes to `cacheDir` unconditionally. */
export function materializeDefaultConfig(
  cacheDir?: string,
  templatesDir?: string,
  opts?: {
    bridge?: boolean;
    /**
     * The directory this tree will live in once in place; the `initializeCommand`
     * path rewrite resolves against it. Defaults to `cacheDir`. Set it when
     * materializing into a staging directory that will be renamed.
     */
    finalDir?: string;
  },
): Promise<string>;
```

**The key.** `sha256` over, in this order, hex, first 12 chars:

1. every file under the bundled `default/` tree, walked in sorted relative-path
   order, each contributing its posix relative path, a `NUL`, then its bytes;
2. the same walk over `templatesDir` (a missing directory contributes nothing);
3. `bridge ? '1' : '0'`.

Sorted order and the separator are load-bearing — the key must be stable across
platforms and filesystem enumeration order.

### `log.ts` (new)

```ts
export type LogLevel = 'notice' | 'warning';
export type Logger = (level: LogLevel, message: string) => void;

/** Route core's output to `logger`; `null` restores the console default. */
export function setLogger(logger: Logger | null): void;

export function logNotice(message: string): void; // default → console.log
export function logWarning(message: string): void; // default → console.error
```

All seven console sites become `logNotice` / `logWarning`. `dumpBuildOutput`
calls `logWarning` **once per line**, preserving today's per-line
`console.error`.

### `devcontainer.ts`

```ts
export function devcontainerJsPath(): string; // was module-private

export function createNodeDevcontainerRunner(
  opts?: { onStderr?: (chunk: Uint8Array) => void },
): DevcontainerRunner;

/** Unchanged binding: `createNodeDevcontainerRunner()`, stderr inherited. */
export const nodeDevcontainerRunner: DevcontainerRunner;
```

With `onStderr`, stderr is `'piped'` and chunks are forwarded; without it,
`'inherit'` as today.

### `exec.ts`

```ts
export interface CommandOptions {
  args?: string[];
  stdin?: Stdio;
  stdout?: Stdio;
  stderr?: Stdio;
  onStdout?: (chunk: Uint8Array) => void; // new; only fires for 'piped'
  onStderr?: (chunk: Uint8Array) => void; // new; only fires for 'piped'
}
```

### Behaviour that does not change

- Every `devc <command>`, its stdout/stderr split, and its exit codes.
- `devc init` and `copyBundledAssets` / `installBundledAssets` — they write into
  a project, not the cache, and are not touched.
- `install.sh`, the release matrix, the Docker-only prerequisite.
- The compiled binary's `--include ../devc-core/default` VFS path: the bundled
  tree is now _read_ twice per miss (once to hash, once to copy) and once per
  hit. Both go through `node:fs`, which is already proven against the VFS.
- The one user-visible change in the whole plan: existing zero-config users get
  a single container rebuild the first time the cache key path applies.

## Concept boundaries

- **`materializeDefaultConfig` vs `ensureDefaultConfig`.** The first writes
  unconditionally to the directory it is handed and is what tests drive; the
  second is the content-addressed cache and is what `container.ts` calls.
  Calling the first from production code reintroduces exactly the bug this plan
  fixes.
- **`cacheRoot` (holds many `default-<key>/` dirs) vs `cacheDir` (one
  materialized tree) vs `finalDir` (where a staged tree will end up).** Three
  path parameters, three meanings.
- **`Logger` here is core's own** — level + message, nothing to do with any
  pi-side logging type, and not a general logging framework.
- **`createNodeDevcontainerRunner` is only the Node runner's factory.** The
  CLI's self-exec runner in `devc/devcontainer_selfexec.ts` implements the same
  `DevcontainerRunner` interface and is unrelated.

## Checklist

- [x] `log.ts`: `Logger`, `setLogger`, `logNotice`, `logWarning`, console
      defaults; add to `deno.json`'s `check` task module list and to `mod.ts`
- [x] Replace all seven console sites (`container.ts` ×3, `default_config.ts`
      ×3, `overlay.ts` ×1); `dumpBuildOutput` stays one call per line
- [x] `exec.ts`: optional `onStdout` / `onStderr` chunk callbacks on `output()`
- [x] `devcontainer.ts`: export `devcontainerJsPath`, add
      `createNodeDevcontainerRunner`, keep `nodeDevcontainerRunner` as the
      no-options instance
- [x] `default_config.ts`: `finalDir` option on `materializeDefaultConfig`
- [x] `default_config.ts`: the key function (sorted walk, path‖NUL‖bytes,
      templates, bridge flag) and `ensureDefaultConfig` (hit → return,
      miss → stage + `rename`, lost race → discard tmp)
- [x] `container.ts:626`: call `ensureDefaultConfig`
- [ ] Optional prune of `default-*` untouched for 30 days, on a miss only
      — **deliberately not implemented**, taking the plan's own "or do nothing;
      either is defensible". A hit writes nothing, so a directory's mtime is its
      creation time and never advances: "untouched for 30 days" would therefore
      fire on a _live_ cache dir, and the only cache dirs whose key differs from
      ours are the ones belonging to the other copy of core this plan exists to
      coexist with. Pruning would `rm -rf` that copy's config out from under its
      `devcontainer up` — reintroducing precisely the write-under-a-reader race
      the content-addressing removes, to reclaim ~30 KB
- [x] `devc-core/LICENSE` (copy the root MIT file); `repository` field in
      `package.json` with `"directory": "devc-core"`
- [x] Docs: `devc-core/README.md` (the logger seam, the runner factory, the
      cache layout), `devc/README.md` + `.plans/design/devc-design.md` where
      they name `~/.cache/devc/default`, and a release note for the one-time
      rebuild

## Validation

- [x] `deno fmt --check`; `deno task check` and `deno task test` in **both**
      `devc/` and `devc-core/`. The existing `materializeDefaultConfig` tests
      must pass **unmodified** — that is the check on the two-function split.
      All green: `deno fmt --check` clean over 154 files, `devc-core` 213
      passed / 0 failed (189 before, so the 24 new tests are pure addition and
      **no existing test was touched** — `tests/default_config_test.ts` is
      byte-for-byte unchanged), `devc` 91 passed / 0 failed, both `check`
      tasks clean, plus `npm run check` (`tsc --noEmit`)
- [x] `npm run portability-check` (the new `log.ts` must carry no `Deno.`) and
      `npm run smoke`. Both pass — `log.ts` reaches the terminal only through
      `console.*`, which is a web-standard global on both hosts, and the smoke
      run drove the built tarball from a scratch project under a scoped `PATH`
      with only `node` and coreutils
- [x] New unit tests for the key: identical inputs → identical key; a changed
      bundled file, a changed template, an added template, and a flipped
      `bridge` each → a different key; enumeration order does not affect it.
      All six in `tests/default_config_cache_test.ts`, asserted through the
      `default-<key>` path (the key itself stays module-private — it is an
      implementation detail of a path, and there is nothing to gain from
      exporting it). The changed-bundled-file case temporarily adds a file to
      the real `default/` tree and removes it again, since that tree is not a
      parameter; the enumeration-order case builds the same template set twice
      in opposite creation orders. One extra beyond the plan: an absent
      templates dir keys identically to a present-but-empty one
- [x] New unit tests for `ensureDefaultConfig`: a miss writes and returns the
      keyed path; a second call writes **nothing** (assert via mtime) and
      returns the same path; two different `bridge` flags produce two
      directories that both survive; a pre-existing target makes the staging
      directory get discarded rather than the target overwritten. All four
      present. The "writes nothing" test asserts mtime _and_ a marker written
      into the cached config between the two calls — a marker survives
      regardless of filesystem timestamp granularity, which mtime alone is at
      the mercy of
- [x] **The rewrite points at the final directory, not the staging one** —
      assert the materialized `devcontainer.json`'s `initializeCommand`
      contains `default-<key>/initialize-command.sh` and no `.tmp-` segment.
      This is the trap; test it directly. Done, and **verified negatively**:
      reverting the rewrite to resolve against `cacheDir` instead of
      `finalDir` makes exactly this test (and the concurrency one) fail, so it
      is catching the trap rather than passing by construction
- [x] Concurrency: run N `ensureDefaultConfig` calls in parallel against one
      empty cache root; all return the same path, the tree is complete, and no
      `.tmp-` directory is left behind. N = 8, asserted on all three counts
      (one directory in the cache root, all five entries in it, the baked
      `initializeCommand` naming it). Repeated from plain Node against the
      installed tarball, below
- [x] `devc`'s output is byte-identical: capture stdout and stderr separately
      across `up` / `exec` / `status` / `mounts` / `down` before and after, with
      no logger set. The seed-dir notice must still be on **stdout** and the
      warnings on **stderr**. Done properly — two `deno compile` binaries (one
      from `main`, one from this branch), six invocations each
      (`up`, `exec … -- echo hello`, `status`, `mounts`, `down`, and a second
      `up` for the cache-hit path), each with stdout, stderr and exit code
      captured to separate files, run against an identical freshly-created
      `HOME` and project directory so no path differs. **`diff -r` is clean**
      on every stdout, every stderr and every exit code, after normalizing two
      things that cannot help but differ: the `deno compile` VFS root (named
      after the binary) and the devcontainer CLI's ISO timestamp prefix. One
      residual difference, in the `status`/`mounts`/`down` stderr only: the
      _line numbers_ inside a Deno uncaught-exception stack trace, which moved
      because `exec.ts` and `container.ts` gained lines. Same frames, same
      functions, same message, same exit code — normalizing `line:col` makes
      those three identical too. The split is confirmed the right way round:
      the seed-dir notice is the sole line on `up`'s **stdout**, and
      `dumpBuildOutput`'s fenced block plus `devc: devcontainer up failed: …`
      are on **stderr**
- [x] `setLogger` actually captures: set one, trigger the unknown-overlay-key
      warning and the seed-dir notice, assert both arrive as values with the
      right level and **nothing** reaches the console. Covered by
      `tests/log_test.ts`, with one substitution: the two _real_ call sites
      driven are `overlay.ts`'s unknown-overlay-key warning and
      `default_config.ts`'s templates-`devc.json` warning — one per module,
      rather than the seed-dir notice, which is emitted from inside
      `startContainer` and would need either a Docker daemon or surgery on the
      module-level `CLAUDE_SEED_HOST_DIR` to reach from a unit test. The
      `notice` level is covered directly (`logNotice` → `console.log`,
      `logWarning` → `console.error`, and both to the sink when one is set),
      and the seed-dir notice specifically is confirmed on stdout by the
      byte-identical run above, which is the assertion that actually mattered
- [x] `createNodeDevcontainerRunner({ onStderr })` receives the CLI's stderr as
      chunks and the terminal stays clean; with no options, stderr still
      inherits. `tests/devcontainer_runner_test.ts` spawns the real
      `devcontainer.js` twice — a bogus subcommand with `onStderr` (953 bytes
      of yargs complaint arrive as chunks, exit 1) and `--version` with no
      options (exit 0, version on the returned stdout). "The terminal stays
      clean" is asserted structurally rather than by capturing a TTY: with
      `onStderr` the stream is `'piped'`, so it cannot reach the terminal at
      all. `exec.ts`'s callbacks get their own two tests — a tee that leaves
      the collected buffers untouched, and inertness on a non-`'piped'` stream
- [x] `deno compile`, then a zero-config `devc up` and a `devc init` from the
      compiled binary — the hash walk reads the bundled `default/` out of the
      VFS through `node:fs`, which is a new read pattern against it. Both run.
      The hash walk works against the VFS: the compiled binary produced
      `~/.cache/devc/default-6d987147227a/`, with the baked `initializeCommand`
      naming that final directory and no `.tmp-` anywhere — and the **same key
      as the npm-installed tarball computes on the same tree**, which is the
      cross-host stability the sorted walk exists for. A second `up` left the
      cache root with exactly that one directory (a hit). `devc init` into a
      scratch dir wrote a tree `diff -r`-identical to `devc-core/default/`.
      The `up` itself still fails at `spawn docker ENOENT`, per the last item
- [x] `npm pack`, install the tarball into a scratch Node project, and confirm
      `LICENSE` is present and `ensureDefaultConfig` + `setLogger` +
      `createNodeDevcontainerRunner` all work from the installed package. Done
      under `env -i` with only `node` and coreutils on `PATH`: `LICENSE` is in
      the tarball (`package/LICENSE`, the 1069-byte MIT text) and installs
      alongside `dist/`; `ensureDefaultConfig` returned a keyed path on a miss
      (23 ms) and the same path writing nothing on a hit (6 ms); the baked
      `initializeCommand` named the final directory with no `.tmp-` segment;
      8 concurrent calls agreed on one directory with no leftovers;
      `setLogger` captured a real warning with **nothing** reaching the
      console; `devcontainerJsPath()` resolved into the scratch project's own
      `node_modules`; and both runner shapes behaved as specified. The `.tgz`
      was deleted from the repo afterwards
- [ ] The full `devc up` / `exec` / `status` / `mounts` / `down` round trip
      against a real project with a Docker daemon — including the one-time
      rebuild on first run and **no** rebuild on the second. **Not run** — this
      sandbox has no Docker daemon and no `docker` binary at all. What _was_
      run in its place: the full before/after byte-identical capture above,
      which drives every one of those five commands through its whole pipeline
      and fails only at `spawn docker ENOENT` — i.e. everything before Docker
      itself (seed dir, overlay load, bridge detection, the content-addressed
      cache, `buildUpArgs`, the embedded devcontainer CLI, JSON-outcome
      parsing, error surfacing) is exercised and byte-identical to `main`. The
      two Docker-gated claims that remain **unverified** are the ones about
      rebuild behavior: that the moved cache path costs exactly one container
      rebuild on first run, and none on the second. Both follow from the path
      being an input to the config `devcontainer up` hashes, and the path is
      proven stable across repeat runs and across the two hosts — but neither
      has been observed against a real daemon
