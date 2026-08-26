# devc surfaces the container's agent to Herdr — a rotating `HERDR_AGENT` sidecar

## Goal

A `devc attach` running in a [Herdr](https://herdr.dev) pane shows the coding
agent that is actually running **inside** the container — `claude`, `copilot`,
`codex` — with Herdr's own idle/working/blocked status, and shows **no agent**
when the container shell is sitting at a prompt. No prefix to remember, no
per-project config.

Today the user types `HERDR_AGENT=claude devc attach`. That works, but it is
manual, it is a lie whenever the shell is not running Claude (Herdr reports
`idle`, which is its no-rule-matched fallback, so a bare prompt is
indistinguishable from a live agent waiting for input), and it hardcodes one
agent for the whole session.

## How Herdr sees agents, and why this is the only lever

Verified against Herdr 0.8.0 (protocol 19), macOS, Docker Desktop.

Herdr answers two separate questions about each pane's **foreground process
group**:

- **Identity** — name-matched against agent kinds compiled into the Herdr
  binary. A container agent is invisible: the host only sees `docker`.
  `HERDR_AGENT=<kind>` on a process in that group _asserts_ identity instead —
  Herdr takes it at face value and never inspects the container.
- **State** — TOML manifests (`~/.local/state/herdr/agent-detection/remote/<kind>.toml`)
  evaluated against the pane's live bottom-buffer snapshot. Terminal output
  crosses `docker exec` unchanged, so these work as-is. **This plan must not
  take state over** — asserting identity alone is what keeps Claude's 16 rules
  working.

Three things were measured, and each one shapes the design:

1. **`HERDR_AGENT` is honored on any substantial child of the group, not just
   the top process.** A wrapper with no variable spawning
   `env HERDR_AGENT=claude python3 …` reported `agent=claude`. The same wrapper
   with a plain child reported `agent=None`. → the assertion does **not** have
   to live on the `docker exec`.
2. **Rotating the child rotates the identity, live.** Killing a
   `HERDR_AGENT=copilot` child and spawning a `HERDR_AGENT=claude` one moved the
   pane copilot → claude in ~2–4s; killing the last one returned `agent=None`
   while the pane's other processes kept running. → a disposable **sidecar**
   process is the whole mechanism.
3. **Two assertions in one group is undefined.** A wrapper asserting `claude`
   beside a sidecar asserting `copilot` resolved to `claude` (the later-spawned)
   with no documented rule. → devc must never add a sidecar when
   `HERDR_AGENT` is already set in its own environment.

Rejected, with evidence, so it is not re-tried:

- **Registering `devc` as a custom agent kind.** There is no such concept.
  Manifest `aliases` (`claude.toml` ships `aliases = ["claude-code"]`) resolve
  _labels_, not process names: a local override adding `"devc"`, confirmed
  active via `local_override_shadowing_remote: true`, still left a foreground
  process named `devc` at `agent: None`. Herdr's docs agree — "Adding a
  completely new agent still requires a Herdr binary update for process
  detection, labels, and integration behavior."
- **`herdr pane report-agent --source custom:devc`.** On a pane with an
  `HERDR_AGENT` assertion the report was silently ignored (exit 0, no effect):
  process detection outranks it. On a pane with no detected agent it _did_ take
  — and `--state` is mandatory, so devc becomes the pane's status authority;
  `herdr agent explain` showed the screen verdict `idle` while the pane
  displayed the reported `working`. devc would have to reimplement Claude's
  manifests. Not worth it.

## Design

Two children, both spawned by `devc attach`, both ordinary members of the pane's
foreground process group, both silent:

```
devc (deno)
├── docker exec -it … /bin/bash -l        the attach — untouched, no HERDR_AGENT
├── docker exec … sh -c '<watcher>'       reports the container's foreground command
└── devc __herdr-sidecar                  env HERDR_AGENT=<kind>, killed and respawned
```

The watcher prints a line whenever the container's foreground command changes;
devc maps that line to a Herdr agent kind and rotates the sidecar. Prompt → no
kind → no sidecar → the pane honestly shows no agent.

### Enablement (exact)

Active only when **all** hold, checked in `devc attach` / `devc claude` before
the attach starts:

| Condition                            | Rationale                                                                                                                                                                       |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HERDR_ENV` is `1`                   | devc is inside a Herdr pane; otherwise the whole feature costs nothing                                                                                                          |
| `HERDR_AGENT` is unset in devc's env | the user asserted a kind themselves at exec time; a second assertion is the undefined case above. Their existing `HERDR_AGENT=claude devc attach` habit keeps working unchanged |
| `DEVC_HERDR_AGENT` is not `off`      | explicit opt-out                                                                                                                                                                |

`DEVC_HERDR_AGENT=<kind>` pins that kind for the whole attach: the sidecar is
spawned once with it and **no watcher runs**. This is the escape hatch for an
agent the mapping table does not know.

No new CLI flag, and nothing in `help.ts` — the gate is environment-only.

### The marker

The attach's `docker exec` gains one more `-e`:
`DEVC_HERDR_WATCH=<crypto.randomUUID()>`. It is how the watcher finds _this_
attach's shell among every process in the container. Emitted only when the
feature is enabled.

### The watcher, and the `/proc` contract

One long-lived `docker exec -u <remoteUser> <containerId> sh -c '<script>' <id>`.
**No `-i`, no `-t`** — it must never touch the pane's terminal. `stdin: 'null'`,
`stdout: 'piped'` (devc reads it line by line), `stderr: 'null'`.

`-u <remoteUser>` is required, not cosmetic: reading `/proc/<pid>/environ`
needs the same uid as the attach shell.

The script, whose parsing details are the gotchas in this plan:

```sh
id=$1
prev=; pid=; tries=0
while :; do
  if [ -z "$pid" ] || [ ! -r "/proc/$pid/stat" ]; then
    [ -n "$pid" ] && exit 0                       # the shell we watched is gone
    pid=$(grep -l "DEVC_HERDR_WATCH=$id" /proc/*/environ 2>/dev/null \
            | head -1 | cut -d/ -f3)
    tries=$((tries + 1))
    [ -z "$pid" ] && [ "$tries" -gt 30 ] && exit 0
  fi
  cur=
  if [ -n "$pid" ] && [ -r "/proc/$pid/stat" ]; then
    set -- $(cut -d')' -f2- "/proc/$pid/stat")    # $1 state $2 ppid $3 pgrp $4 sid $5 tty $6 tpgid
    tpgid=$6
    if [ "$tpgid" -gt 0 ] 2>/dev/null && [ "$tpgid" != "$pid" ] \
       && [ -r "/proc/$tpgid/cmdline" ]; then
      cur=$(tr '\0' ' ' < "/proc/$tpgid/cmdline")
    fi
  fi
  [ "$cur" != "$prev" ] && { printf '%s\n' "$cur"; prev=$cur; }
  sleep 1
done
```

- **`tpgid` is the terminal's foreground process group**, field 8 of
  `/proc/<pid>/stat` — field 6 _after_ `cut -d')' -f2-`, which is how you skip a
  `comm` that may itself contain spaces and parens. `tpgid == pid` means the
  shell itself is in the foreground: **no agent**. Measured: bash prompt →
  `tpgid == pid`; `python3 …` in the foreground → a new pgid; a `&` background
  job → back to the shell, correctly _not_ an agent.
- **Read `/proc/<tpgid>/cmdline`, never `ps -g <tpgid>`.** procps' `-g` selects
  by _session_, not process group, and returns nothing for a real foreground
  job. This cost an hour to find; do not "simplify" it back.
- **Match on `cmdline`, not `comm`.** A Node-based agent reports
  `comm=node-MainThread`. (Claude Code in these containers happens to report a
  bare `claude` for both — do not rely on that being true of every agent.)
- **`set --` clobbers `$1`**, hence `id=$1` on the first line.
- **The script must self-terminate.** Killing the host-side `docker exec` client
  does not kill the process inside the container; without the two `exit 0`
  arms it would leak one polling `sh` per attach.

Requires a Linux container with `/proc` — every devcontainer. Stated, not
guarded.

### Mapping a command line to a Herdr kind

`herdrAgentKindFor(cmdline: string): string | null` — pure, exported, the unit
under test. The returned string is passed to `HERDR_AGENT` verbatim, so it must
be a Herdr manifest id (the basenames in
`~/.local/state/herdr/agent-detection/remote/*.toml`).

1. Split on whitespace. Take the basename of argv[0].
2. If that is an interpreter — `node`, `bun`, `deno`, `python`, `python3` —
   re-take the basename of the first following token that does not start with
   `-`. (`node /home/vscode/.local/bin/claude` → `claude`.)
3. If argv[0] is `gh` and the next token is `copilot` → `copilot`.
4. Look up the result in the table; anything unlisted, and any shell
   (`sh`/`bash`/`zsh`/`fish`), returns `null`.

| Command basename            | Kind       |
| --------------------------- | ---------- |
| `claude`, `claude-code`     | `claude`   |
| `codex`                     | `codex`    |
| `copilot`, `github-copilot` | `copilot`  |
| `cursor-agent`              | `cursor`   |
| `gemini`                    | `gemini`   |
| `droid`                     | `droid`    |
| `opencode`                  | `opencode` |
| `amp`                       | `amp`      |
| `grok`                      | `grok`     |
| `pi`                        | `pi`       |
| `kimi`, `kimi-code`         | `kimi`     |
| `kilo`, `kilo-code`         | `kilo`     |
| `devin`                     | `devin`    |
| `hermes`                    | `hermes`   |
| `qoder`                     | `qodercli` |
| `kiro`                      | `kiro`     |
| `maki`                      | `maki`     |
| `antigravity`               | `agy`      |

`devc claude` seeds the sidecar from `options.command` through the same
function before the watcher's first tick, so the pane is correct immediately
rather than a second later.

### The sidecar

A hidden subcommand, mirroring `__devcontainer` exactly — dispatched in
`main.ts` ahead of `--version`/`--help`, deliberately absent from `COMMANDS`:

```
__herdr-sidecar
```

Its body: read `Deno.stdin` to EOF, then exit 0. That is the whole program.

- **Spawned with `stdin: 'piped'`, `stdout: 'null'`, `stderr: 'null'`,
  `env: { HERDR_AGENT: kind }`.** `Deno.Command`'s `env` merges with the
  inherited environment (`clearEnv` defaults false), so `HERDR_ENV` and the rest
  survive. Anything written to stdout would corrupt the agent TUI sharing the
  pane.
- **The stdin pipe is the watchdog.** devc holds the write end; if devc dies for
  any reason the fd closes, the sidecar reads EOF and exits, and the pane stops
  claiming an agent. No polling, no orphan.
- **Never `detached`.** The sidecar is only seen by Herdr because it inherits
  devc's process group; a `setsid` child leaves the pane's foreground group and
  the whole feature silently stops working.
- **Never a trivial process.** Herdr ignores `sleep` and `cat` outright. `devc`
  (compiled) and `deno` (from source) are both honored — measured.

`sidecarArgv(runtime: SelfExecRuntime): string[]`, mirroring `devcontainerArgv`
and testable the same way:

- standalone → `['__herdr-sidecar']`
- from source → `['run', '--allow-env', <mainModule>, '__herdr-sidecar']`

**`--allow-env` alone, and it is required.** Measured: `deno run --no-prompt
main.ts -V` dies with `NotCapable: Requires env access to "HOME"` from a
module-level read in the import graph; `--allow-env` is sufficient and nothing
else is. The sidecar itself needs no permission at all — this is the cost of
importing `main.ts` to reach the dispatch.

### Rotation and teardown

devc keeps at most one sidecar. On each distinct kind from the watcher: kill the
current child (`SIGTERM`, await status), spawn the new one; on `null`, kill and
spawn nothing. Teardown — watcher child killed, sidecar killed — belongs in the
existing `finally` in `attachToContainer` that already runs `resetColors()`, so
it fires on a non-zero exit and on a thrown error too.

## Where it lives

`devc/herdr.ts`, not `devc-core/`. It is TTY-coupled by definition — it exists
to make a _terminal pane_ display something — which is the same boundary
`attach.ts`'s header draws ("the split follows the TTY"). A library consumer of
`devc-core` has no pane.

`attachToContainer` grows one optional field on `AttachOptions` (e.g.
`herdr?: { watchId: string }` or a callback) rather than reaching into the
environment itself, so the gate stays testable and `attach.ts` keeps doing one
thing.

## Relevant Files

| File                          | Change                                                                                                  |
| ----------------------------- | ------------------------------------------------------------------------------------------------------- |
| `devc/herdr.ts`               | **new** — gate, mapping, `sidecarArgv`, watcher script, sidecar lifecycle, `__herdr-sidecar` body       |
| `devc/main.ts`                | dispatch `__herdr-sidecar` beside the `__devcontainer` arm                                              |
| `devc/attach.ts`              | the `DEVC_HERDR_WATCH` env flag, starting the two children, tearing them down in the existing `finally` |
| `devc/deno.json`              | `herdr.ts` added to the `check` task file list                                                          |
| `devc/tests/herdr_test.ts`    | **new** — unit tests for the pure halves                                                                |
| `devc/README.md`              | a `## How it works` subsection: the three env vars and what a Herdr pane shows                          |
| `docs/manual-verification.md` | the Docker + Herdr scenarios from `## Validation`                                                       |
| `.plans/PLAN.md`              | `### Pending` entry and `## Development Phases` row                                                     |

Deliberately untouched: `devc/help.ts` and `devc/args.ts` (the subcommand is
hidden and there is no flag), `devc/container.ts`, and every file under
`devc-core/` (no library consumer has a pane).

## Checklist

- [ ] `devc/herdr.ts` — new module: the enablement gate, `herdrAgentKindFor`,
      the mapping table, `sidecarArgv`, the watcher script builder, the
      spawn/rotate/kill lifecycle, and the `__herdr-sidecar` child body.
      Internal names are the implementer's; the exported contract is the env
      vars, `__herdr-sidecar`, `DEVC_HERDR_WATCH`, and the kind strings above.
- [ ] `devc/main.ts` — dispatch `__herdr-sidecar` immediately after the
      `__devcontainer` arm and before `--version`/`--help`, with the same
      "never returns" comment.
- [ ] `devc/attach.ts` — emit `-e DEVC_HERDR_WATCH=<id>` when enabled; start the
      watcher and seed the sidecar from `options.command`; tear both down in the
      existing `finally`.
- [ ] `devc/deno.json` — add `herdr.ts` to the `check` task's file list.
- [ ] `devc/tests/herdr_test.ts` — new unit tests (below).
- [ ] `devc/README.md` — a subsection under `## How it works`: what appears in a
      Herdr pane, the three environment variables (`HERDR_ENV` gate,
      `HERDR_AGENT` deference, `DEVC_HERDR_AGENT=off|<kind>`), and the fact that
      state comes from Herdr's own manifests, not devc.
- [ ] `docs/manual-verification.md` — a new section for the checks that need
      Docker _and_ a Herdr session.
- [ ] `.plans/PLAN.md` — register in `### Pending` and add the
      `## Development Phases` row.

## Validation

- [ ] `cd devc && deno task check && deno task test` — green, with new cases:
      `herdrAgentKindFor` returns `claude` for `claude`, for
      `node /home/vscode/.local/bin/claude`, and for `claude --resume`;
      `copilot` for `gh copilot`; `cursor` for `cursor-agent`; `null` for
      `bash -l`, for `''`, for `sleep 40`, and for `python3 -c import time`.
- [ ] `sidecarArgv` has both branches covered the way
      `devcontainer_selfexec_test.ts` covers `devcontainerArgv`: standalone
      yields exactly `['__herdr-sidecar']`; from source it yields
      `['run', '--allow-env', <mainModule>, '__herdr-sidecar']`. **Dropping
      `--allow-env` must fail a test** — it is the one flag whose absence turns
      the sidecar into an instant crash that nothing else would notice, since
      the child's output is discarded.
- [ ] The watcher script builder interpolates the id and nothing else: given an
      id, the emitted script contains `DEVC_HERDR_WATCH=<id>` and both `exit 0`
      self-termination arms.
- [ ] `deno run --no-prompt --allow-env devc/main.ts __herdr-sidecar </dev/null`
      exits 0 immediately — the EOF watchdog, provable without Docker.
- [ ] `deno fmt --check` clean at the repo root.
- [ ] (needs Docker + Herdr) **The main case.** From a Herdr pane, `devc attach`
      on a project whose container has Claude: at the bash prompt
      `herdr agent list` shows **no agent** for that pane; launch `claude` and
      within ~5s the pane shows `agent=claude` with a real status;
      `herdr agent explain <pane>` names a matched rule (not only
      `default_known_agent_idle_fallback`) once Claude is working; exit Claude
      and the agent disappears again.
- [ ] (needs Docker + Herdr) **Rotation.** In the same attach, run a second
      agent (or `DEVC_HERDR_AGENT` unset plus any two table entries) and confirm
      the pane follows the switch without a reattach.
- [ ] (needs Docker + Herdr) **Deference.** `HERDR_AGENT=claude devc attach`
      behaves exactly as it does today and devc spawns **no** sidecar — check
      with `pgrep -fa __herdr-sidecar`. This is the regression guard for the
      undefined double-assertion case.
- [ ] (needs Docker + Herdr) **Off switch.** `DEVC_HERDR_AGENT=off devc attach`
      spawns neither watcher nor sidecar; `DEVC_HERDR_AGENT=codex devc attach`
      pins `codex` regardless of what runs in the container, and no watcher
      `docker exec` appears.
- [ ] (needs Docker) **No leak.** After the attach exits — including after
      `ctrl+c` and after killing devc with `SIGKILL` — no `__herdr-sidecar`
      process remains on the host and no watcher `sh` remains in the container
      (`docker exec <c> ps -eo args= | grep DEVC_HERDR_WATCH`). Both halves have
      their own mechanism (EOF, `/proc` disappearance); test both.
- [ ] (needs Docker) **The pane stays clean.** Attach, run a full-screen agent,
      and confirm no stray output from either child lands in the TUI, including
      when the container is stopped underneath a live attach.
- [ ] (no Herdr) `HERDR_ENV` unset — `devc attach` spawns exactly one `docker
      exec`, as it does today. The feature is invisible off-Herdr.

## Not in this plan

- **Reporting agent _state_.** devc asserts identity only; Herdr's manifests
  keep classifying idle/working/blocked. Taking state over is measurably worse
  (see the `report-agent` finding above).
- **A CLI flag.** The gate is environment-only until there is a reason.
- **`devc exec` and non-attach paths.** No interactive pane, no agent to show.
- **Anything for a host tmux inside a Herdr pane.** Herdr sees `tmux` as the
  pane process and detection stops there; that is a Herdr limitation, documented
  by them, and out of scope.
- **Teaching Herdr the `devc` name.** Impossible without a Herdr release, as
  measured.

## Open questions to measure, not assume

1. **Poll interval.** 1s in the container plus Herdr's own ~2–4s reaction was
   comfortable in testing. If the container's `/proc` reads prove expensive
   under load, back off to 2s — but measure before changing it.
2. **Pipelines.** `claude | tee log` puts the pipeline's _first_ process at the
   head of the pgid, which is what gets read. Assumed fine; check if anyone
   actually does it.
3. **Nested multiplexers inside the container.** A `tmux` inside the container
   makes `tpgid` point at `tmux`, not the agent, and the kind becomes `null`.
   Whether to unwrap one level is worth deciding only if it comes up.
