# devc help output — bring `--help`/`--version` up to the design spec

## Context

See `.plans/design/devc-design.md` → "Top-level help" and each per-command
section (`config`, `attach`, `claude`, `up`, `exec`, `mounts`, `stop`, `down`,
`status`). The `devc-lifecycle-core` and `devc-global-config` phases shipped
only a single terse one-line `USAGE` string printed for top-level `-h`/`--help`;
the design's clap-style structured help was never carried into a plan and so was
dropped. This phase implements it.

Gaps versus the design, all in `devc/main.ts`:

- No structured top-level help (`Commands:` list + descriptions + footer).
- No `-V` / `--version`.
- No per-command help (`devc <cmd> --help`).
- Cosmetic: current usage uses `[path]`; the design uses `[PATH]`.

### Decisions

- **New pure module `devc/help.ts`** holds all help text + the version const +
  the help-detection helper, so it is unit-testable without touching argv
  dispatch. `main.ts` wires it.
- **Help/version dispatch runs before the first-run global-config hook**
  (currently `main.ts:93`) and before any folder resolution / Docker call, so
  `devc up --help` prints help and exits without launching the wizard or
  requiring Docker.
- **Bare `devc` (no subcommand) prints top-level help and exits 0** (today it
  errors with `Unknown subcommand: (none)` and exits 1). Friendlier and matches
  clap's default of showing help.
- **Unknown subcommand** → `devc: unknown command '<x>'` +
  `Run "devc --help" for a list of
  commands.` on stderr, exit 1 (replaces the
  old one-line-usage fallthrough).
- **`VERSION`** is a single const in `help.ts` (source of truth; the compiled
  binary cannot read `deno.json` at runtime). Seed at `0.1.0`. Also add a
  matching `"version": "0.1.0"` to `deno.json` as metadata (not read at
  runtime).
- Delete the old `USAGE` const, the old top-level `-h`/`--help` block, and the
  final unknown-subcommand fallthrough — all superseded by the new dispatch.

### Contract (must match the design's help blocks byte-for-byte)

`devc --help` (and bare `devc`) prints exactly:

```
Usage: devc [OPTIONS] <COMMAND>

Options:
  -h, --help     Print help
  -V, --version  Print version

Commands:
  config   Configure the dev container for the current project (TUI)
  attach   Attach to the dev container for the current project
  claude   Launch Claude inside the dev container for the current project
  up       Start the dev container for the current project
  exec     Execute a command inside the dev container for the current project
  mounts   List container mounts for the current project
  stop     Stop the dev container for the current project
  down     Remove the dev container for the current project
  status   Show dev container status for the current project

Run "devc <COMMAND> --help" for more information on a command.
```

`devc --version` / `devc -V` prints `devc 0.1.0` (i.e. `devc <VERSION>`),
exit 0.

Per-command help (`devc <cmd> --help` / `devc <cmd> -h`) prints that command's
block verbatim from the design (design lines 91-99, 218-333). Each block starts
with `Usage: devc <cmd> ...` and has `Arguments:` / `Options:` sections exactly
as written in the design doc for: `config`, `attach`, `claude`, `up`, `exec`,
`mounts`, `stop`, `down`, `status`.

### Gotchas

- **`exec --` boundary:** everything after the first `--` in `devc exec` args is
  the user's command (design "exec"). A `--help` _after_ `--` must NOT trigger
  devc help — it belongs to the user command. `helpRequested("exec", args)` only
  scans tokens before the first `--`. For every other command, any `-h`/`--help`
  token triggers help.
- **Order:** the help/version/unknown dispatch must be placed so it runs before
  the first-run hook and before `resolveLocalFolder`/`startContainer`.
  `fail`/`attach` are hoisted function declarations, so the dispatch may sit
  immediately after `const subcommand = Deno.args[0];`.
- **`claude` forwards EXTRA_ARGS** but per the design `-h`/`--help` is devc's
  own help flag, so `devc claude --help` prints devc's claude help (does not
  forward `--help` to Claude). Acceptable and matches the design's per-command
  `-h, --help  Print help` line.

## Checklist

- [x] `devc/help.ts` (new) — exports: `VERSION` (`"0.1.0"`); `COMMANDS` (ordered
      list of `{ name, summary }` in design order: config, attach, claude, up,
      exec, mounts, stop, down, status); `topLevelHelp(): string` (the block
      above); `COMMAND_HELP: Record<string, string>` (one verbatim block per
      command); `helpRequested(cmd: string, cmdArgs: string[]): boolean` (true
      on `-h`/`--help`; for `exec`, only tokens before the first `--`).
- [x] `devc/main.ts` — replace the `USAGE` const + old `-h/--help` block +
      trailing unknown-subcommand fallthrough with a dispatch (placed before the
      first-run hook) that: `-V`/`--version` → print `devc ${VERSION}`, exit 0;
      bare/`-h`/`--help` → `topLevelHelp()`, exit 0; known cmd with
      `helpRequested` → `COMMAND_HELP[cmd]`, exit 0; unknown cmd → stderr
      error + `Run "devc --help" ...` hint, exit 1.
- [x] `devc/deno.json` — add `help.ts` to the `check` task list; add
      `"version": "0.1.0"`.
- [x] `devc/tests/help_test.ts` (new) — see Validation.
- [x] `devc/README.md` — if it documents the command surface, update the usage
      examples to the new `[PATH]` casing / `--help` / `--version` (only if
      already present; do not invent a section).

## Validation

- [x] `cd devc && deno task test` — all pass, including `help_test.ts`.
- [x] `cd devc && deno task check` — clean (with `help.ts` added to the list).
- [x] `help_test.ts` asserts: `topLevelHelp()` contains every one of the 9
      command names, the `-V, --version` line, and the
      `Run "devc <COMMAND> --help"` footer; `COMMAND_HELP` has an entry for each
      of the 9 commands and each starts with `Usage: devc <name>`;
      `helpRequested`: `("up", ["--help"])`→true, `("up", ["-h"])`→true,
      `("up", ["."])`→false, `("exec", ["--help","--","echo"])`→true,
      `("exec", ["--","echo","--help"])`→false, `("exec", ["."])`→false;
      `VERSION` is a non-empty string.
- [x] `deno run --allow-read --allow-env main.ts --help` prints the top-level
      block; exit 0.
- [x] `deno run --allow-read --allow-env main.ts` (bare) prints the top-level
      block; exit 0.
- [x] `deno run --allow-read --allow-env main.ts --version` prints `devc 0.1.0`;
      exit 0.
- [x] `deno run --allow-read --allow-env main.ts up --help` prints the `up`
      block; exit 0; does NOT attempt Docker or launch the wizard.
- [x] `deno run --allow-read --allow-env main.ts exec --help` prints the `exec`
      block; exit 0.
- [x] `deno run --allow-read --allow-env main.ts bogus` prints
      `devc: unknown command 'bogus'` + the hint to stderr; exit 1.

## Relevant Files

- `devc/help.ts` — new: version const, help text blocks, `helpRequested` helper.
- `devc/main.ts` — help/version/unknown dispatch; old `USAGE`/`-h`/fallthrough
  removed.
- `devc/deno.json` — `check` list + `version` metadata.
- `devc/tests/help_test.ts` — new: help text + `helpRequested` unit tests.
- `devc/README.md` — usage examples updated iff already present.
