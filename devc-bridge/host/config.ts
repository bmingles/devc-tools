// Shared configuration: where the bridge keeps its runtime files, and how the
// self-contained binary seeds its editable command scripts on first start.
//
// Everything lives under a single base dir (default ~/.config/devc-bridge). The
// per-dir env overrides that predate this file are still honored so existing
// setups keep working; DEVC_BRIDGE_BASE relocates the whole tree at once.
//
// Seeding is what makes a shared binary "just work": the command scripts are
// embedded at build time (`deno desktop --include commands`) and are readable at
// runtime via a URL relative to this module. On start we copy any that are missing
// into the editable commands dir — we never overwrite, since those scripts are the
// host's to edit. Under `deno task dev` (uncompiled) the same URL resolves to the
// repo's host/commands, so seeding still works without a build.

import { join } from '@std/path';

export interface Config {
  /** Root of the config tree (default ~/.config/devc-bridge). */
  base: string;
  /** Bind-mounted run dir: the token lives here, and nothing else. */
  run: string;
  /** Active-marker dir watched by the tray. */
  state: string;
  /** Editable, allowlisted command scripts (seeded on first start). */
  commands: string;
  /**
   * Bind-mounted client dir: holds the Linux `devc-bridge` the container runs.
   *
   * Nothing here is built on the fly — this is a *destination* that the release
   * installer (typical user) or `deno task build:client` (developer) writes to.
   * Unlike `commands`, the binary is never user-owned: both paths overwrite it.
   */
  client: string;
  /** The client binary itself, inside `client`. */
  clientBin: string;
  /** Shared-secret token file (inside run/, read by the container client). */
  token: string;
  /**
   * Pidfile for the background tray process.
   *
   * In `base/`, deliberately *not* in the bind-mounted `run/`. `stop` `Deno.kill`s
   * whatever PID it reads here, so a container that can write the file can pick the
   * host process that gets SIGTERM. The mount is read-only, which already closes
   * that — but the devc-bridge Feature is unsupported on Docker Compose
   * devcontainers, where `readonly` does not survive into the generated compose
   * file, and this is what keeps the worst of that from being reachable.
   */
  pidfile: string;
  /** Log file the detached tray's stdout/stderr is appended to. */
  logfile: string;
  /** TCP bind host (reachable from the container via host.docker.internal). */
  hostname: string;
  /** TCP bind port. */
  port: number;
  /** Keepalive policy: which allowlisted script to drive, and the idle timeout. */
  keepawake: { command: string; idleMs: number };
  /** Persisted runtime settings (see `Settings`). */
  settingsFile: string;
}

/**
 * Runtime settings that survive in a file rather than only in the environment.
 *
 * `devc-bridge start` runs in your shell, but the tray it launches goes through
 * `open -g` → LaunchServices, which starts the app under launchd's environment,
 * *not* the shell's. So `DEVC_BRIDGE_KEEPAWAKE_IDLE_MS=… devc-bridge start` would
 * set the variable in the one process that doesn't use it and leave it unset in
 * the one that does. `start` therefore captures whichever of these vars are set
 * in its own env and writes them here for the tray to read at launch.
 *
 * Paths (base/state/commands/token) are deliberately not persisted — `base` is
 * where this file itself lives, so storing it here would be circular.
 */
export interface Settings {
  hostname?: string;
  port?: number;
  keepawakeCommand?: string;
  keepawakeIdleMs?: number;
}

/** Env var → settings key, for the vars the tray needs but can't inherit. */
const SETTING_ENV: Record<string, keyof Settings> = {
  DEVC_BRIDGE_HOST: 'hostname',
  DEVC_BRIDGE_PORT: 'port',
  DEVC_BRIDGE_KEEPAWAKE_COMMAND: 'keepawakeCommand',
  DEVC_BRIDGE_KEEPAWAKE_IDLE_MS: 'keepawakeIdleMs',
};

const NUMERIC_SETTINGS = new Set<keyof Settings>(['port', 'keepawakeIdleMs']);

/** Default idle timeout: must exceed the longest plausible ping gap (long tool
 * runs, permission-prompt think time), not merely "how fast to notice Claude
 * finished." See .plans/archived/devc-bridge-keepawake.md. */
const DEFAULT_KEEPAWAKE_IDLE_MS = 300_000;

/** Parse `DEVC_BRIDGE_KEEPAWAKE_IDLE_MS`-style values: non-numeric/≤0 → default. */
export function parseIdleMs(
  raw: string | undefined,
  fallback = DEFAULT_KEEPAWAKE_IDLE_MS,
): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Read the settings file. Missing or malformed → `{}` (never fatal: a bad file
 * must not stop the tray from starting on defaults). */
export function readSettings(path: string): Settings {
  let raw: string;
  try {
    raw = Deno.readTextFileSync(path);
  } catch {
    return {}; // not written yet — the common case
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' ? parsed : {};
  } catch (e) {
    console.error(`devc-bridge: ignoring malformed ${path}: ${errMsg(e)}`);
    return {};
  }
}

/** Positive finite number, or undefined — the shape every stored numeric must pass. */
function storedNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;
}

export function loadConfig(): Config {
  const home = Deno.env.get('HOME') ?? '.';
  const base = Deno.env.get('DEVC_BRIDGE_BASE') ??
    join(home, '.config', 'devc-bridge');
  const run = join(base, 'run');
  const client = join(base, 'client');
  const settingsFile = join(base, 'settings.json');
  // Precedence: this process's env → the file `start` wrote → built-in default.
  const stored = readSettings(settingsFile);
  return {
    base,
    run,
    state: Deno.env.get('DEVC_BRIDGE_STATE') ?? join(base, 'state'),
    commands: Deno.env.get('DEVC_BRIDGE_COMMANDS') ?? join(base, 'commands'),
    client,
    clientBin: join(client, 'devc-bridge'),
    token: Deno.env.get('DEVC_BRIDGE_TOKEN_FILE') ?? join(run, 'token'),
    pidfile: join(base, 'tray.pid'),
    logfile: join(base, 'devc-bridge.log'),
    settingsFile,
    hostname: Deno.env.get('DEVC_BRIDGE_HOST') || stored.hostname ||
      '127.0.0.1',
    port: Number(
      Deno.env.get('DEVC_BRIDGE_PORT') || storedNumber(stored.port) || 48227,
    ),
    keepawake: {
      command: Deno.env.get('DEVC_BRIDGE_KEEPAWAKE_COMMAND') ||
        stored.keepawakeCommand || 'caffeinate',
      idleMs: parseIdleMs(
        Deno.env.get('DEVC_BRIDGE_KEEPAWAKE_IDLE_MS'),
        storedNumber(stored.keepawakeIdleMs) ?? DEFAULT_KEEPAWAKE_IDLE_MS,
      ),
    },
  };
}

/**
 * Merge the `DEVC_BRIDGE_*` runtime settings present in *this* process's env into
 * the settings file, so the launchd-started tray picks them up. Called by `start`.
 *
 * An explicitly empty value (`DEVC_BRIDGE_KEEPAWAKE_IDLE_MS= devc-bridge restart`)
 * removes the stored key and reverts that setting to its default — otherwise there
 * would be no way to undo a value short of editing the file by hand.
 *
 * Returns a `key=value` description of what changed, for `start` to report.
 */
export async function persistEnvSettings(cfg: Config): Promise<string[]> {
  const stored = readSettings(cfg.settingsFile);
  const next: Record<string, unknown> = { ...stored };
  const changed: string[] = [];

  for (const [envVar, key] of Object.entries(SETTING_ENV)) {
    const raw = Deno.env.get(envVar);
    if (raw === undefined) continue; // not set — leave any stored value alone
    if (raw === '') {
      if (key in next) {
        delete next[key];
        changed.push(`${key}=(default)`);
      }
      continue;
    }
    let value: string | number = raw;
    if (NUMERIC_SETTINGS.has(key)) {
      const n = Number(raw);
      if (!Number.isFinite(n) || n <= 0) {
        console.error(
          `devc-bridge: ignoring ${envVar}=${raw} (not a positive number)`,
        );
        continue;
      }
      value = n;
    }
    if (next[key] === value) continue;
    next[key] = value;
    changed.push(`${key}=${value}`);
  }

  if (changed.length > 0) {
    await Deno.writeTextFile(
      cfg.settingsFile,
      JSON.stringify(next, null, 2) + '\n',
    );
  }
  return changed;
}

/** Create the runtime dirs and seed missing command scripts. Idempotent. */
export async function ensureConfig(cfg: Config): Promise<void> {
  await ensureDir(cfg.run);
  await ensureDir(cfg.state);
  await ensureDir(cfg.commands);
  // The bind-mount source for the container's client. Created (never filled) here so the
  // mount resolves; `start` deliberately builds no client — see `Config.client`.
  await ensureDir(cfg.client);
  await seedCommands(cfg.commands);
}

/**
 * `mkdir -p`, but with a legible failure. A recursive mkdir still throws `AlreadyExists`
 * when the path exists yet doesn't *resolve* to a directory — a dangling symlink (e.g. one
 * left over from an older layout) or a plain file — so name that case instead of surfacing
 * a bare os error 17.
 */
async function ensureDir(path: string): Promise<void> {
  try {
    await Deno.mkdir(path, { recursive: true });
  } catch (e) {
    if (!(e instanceof Deno.errors.AlreadyExists)) throw e;
    let kind = 'not a directory';
    try {
      if ((await Deno.stat(path)).isDirectory) return; // symlink to a real dir — fine
    } catch {
      const link = await Deno.readLink(path).catch(() => null);
      kind = link === null
        ? 'not a directory'
        : `a broken symlink → ${link} (retarget or remove it)`;
    }
    throw new Error(`devc-bridge: ${path} is ${kind}`);
  }
}

/**
 * Copy the embedded command scripts into `commandsDir`, skipping any that already
 * exist (they are host-editable — never clobber). Returns the names written.
 */
export async function seedCommands(commandsDir: string): Promise<string[]> {
  const embedded = new URL('./commands', import.meta.url);
  const written: string[] = [];
  let entries: AsyncIterable<Deno.DirEntry>;
  try {
    entries = Deno.readDir(embedded);
  } catch (e) {
    // No embedded commands (shouldn't happen in a proper build) — nothing to seed.
    console.error(`devc-bridge: cannot read embedded commands: ${errMsg(e)}`);
    return written;
  }
  for await (const entry of entries) {
    if (!entry.isFile) continue;
    const target = join(commandsDir, entry.name);
    try {
      await Deno.lstat(target);
      continue; // already present — leave the host's copy alone
    } catch {
      // not present — seed it
    }
    const content = await Deno.readFile(
      new URL(`./commands/${entry.name}`, import.meta.url),
    );
    await Deno.writeFile(target, content);
    await Deno.chmod(target, 0o755);
    written.push(entry.name);
  }
  return written;
}

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Append a line to the log file (best-effort). The tray is launched via `open`, so its
 * console output isn't visible anywhere — this is how `devc-bridge start` surfaces why a
 * launch failed.
 */
export async function appendLog(logfile: string, msg: string): Promise<void> {
  try {
    await Deno.writeTextFile(logfile, msg.endsWith('\n') ? msg : `${msg}\n`, {
      append: true,
    });
  } catch { /* diagnostics only — never fail the caller */ }
}
