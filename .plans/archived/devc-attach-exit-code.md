# devc attach exit-code handling — stop crashing on non-zero `docker exec`

## Context

Bug report: detaching from a container (typing `exit` at the login shell)
sometimes prints Docker's normal `exit`/`logout` lines followed by a raw Deno
stack trace instead of devc quietly returning to the host shell:

```
container devc-tools (main) $ exit
logout
...
error: Uncaught (in promise) Error: docker exec exited with code 130
    if (code !== 0) throw new Error(`docker exec exited with code ${code}`);
                          ^
    at attachToContainer (file:///…/devc/container.ts:909:27)
    at async attach (file:///…/devc/main.ts:65:3)
    at async file:///…/devc/main.ts:148:3
```

130 is `128 + SIGINT` — a completely ordinary way for an interactive shell
session to end (the terminal/`docker exec` delivered a signal on the way out),
not a devc- or docker-level failure. Two independent bugs turn that into a
crash:

1. **`attachToContainer` treats any non-zero exit as an error.**
   `devc/container.ts:909` — `if (code !== 0) throw new Error(...)` — after the
   interactive `docker exec -it` finishes. But an interactive shell's exit code
   is the session's own business, not devc's: it's 130 on a signal-driven exit,
   whatever the login shell chooses on an explicit `exit N`, or the exit code
   of whatever `command` (`devc claude`) returned. This is exactly the
   distinction `execInContainer` (`devc/container.ts:139`) already draws for
   `devc exec` — its doc comment says _"Resolves to the command's exit code.
   Throws only on infra failure (container won't start / docker not
   runnable)"_ — and `main.ts`'s `exec` handler (`devc/main.ts:245-254`)
   `Deno.exit(code)`s with whatever came back. `attachToContainer` is the odd
   one out: it should follow the same contract, not throw.

2. **`attach()`'s call to `attachToContainer` has no catch.**
   `devc/main.ts:65` — `await attachToContainer(...)` — is the one fallible
   call in `attach()` with no `.catch(fail)`/try-catch, unlike every sibling in
   this file: `startContainer(...).catch(fail)` two lines above it, the
   `initProject(...).catch(fail)` in the `init` block, and the explicit
   try/catch around `execInContainer` in the `exec` block (which prints
   `devc: ${message}` and exits 125). So even a genuine infra failure here —
   not just today's mis-thrown exit-code error — would surface as an uncaught
   promise rejection with a full JS stack trace instead of a clean one-line
   `devc:` message.

Fixing only (1) removes today's crash for the exit-130 case; fixing (2) as
well makes `attach`/`claude` match the error-handling shape every other
fallible command in this file already uses, so a real future infra failure
(docker not runnable, etc.) fails the same clean way `exec` does instead of
reopening this bug.

## Contract

### `devc/container.ts` — `attachToContainer`

Return type changes from `Promise<void>` to `Promise<number>`. Drop the
`if (code !== 0) throw new Error(...)` — the function resolves to the
attached shell/command's own exit code instead. `resetColors()` still runs
unconditionally via the existing `finally`. Nothing else in the function
changes; a `Deno.Command(...).spawn()` failure (e.g. `docker` not found/not
runnable) still throws, unchanged.

```ts
/**
 * … (existing doc comment, updated to note:)
 * Resolves to the attached shell/command's exit code — mirrors
 * `execInContainer`'s contract. Throws only on infra failure (e.g. `docker`
 * isn't runnable at all), not on the shell/command's own non-zero exit.
 */
export async function attachToContainer(
  info: ContainerInfo,
  options: AttachOptions = {},
): Promise<number>;
```

### `devc/main.ts` — `attach()`

Wrap the `attachToContainer` call the same way the `exec` block wraps
`execInContainer` (`devc/main.ts:244-254`): success exits with the returned
code, a genuine throw prints a `devc:` message and exits with the same
reserved infra-failure code `exec` uses.

```ts
async function attach(rawArgs: string[], command?: string): Promise<void> {
  // … unchanged setup through `sessionName` …
  try {
    const code = await attachToContainer(info, {
      noClear,
      sessionName,
      command,
    });
    Deno.exit(code);
  } catch (e) {
    console.error(`devc: ${e instanceof Error ? e.message : e}`);
    Deno.exit(125); // reserved: devc/docker infra failure (matches `exec`)
  }
}
```

This covers both call sites unchanged (`devc/main.ts:148` `attach`,
`devc/main.ts:152` `claude`) since both go through this one function.

## Concept boundaries

- **Exit code 125 is already "reserved: devc/docker infra failure"** per the
  `exec` block's comment at `devc/main.ts:253`. Reuse it verbatim for
  `attach`'s infra-failure path so the two commands agree on what 125 means —
  do not invent a second reserved code for the same concept.
- **"Session's own exit code" vs. "devc infra failure"** is the same
  distinction `execInContainer`/`exec` already draw. `attachToContainer`
  moves to that side of the line; nothing about `startContainer` (still
  `.catch(fail)`, unchanged) or genuine spawn failures changes.

## .gitignore

No new files, no new runtime artifacts. Nothing to add.

## Checklist

- [x] `devc/container.ts`: `attachToContainer` returns `Promise<number>` (the
      attached shell/command's exit code) instead of throwing on non-zero;
      update its doc comment to state the contract explicitly (mirroring
      `execInContainer`'s).
- [x] `devc/main.ts`: `attach()` wraps the `attachToContainer` call in
      try/catch — success path `Deno.exit(code)`; catch path prints
      `devc: ${message}` and `Deno.exit(125)`, matching the `exec` block's
      existing pattern exactly.
- [x] `devc/README.md`: the `exec` bullet (~line 59) already documents
      "exits with the command's own exit code; `devc`/`docker` infra
      failures exit 125" — add the same statement to the `attach`/`claude`
      description so the documented contract matches both commands.
- [x] `deno check devc/main.ts`, `deno fmt --check`, and `deno lint` are clean
      (run from `devc/`). (`deno lint` has 30 pre-existing `no-import-prefix`/
      `no-unversioned-import` findings across the repo, unrelated to this
      change and unchanged by it — confirmed via `git stash` before/after
      comparison; none touch `container.ts`/`main.ts`.)

## Validation

`attachToContainer`/`docker exec -it` is inherently interactive (inherited
TTY stdio), so — consistent with how `execInContainer`'s real spawn is
exercised only manually while `buildExecArgs` gets the unit test — this is
validated manually against a live container, not with a new automated test.

- [ ] `devc attach` a project, then `exit` the login shell normally: devc
      returns to the host prompt with no stack trace; `echo $?` on the host
      shows the shell's exit code.
- [ ] Reproduce the reported case directly: inside the attached shell run
      `exit 130`. Confirm devc exits cleanly (no stack trace) and the host's
      `echo $?` reports `130`.
- [ ] `devc claude` a project, let the `claude` command exit non-zero (e.g.
      interrupt it): devc exits cleanly with that code, no stack trace.
- [ ] Force an infra failure (e.g. `PATH=/nonexistent devc attach <project>`
      so the `docker` binary can't be found) and confirm it prints a single
      `devc: …` line and exits 125 — not a raw JS stack trace.
- [ ] Regression: `devc attach --build` and `--no-clear` still behave as
      before (rebuild-then-attach, output left on screen).

## Relevant Files

| File                | Change                                                                                    |
| ------------------- | ----------------------------------------------------------------------------------------- |
| `devc/container.ts` | `attachToContainer` returns the exit code instead of throwing on non-zero.                |
| `devc/main.ts`      | `attach()` gains try/catch around `attachToContainer`, matching `exec`'s pattern.         |
| `devc/README.md`    | `attach`/`claude` bullet documents the same exit-code contract `exec`'s bullet documents. |
