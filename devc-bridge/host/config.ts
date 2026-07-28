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

import { join } from "jsr:@std/path@^1";

export interface Config {
  /** Root of the config tree (default ~/.config/devc-bridge). */
  base: string;
  /** Bind-mounted run dir: token + pidfile live here. */
  run: string;
  /** Active-marker dir watched by the tray. */
  state: string;
  /** Editable, allowlisted command scripts (seeded on first start). */
  commands: string;
  /** Shared-secret token file (inside run/, read by the container client). */
  token: string;
  /** Pidfile for the background tray process. */
  pidfile: string;
  /** Log file the detached tray's stdout/stderr is appended to. */
  logfile: string;
  /** TCP bind host (reachable from the container via host.docker.internal). */
  hostname: string;
  /** TCP bind port. */
  port: number;
}

export function loadConfig(): Config {
  const home = Deno.env.get("HOME") ?? ".";
  const base = Deno.env.get("DEVC_BRIDGE_BASE") ?? join(home, ".config", "devc-bridge");
  const run = join(base, "run");
  return {
    base,
    run,
    state: Deno.env.get("DEVC_BRIDGE_STATE") ?? join(base, "state"),
    commands: Deno.env.get("DEVC_BRIDGE_COMMANDS") ?? join(base, "commands"),
    token: Deno.env.get("DEVC_BRIDGE_TOKEN_FILE") ?? join(run, "token"),
    pidfile: join(run, "tray.pid"),
    logfile: join(base, "devc-bridge.log"),
    hostname: Deno.env.get("DEVC_BRIDGE_HOST") ?? "127.0.0.1",
    port: Number(Deno.env.get("DEVC_BRIDGE_PORT") ?? "48227"),
  };
}

/** Create the runtime dirs and seed missing command scripts. Idempotent. */
export async function ensureConfig(cfg: Config): Promise<void> {
  await ensureDir(cfg.run);
  await ensureDir(cfg.state);
  await ensureDir(cfg.commands);
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
    let kind = "not a directory";
    try {
      if ((await Deno.stat(path)).isDirectory) return; // symlink to a real dir — fine
    } catch {
      const link = await Deno.readLink(path).catch(() => null);
      kind = link === null
        ? "not a directory"
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
  const embedded = new URL("./commands", import.meta.url);
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
    const content = await Deno.readFile(new URL(`./commands/${entry.name}`, import.meta.url));
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
    await Deno.writeTextFile(logfile, msg.endsWith("\n") ? msg : `${msg}\n`, { append: true });
  } catch { /* diagnostics only — never fail the caller */ }
}
