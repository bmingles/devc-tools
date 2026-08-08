// devc-bridge — host-side control CLI for the devcontainer command bridge.
//
//   devc-bridge start     seed config (first run) + build & launch the tray in the background
//   devc-bridge stop      stop the background tray
//   devc-bridge status    report whether the tray is running
//   devc-bridge restart    stop then start
//   devc-bridge run       run the tray (this file, launched inside the built .app)
//
// main.ts plays two roles from one file:
//   • As a plain `deno run` CLI (start/stop/status) it's the *controller* — fast, no
//     desktop runtime, no window. `start` builds a .app bundle from this source (fast —
//     Deno caches the compile) and launches it with `open -g`, because a menu-bar GUI
//     app can only be backgrounded via LaunchServices, not by detaching a terminal
//     process. stop/status use the pidfile the tray writes.
//   • Inside that built .app it runs with no args → the tray (runTray in tray.ts).

import { dirname, fromFileUrl, join } from 'jsr:@std/path@^1';
import { type Config, ensureConfig, errMsg, loadConfig } from './config.ts';
import { runTray } from './tray.ts';

const USAGE = 'usage: devc-bridge {start|stop|status|restart|run}';

async function main(): Promise<void> {
  const cfg = loadConfig();
  const sub = Deno.args[0];
  switch (sub) {
    case 'start':
      await start(cfg);
      break;
    case 'stop':
      await stop(cfg);
      break;
    case 'status':
      await status(cfg);
      break;
    case 'restart':
      await stop(cfg);
      await start(cfg);
      break;
    case undefined:
    case 'run':
      await runTray(cfg); // never returns
      break;
    default:
      console.error(`devc-bridge: unknown command ${JSON.stringify(sub)}`);
      console.error(USAGE);
      Deno.exit(2);
  }
}

async function start(cfg: Config): Promise<void> {
  await ensureConfig(cfg);

  const existing = await readPid(cfg);
  if (existing !== null && await pidAlive(existing)) {
    console.log(`already running (pid ${existing})`);
    return;
  }
  // Drop any stale pidfile so the fresh one the tray writes is our success signal.
  await removePidfile(cfg);

  // Build the tray bundle from this source. Deno caches the compile, so rebuilding on
  // every start is cheap and always reflects the current source. --include embeds the
  // command scripts; paths are relative to the host/ dir (where main.ts lives).
  const appPath = join(cfg.base, 'DevcBridge.app');
  const hostDir = dirname(fromFileUrl(Deno.mainModule));
  console.error('devc-bridge: building tray app…');
  const build = await new Deno.Command('deno', {
    args: [
      'desktop',
      '--output',
      appPath,
      '--include',
      'commands',
      '--icon',
      '../icons/app.png',
      '--allow-read',
      '--allow-write',
      '--allow-run',
      '--allow-env',
      '--allow-net',
      'main.ts',
    ],
    cwd: hostDir,
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  if (!build.success) {
    console.error('devc-bridge: failed to build the tray app:');
    await Deno.stderr.write(build.stderr);
    Deno.exit(1);
  }

  // Launch it via LaunchServices (`-g` = don't steal focus). A GUI app can only be put
  // in the background this way — a detached terminal process never brings the tray up.
  console.error('devc-bridge: launching…');
  const opened = await new Deno.Command('open', { args: ['-g', appPath] })
    .output();
  if (!opened.success) {
    console.error(`devc-bridge: 'open -g ${appPath}' failed:`);
    await Deno.stderr.write(opened.stderr);
    Deno.exit(1);
  }

  // The tray writes its pidfile once it's listening — our proof it came up.
  const ok = await waitFor(async () => {
    const pid = await readPid(cfg);
    return pid !== null && await pidAlive(pid);
  }, 30_000);

  if (!ok) {
    console.error(
      `devc-bridge: tray launched but never reported ready — see ${cfg.logfile}`,
    );
    await printLogTail(cfg.logfile);
    console.error(
      `devc-bridge: (to see its errors directly, run: open ${appPath})`,
    );
    Deno.exit(1);
  }

  console.log(`started (pid ${await readPid(cfg)})`);
}

async function stop(cfg: Config): Promise<void> {
  const pid = await readPid(cfg);
  if (pid === null) {
    console.log('not running');
    return;
  }
  try {
    Deno.kill(pid, 'SIGTERM');
  } catch {
    // Process already gone — fall through to clear the stale pidfile.
    console.log('not running');
    await removePidfile(cfg);
    return;
  }
  // Wait for it to actually exit before returning, so `restart` doesn't race the old
  // process for the TCP port (the tray's SIGTERM handler also removes the pidfile).
  await waitFor(async () => !await pidAlive(pid), 3000);
  await removePidfile(cfg);
  console.log('stopped');
}

async function status(cfg: Config): Promise<void> {
  const pid = await readPid(cfg);
  if (pid !== null && await pidAlive(pid)) {
    const active = await scanActive(cfg.state);
    const suffix = active.length > 0
      ? ` — active: ${active.join(', ')}`
      : ' — idle';
    console.log(`running (pid ${pid})${suffix}`);
    return;
  }
  if (pid !== null) await removePidfile(cfg); // stale
  console.log('stopped');
  Deno.exit(1);
}

// --- helpers -------------------------------------------------------------------

async function readPid(cfg: Config): Promise<number | null> {
  try {
    const raw = (await Deno.readTextFile(cfg.pidfile)).trim();
    const pid = Number(raw);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** Liveness probe: SIGCONT is benign to a running process; ESRCH ⇒ dead. */
async function pidAlive(pid: number): Promise<boolean> {
  await Promise.resolve();
  try {
    Deno.kill(pid, 'SIGCONT');
    return true;
  } catch {
    return false;
  }
}

async function removePidfile(cfg: Config): Promise<void> {
  try {
    await Deno.remove(cfg.pidfile);
  } catch { /* already gone */ }
}

async function scanActive(stateDir: string): Promise<string[]> {
  const active: string[] = [];
  try {
    for await (const entry of Deno.readDir(stateDir)) {
      if (entry.isFile) active.push(entry.name);
    }
  } catch { /* no state dir yet */ }
  return active.sort();
}

/** Poll `check` until it returns true or `ms` elapses. */
async function waitFor(
  check: () => Promise<boolean>,
  ms: number,
): Promise<boolean> {
  const deadline = performance.now() + ms;
  while (performance.now() < deadline) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return await check();
}

async function printLogTail(logfile: string, lines = 20): Promise<void> {
  try {
    const text = await Deno.readTextFile(logfile);
    const tail = text.split('\n').slice(-lines).join('\n');
    if (tail.trim().length > 0) console.error(tail);
  } catch (e) {
    console.error(`devc-bridge: (no log at ${logfile}: ${errMsg(e)})`);
  }
}

try {
  await main();
} catch (e) {
  // Our own failures carry a "devc-bridge: …" message and are worth reading on their own;
  // anything else is a bug, so keep its stack.
  if (e instanceof Error && e.message.startsWith('devc-bridge:')) {
    console.error(e.message);
  } else {
    console.error('devc-bridge: unexpected failure');
    console.error(e);
  }
  Deno.exit(1);
}
