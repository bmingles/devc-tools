// Makes a `devc attach` running in a Herdr (https://herdr.dev) pane show the agent that is
// actually running *inside* the container, with Herdr's own idle/working/blocked status, and
// show no agent when the container shell is sitting at a prompt.
//
// Herdr answers two separate questions about a pane's foreground process group: identity
// (name-matched against agent kinds compiled into the Herdr binary — a container agent is
// invisible, the host only sees `docker`) and state (its own detection manifests, evaluated
// against the pane's terminal output, which crosses `docker exec` unchanged). This module only
// ever asserts identity, via `HERDR_AGENT` on a disposable child of the pane's process group —
// state keeps coming from Herdr's own manifests. See `.plans/herdr-agent-sidecar.md` for the
// measurements this design is built on (registering `devc` as a Herdr agent kind and
// `pane report-agent` were both tried and rejected there).
//
// Two children, both spawned by `devc attach`, both ordinary members of the pane's foreground
// process group, both silent:
//
//   docker exec … sh -c '<watcher script>'   reports the container's foreground command
//   devc __herdr-sidecar                     env HERDR_AGENT=<kind>, killed and respawned
//
// The watcher prints a line whenever the container's foreground command changes; devc maps that
// line to a Herdr agent kind ({@link herdrAgentKindFor}) and rotates the sidecar
// ({@link startHerdrSidecar}). Prompt → no kind → no sidecar → the pane honestly shows no agent.

import { fromFileUrl } from 'jsr:@std/path';
import type { SelfExecRuntime } from './devcontainer_selfexec.ts';

/**
 * Hidden subcommand that turns a devc process into the sidecar's disposable child — mirrors
 * `__devcontainer` exactly. Dispatched in `main.ts` ahead of `--version`/`--help` and
 * deliberately absent from `COMMANDS`: nobody types this.
 */
export const HERDR_SIDECAR_SUBCOMMAND = '__herdr-sidecar';

/**
 * The env var the attach's `docker exec` carries and the watcher script greps every process's
 * `/proc/<pid>/environ` for — how the watcher finds *this* attach's shell among every process in
 * the container.
 */
export const DEVC_HERDR_WATCH_ENV = 'DEVC_HERDR_WATCH';

// ---------------------------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------------------------

/**
 * The three ways `devc attach`/`devc claude` can relate to Herdr, decided from environment
 * alone (no CLI flag — see the plan's "Enablement" section):
 *
 * - `off` — not in a Herdr pane (`HERDR_ENV` unset), the user already asserted a kind themselves
 *   (`HERDR_AGENT` set — two assertions in one process group is undefined behavior, so devc
 *   defers), or the explicit opt-out (`DEVC_HERDR_AGENT=off`). No watcher, no sidecar.
 * - `pinned` — `DEVC_HERDR_AGENT=<kind>` pins that kind for the whole attach: the sidecar is
 *   spawned once with it and no watcher runs. The escape hatch for a kind the mapping table
 *   below doesn't know.
 * - `watch` — the normal case: a watcher tracks the container's foreground command and rotates
 *   the sidecar to match.
 */
export type HerdrMode =
  | { mode: 'off' }
  | { mode: 'watch' }
  | { mode: 'pinned'; kind: string };

/**
 * Decides {@link HerdrMode} from environment, via an injectable reader so the gate is testable
 * without touching `Deno.env` — the caller (`main.ts`) passes `(k) => Deno.env.get(k)`.
 */
export function herdrMode(
  getEnv: (key: string) => string | undefined,
): HerdrMode {
  if (getEnv('HERDR_ENV') !== '1') return { mode: 'off' };
  if (getEnv('HERDR_AGENT') !== undefined) return { mode: 'off' };
  const pin = getEnv('DEVC_HERDR_AGENT');
  if (pin === undefined || pin === '') return { mode: 'watch' };
  if (pin === 'off') return { mode: 'off' };
  return { mode: 'pinned', kind: pin };
}

// ---------------------------------------------------------------------------------------------
// Mapping a container command line to a Herdr agent kind
// ---------------------------------------------------------------------------------------------

/** Interpreters whose own basename tells us nothing — re-take the basename of their script. */
const INTERPRETERS = new Set(['node', 'bun', 'deno', 'python', 'python3']);

/**
 * Command basename → Herdr manifest id. The value is passed to `HERDR_AGENT` verbatim, so it
 * must be a real manifest id (the basenames under
 * `~/.local/state/herdr/agent-detection/remote/*.toml`) — most agree with their own command
 * name, but `qoder` → `qodercli` and `antigravity` → `agy` do not.
 */
const KIND_TABLE: Record<string, string> = {
  claude: 'claude',
  'claude-code': 'claude',
  codex: 'codex',
  copilot: 'copilot',
  'github-copilot': 'copilot',
  'cursor-agent': 'cursor',
  gemini: 'gemini',
  droid: 'droid',
  opencode: 'opencode',
  amp: 'amp',
  grok: 'grok',
  pi: 'pi',
  kimi: 'kimi',
  'kimi-code': 'kimi',
  kilo: 'kilo',
  'kilo-code': 'kilo',
  devin: 'devin',
  hermes: 'hermes',
  qoder: 'qodercli',
  kiro: 'kiro',
  maki: 'maki',
  antigravity: 'agy',
};

function basenameOf(token: string): string {
  const idx = token.lastIndexOf('/');
  return idx < 0 ? token : token.slice(idx + 1);
}

/**
 * Maps a `/proc/<tpgid>/cmdline`-shaped command line (NUL-separated argv joined with spaces —
 * see the watcher script below) to a Herdr agent kind, or `null` for a shell, an interpreter
 * with nothing recognizable following it, or anything unlisted. Pure — the unit under test.
 *
 * Matches on `cmdline`, never `comm`: a Node-based agent reports `comm=node-MainThread`, so
 * `comm` alone can't tell an agent from its own runtime.
 */
export function herdrAgentKindFor(cmdline: string): string | null {
  const tokens = cmdline.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;

  let base = basenameOf(tokens[0]);

  if (INTERPRETERS.has(base)) {
    const next = tokens.slice(1).find((t) => !t.startsWith('-'));
    if (next === undefined) return null;
    base = basenameOf(next);
  } else if (base === 'gh' && tokens[1] === 'copilot') {
    base = 'copilot';
  }

  return KIND_TABLE[base] ?? null;
}

// ---------------------------------------------------------------------------------------------
// The watcher
// ---------------------------------------------------------------------------------------------

/**
 * Builds the watcher's `sh -c` script body, with `id` baked directly into the `grep` pattern
 * rather than passed as a positional argument: `docker exec … sh -c '<script>' <id>` hands `sh`
 * exactly one extra token, which becomes `$0`, not `$1` (measured — a single trailing operand
 * after the command string is the script's *name*, not its first positional parameter). Baking
 * the id in at build time sidesteps that off-by-one entirely; it is a `crypto.randomUUID()`, so
 * it is always shell-safe to splice into a double-quoted pattern with no further quoting.
 *
 * The parsing past that point is the load-bearing part, verified against Herdr 0.8.0 — do not
 * "simplify" it back:
 * - **`tpgid` is the terminal's foreground process group**, field 8 of `/proc/<pid>/stat` —
 *   field 6 *after* `cut -d')' -f2-`, which is how you skip a `comm` that may itself contain
 *   spaces and parens. `tpgid == pid` means the shell itself is in the foreground: no agent.
 * - **Read `/proc/<tpgid>/cmdline`, never `ps -g <tpgid>`.** procps' `-g` selects by *session*,
 *   not process group, and returns nothing for a real foreground job.
 * - **The script self-terminates** on either the watched shell disappearing or 30 failed
 *   attempts to find it — killing the host-side `docker exec` client does not kill this process
 *   inside the container, so without these two `exit 0` arms it would leak one polling `sh` per
 *   attach.
 */
export function herdrWatcherScript(id: string): string {
  return `prev=; pid=; tries=0
while :; do
  if [ -z "$pid" ] || [ ! -r "/proc/$pid/stat" ]; then
    [ -n "$pid" ] && exit 0                       # the shell we watched is gone
    pid=$(grep -l "${DEVC_HERDR_WATCH_ENV}=${id}" /proc/*/environ 2>/dev/null \\
            | head -1 | cut -d/ -f3)
    tries=$((tries + 1))
    [ -z "$pid" ] && [ "$tries" -gt 30 ] && exit 0
  fi
  cur=
  if [ -n "$pid" ] && [ -r "/proc/$pid/stat" ]; then
    set -- $(cut -d')' -f2- "/proc/$pid/stat")    # $1 state $2 ppid $3 pgrp $4 sid $5 tty $6 tpgid
    tpgid=$6
    if [ "$tpgid" -gt 0 ] 2>/dev/null && [ "$tpgid" != "$pid" ] \\
       && [ -r "/proc/$tpgid/cmdline" ]; then
      cur=$(tr '\\0' ' ' < "/proc/$tpgid/cmdline")
    fi
  fi
  [ "$cur" != "$prev" ] && { printf '%s\\n' "$cur"; prev=$cur; }
  sleep 1
done`;
}

/** Full `docker exec` argv for the watcher: `-u`/`-i`/`-t` matter here — see the call site. */
function herdrWatcherArgs(
  remoteUser: string,
  containerId: string,
  watchId: string,
): string[] {
  return [
    'exec',
    '-u',
    remoteUser,
    containerId,
    'sh',
    '-c',
    herdrWatcherScript(watchId),
  ];
}

// ---------------------------------------------------------------------------------------------
// The sidecar
// ---------------------------------------------------------------------------------------------

/** Permissions the from-source sidecar child needs — see {@link sidecarArgv}'s doc comment. */
const SIDECAR_PERMISSIONS = ['--allow-env'];

/**
 * Full argv for the self-exec that becomes the sidecar, mirroring `devcontainerArgv` in
 * `devcontainer_selfexec.ts` — same reasoning, same branch shape.
 *
 * The sidecar body itself (`runHerdrSidecarBody`) needs no permission at all; `--allow-env`
 * alone is required only because reaching its dispatch in `main.ts` means importing the whole
 * module graph from source, and a module-level env read somewhere in it (`Deno.mainModule`
 * resolution among others) throws `NotCapable` without it. Measured: nothing else is needed.
 */
export function sidecarArgv(runtime: SelfExecRuntime): string[] {
  const self = runtime.standalone ? [] : [
    'run',
    ...SIDECAR_PERMISSIONS,
    fromFileUrl(runtime.mainModule),
  ];
  return [...self, HERDR_SIDECAR_SUBCOMMAND];
}

function currentSelfExecRuntime(): SelfExecRuntime {
  return {
    execPath: Deno.execPath(),
    standalone: Deno.build.standalone,
    mainModule: Deno.mainModule,
  };
}

/**
 * Spawns one sidecar child: `env HERDR_AGENT=<kind>`, stdin piped (the EOF watchdog — see
 * `runHerdrSidecarBody`), stdout/stderr discarded so nothing it could ever print corrupts the
 * agent TUI sharing the pane. Never `detached`: the sidecar is only seen by Herdr because it
 * inherits devc's process group.
 */
function spawnSidecar(
  kind: string,
  runtime: SelfExecRuntime,
): Deno.ChildProcess {
  return new Deno.Command(runtime.execPath, {
    args: sidecarArgv(runtime),
    env: { HERDR_AGENT: kind },
    stdin: 'piped',
    stdout: 'null',
    stderr: 'null',
  }).spawn();
}

async function killChild(child: Deno.ChildProcess): Promise<void> {
  try {
    child.kill('SIGTERM');
  } catch {
    // already exited
  }
  await child.status.catch(() => {});
}

/**
 * The child half of `__herdr-sidecar`: read stdin to EOF, then exit 0. That is the whole
 * program — devc holds the write end as a watchdog, so if devc dies for any reason (including
 * `SIGKILL`, which no `finally` here could ever catch) the pipe closes, this reads EOF, and the
 * pane stops claiming an agent. No polling, no orphan.
 */
export async function runHerdrSidecarBody(): Promise<never> {
  for await (const _chunk of Deno.stdin.readable) {
    // discard — the pipe closing (EOF) is the only signal this program cares about
  }
  Deno.exit(0);
}

// ---------------------------------------------------------------------------------------------
// Rotation and teardown
// ---------------------------------------------------------------------------------------------

async function readLines(
  readable: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
): Promise<void> {
  const reader = readable.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) !== -1) {
        onLine(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** {@link herdrMode}'s `watch`/`pinned` variants, carrying what `startHerdrSidecar` needs from each. */
export type HerdrAttachSpec =
  | { mode: 'watch'; watchId: string }
  | { mode: 'pinned'; kind: string };

/** Returned by {@link startHerdrSidecar}: tears down the watcher and the current sidecar. */
export interface HerdrController {
  /** Kills the watcher (if any) and the current sidecar (if any), and awaits both. Idempotent. */
  stop(): Promise<void>;
}

/**
 * Starts Herdr integration for one attach and keeps at most one sidecar alive for its
 * lifetime — the whole rotation/teardown mechanism from the plan's "Design" section.
 *
 * `spec.mode === 'pinned'`: spawns exactly one sidecar for `spec.kind` and starts no watcher.
 * `spec.mode === 'watch'`: seeds the sidecar from `seedCommand` (so `devc claude` shows the
 * right agent immediately, before the watcher's first tick) via the same
 * {@link herdrAgentKindFor} the watcher's own lines go through, then starts the long-lived
 * watcher `docker exec` and rotates the sidecar — kill the current child, spawn the new one, or
 * kill-and-spawn-nothing on `null` — on each *distinct* kind it reports.
 *
 * `info` is the subset of `ContainerInfo` the watcher's `docker exec -u <remoteUser>
 * <containerId>` needs — `-u` is required, not cosmetic: reading `/proc/<pid>/environ` needs the
 * same uid as the attach shell.
 */
export function startHerdrSidecar(
  info: { containerId: string; remoteUser: string },
  spec: HerdrAttachSpec,
  seedCommand: string | undefined,
  runtime: SelfExecRuntime = currentSelfExecRuntime(),
): HerdrController {
  let currentKind: string | null = null;
  let currentChild: Deno.ChildProcess | null = null;
  let watcherChild: Deno.ChildProcess | null = null;
  let stopped = false;
  const staleKills: Promise<void>[] = [];

  function setSidecar(kind: string | null): void {
    if (stopped || kind === currentKind) return;
    const prev = currentChild;
    currentKind = kind;
    currentChild = kind === null ? null : spawnSidecar(kind, runtime);
    if (prev) staleKills.push(killChild(prev));
  }

  if (spec.mode === 'pinned') {
    setSidecar(spec.kind);
  } else {
    if (seedCommand !== undefined) {
      setSidecar(herdrAgentKindFor(seedCommand));
    }
    // No `-i`, no `-t` — this must never touch the pane's terminal.
    watcherChild = new Deno.Command('docker', {
      args: herdrWatcherArgs(info.remoteUser, info.containerId, spec.watchId),
      stdin: 'null',
      stdout: 'piped',
      stderr: 'null',
    }).spawn();
    readLines(
      watcherChild.stdout,
      (line) => setSidecar(herdrAgentKindFor(line)),
    )
      .catch(() => {});
  }

  return {
    async stop() {
      if (stopped) return;
      stopped = true;
      if (watcherChild) await killChild(watcherChild);
      if (currentChild) staleKills.push(killChild(currentChild));
      currentChild = null;
      await Promise.all(staleKills);
    },
  };
}
