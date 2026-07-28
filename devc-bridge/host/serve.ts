// Headless entrypoint: run the command-bridge core under a plain `deno run`
// (no tray). Used by the in-container validation experiment (TCP loopback).
//
//   deno run --allow-read --allow-write --allow-run --allow-env --allow-net host/serve.ts
//
// Config via env:
//   DEVC_BRIDGE_HOST        bind host              (default 127.0.0.1)
//   DEVC_BRIDGE_PORT        bind port              (default 48227)
//   DEVC_BRIDGE_COMMANDS    command scripts dir    (default ./commands next to this file)
//   DEVC_BRIDGE_STATE       active-marker dir      (default /tmp/devc-bridge/state)
//   DEVC_BRIDGE_TOKEN_FILE  shared token path      (default /tmp/devc-bridge/token)

import { startServer } from "./core.ts";
import { ensureToken } from "./token.ts";

const hostname = Deno.env.get("DEVC_BRIDGE_HOST") ?? "127.0.0.1";
const port = Number(Deno.env.get("DEVC_BRIDGE_PORT") ?? "48227");
const commandsDir = Deno.env.get("DEVC_BRIDGE_COMMANDS") ??
  new URL("./commands", import.meta.url).pathname;
const stateDir = Deno.env.get("DEVC_BRIDGE_STATE") ?? "/tmp/devc-bridge/state";
const tokenFile = Deno.env.get("DEVC_BRIDGE_TOKEN_FILE") ?? "/tmp/devc-bridge/token";

const token = await ensureToken(tokenFile);

const server = await startServer({
  hostname,
  port,
  token,
  commandsDir,
  stateDir,
  onActiveChange: (active) => console.log(`active: ${JSON.stringify(active)}`),
});

console.log(`listening on ${server.address}`);
console.log(`commands: ${commandsDir}`);
console.log(`state:    ${stateDir}`);
console.log(`token:    ${tokenFile}`);

Deno.addSignalListener("SIGINT", () => {
  server.close();
  Deno.exit(0);
});
Deno.addSignalListener("SIGTERM", () => {
  server.close();
  Deno.exit(0);
});
