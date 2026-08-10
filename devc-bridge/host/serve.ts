// Headless entrypoint: run the command-bridge core under a plain `deno run`
// (no tray). Used by the in-container validation experiment (TCP loopback).
//
//   deno run --allow-read --allow-write --allow-run --allow-env --allow-net host/serve.ts
//
// Config via env:
//   DEVC_BRIDGE_HOST                bind host              (default 127.0.0.1)
//   DEVC_BRIDGE_PORT                bind port              (default 48227)
//   DEVC_BRIDGE_COMMANDS            command scripts dir    (default ./commands next to this file)
//   DEVC_BRIDGE_STATE               active-marker dir      (default /tmp/devc-bridge/state)
//   DEVC_BRIDGE_TOKEN_FILE          shared token path      (default /tmp/devc-bridge/token)
//   DEVC_BRIDGE_KEEPAWAKE_COMMAND   keepalive script       (default caffeinate)
//   DEVC_BRIDGE_KEEPAWAKE_IDLE_MS   keepalive idle timeout (default 300000)
//
// Keepawake is opt-in here (unlike the tray's always-on Config.keepawake): the
// `ping` builtin is only intercepted when at least one of the two
// DEVC_BRIDGE_KEEPAWAKE_* vars is set, so §A can exercise both the keepalive
// behavior and the unconfigured fall-through (`ping` → `unknown command: ping`)
// from the same headless entrypoint.

import { startServer } from './core.ts';
import { ensureToken } from './token.ts';
import { parseIdleMs } from './config.ts';

const hostname = Deno.env.get('DEVC_BRIDGE_HOST') ?? '127.0.0.1';
const port = Number(Deno.env.get('DEVC_BRIDGE_PORT') ?? '48227');
const commandsDir = Deno.env.get('DEVC_BRIDGE_COMMANDS') ??
  new URL('./commands', import.meta.url).pathname;
const stateDir = Deno.env.get('DEVC_BRIDGE_STATE') ?? '/tmp/devc-bridge/state';
const tokenFile = Deno.env.get('DEVC_BRIDGE_TOKEN_FILE') ??
  '/tmp/devc-bridge/token';

const keepawakeCommandRaw = Deno.env.get('DEVC_BRIDGE_KEEPAWAKE_COMMAND');
const keepawakeIdleMsRaw = Deno.env.get('DEVC_BRIDGE_KEEPAWAKE_IDLE_MS');
const keepawake = (keepawakeCommandRaw !== undefined ||
    keepawakeIdleMsRaw !== undefined)
  ? {
    command: keepawakeCommandRaw || 'caffeinate',
    idleMs: parseIdleMs(keepawakeIdleMsRaw),
  }
  : undefined;

const token = await ensureToken(tokenFile);

const server = await startServer({
  hostname,
  port,
  token,
  commandsDir,
  stateDir,
  onActiveChange: (active) => console.log(`active: ${JSON.stringify(active)}`),
  keepawake,
});

console.log(`listening on ${server.address}`);
console.log(`commands: ${commandsDir}`);
console.log(`state:    ${stateDir}`);
console.log(`token:    ${tokenFile}`);
console.log(
  keepawake
    ? `keepawake: ${keepawake.command} (idleMs: ${keepawake.idleMs})`
    : 'keepawake: not configured',
);

Deno.addSignalListener('SIGINT', async () => {
  await server.close();
  Deno.exit(0);
});
Deno.addSignalListener('SIGTERM', async () => {
  await server.close();
  Deno.exit(0);
});
