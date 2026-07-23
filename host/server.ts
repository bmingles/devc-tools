// Desktop entrypoint: run the command bridge WITH a macOS menu-bar tray.
//
//   deno desktop host/server.ts   (see host/deno.json tasks: host:dev / host:build)
//
// It wraps the headless core (core.ts) and subscribes to active-set changes to
// repaint the tray icon (idle vs. active), tooltip, and menu. All socket/dispatch
// logic lives in core.ts and is tested headless inside the devcontainer; this file
// is host-only (needs a GUI + `deno desktop`) and is verified per plan §B.

import { startServer } from "./core.ts";
import { ensureToken } from "./token.ts";

const home = Deno.env.get("HOME") ?? ".";
const hostname = Deno.env.get("DEVC_HOST_HOST") ?? "127.0.0.1";
const port = Number(Deno.env.get("DEVC_HOST_PORT") ?? "48227");
// Command scripts are host-editable, so they must live at a stable absolute path —
// NOT ./commands relative to import.meta.url, which `deno desktop` resolves into the
// ephemeral temp bundle dir. Seed ~/.config/devc-tools/commands from this repo (copy or
// symlink); see docs/testing.md.
const commandsDir = Deno.env.get("DEVC_HOST_COMMANDS") ?? `${home}/.config/devc-tools/commands`;
const stateDir = Deno.env.get("DEVC_HOST_STATE") ?? `${home}/.config/devc-tools/state`;
const tokenFile = Deno.env.get("DEVC_HOST_TOKEN_FILE") ?? `${home}/.config/devc-tools/run/token`;

// Icons are embedded (base64) rather than read from disk: `deno desktop` runs the
// bundled entrypoint from a temp dir, so a path relative to import.meta.url would
// point at a nonexistent `.../T/icons/idle.png`. Keep these in sync with icons/*.png
// (they are tiny template PNGs; regenerate with: base64 -w0 icons/idle.png).
const ICON_IDLE_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAABYAAAAWCAYAAADEtGw7AAAAmElEQVR42sWVyxGAIAxE7YQ+6IFeuKcFmqMDGmE0h1xckQmjq5l5Fz5LWCBs288RlGiEN8SK0pQdaNa3vEhW+kAQ6TbWFcUhiBRPpjipKqIkQ6wNx+WZp7h9mSQhA1uCxwJx2CYeSxps3xsVbsvFhtVs77I+2RGhMy0IJ5gbPxGmWUE7POp1oz0Q2pOmFiFq2aQWeurX9CgOudGk4ZXdJwgAAAAASUVORK5CYII=";
const ICON_ACTIVE_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAABYAAAAWCAYAAADEtGw7AAAAeklEQVR42sWVwQ3AIAhF3cQ9nMpBGJJFCOXApcQarfyW5J00T/NVLOXnqkZzaoaMDDY0wD62vUg3ZCCMiM9dKloQRmhlp/qSPstUDsTylDkdSKeRcIKYRzFoErc4WqK4fSKGRQE7POh1gz0Q2JOGNiFo24Q2eujXdFQXv7QL2NPzn44AAAAASUVORK5CYII=";

function decodeIcon(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

const idleIcon = decodeIcon(ICON_IDLE_B64);
const activeIcon = decodeIcon(ICON_ACTIVE_B64);

// Menu-bar-only app: no dock icon, no visible window. `deno desktop` always creates an
// implicit window that navigates to a local HTTP server we don't run (hence the
// "Server not ready after 15s, navigating anyway" wait). Hide the dock icon, adopt that
// implicit window (the first `new BrowserWindow()` adopts it), point it at a blank URL
// so it stops waiting on the missing server, and hide it. All guarded — these are 2.9
// desktop APIs, platform-specific, and only meaningful under `deno desktop`.
// deno-lint-ignore no-explicit-any
const D = Deno as any;
try {
  D.dock?.setVisible(false); // macOS: drop from dock + Cmd-Tab (accessory app)
} catch { /* non-macOS or running headless */ }
try {
  const win = new D.BrowserWindow();
  win.navigate("data:text/html,<html></html>"); // don't wait on the auto HTTP server
  win.hide();
} catch { /* no implicit window (e.g. headless) */ }

// `deno desktop` waits (up to 15s) for a Deno.serve() listener on DENO_SERVE_ADDRESS to
// come up before it finishes launching — without one it logs "Server not ready after
// 15s, navigating anyway". We have no web UI, so bind a trivial no-op server (it
// auto-binds to DENO_SERVE_ADDRESS under `deno desktop`) purely to satisfy that
// handshake. onListen is silenced so it doesn't print a "Listening on…" line.
try {
  Deno.serve({ onListen() {} }, () => new Response(""));
} catch { /* not running under deno desktop */ }

const tray = new D.Tray();

function render(active: string[]) {
  const awake = active.length > 0;
  tray.setIcon(awake ? activeIcon : idleIcon);
  tray.setTooltip(
    awake ? `devc-host: active — ${active.join(", ")}` : "devc-host: idle",
  );

  const menu: unknown[] = [];
  if (awake) {
    for (const name of active) {
      menu.push({ item: { label: `● ${name}`, id: `active:${name}`, enabled: false } });
    }
    menu.push("separator");
  } else {
    menu.push({ item: { label: "idle", id: "idle", enabled: false } });
    menu.push("separator");
  }
  menu.push({ item: { label: "Open commands folder", id: "open-commands", enabled: true } });
  menu.push({ item: { label: "Quit", id: "quit", enabled: true } });
  tray.setMenu(menu);
}

tray.addEventListener("menuclick", (e: { detail: { id: string } }) => {
  switch (e.detail.id) {
    case "quit":
      server.close();
      Deno.exit(0);
      break;
    case "open-commands":
      new Deno.Command("open", { args: [commandsDir] }).spawn();
      break;
  }
});

const token = await ensureToken(tokenFile);

const server = await startServer({
  hostname,
  port,
  token,
  commandsDir,
  stateDir,
  onActiveChange: render,
});

console.error(`devc-host listening on ${server.address} (commands: ${commandsDir})`);
