// Shared-secret token management for the bridge.
//
// The token file is a *delivery channel*, not an authority. The running server compares
// every request against the token it holds in memory (`core.ts`), so a container writing
// this file grants itself nothing — it only breaks its own next call.
//
// Two consequences shape the code below.
//
// A fresh token is generated on every start rather than adopting whatever is in the file.
// Adoption was the one way a writable run/ became an escalation: a container could pin an
// attacker-chosen secret and have the *next* start take it up, handing bridge access to
// something that was never given the mount. Regenerating costs nothing, because the client
// re-reads the file on every invocation and the mount is a live directory — a running
// container picks the new value up with nothing restarted.
//
// The write must assume the directory is container-writable. devc mounts run/ read-only,
// but that is the consumer's devcontainer.json to get right, and a Docker Compose
// devcontainer cannot have it at all (the CLI drops `readonly` when generating the compose
// file). A container that can write the directory can replace `token` with a symlink to any
// host path, and a plain write would follow it and overwrite that file with the new token.
// So every write goes to a temp file in the *same* directory and is renamed into place:
// rename replaces a symlink instead of following it, and is atomic, so a client never reads
// a half-written token. Mode is 0644 because the container user may map to a different uid
// and must still read it — on a Docker Desktop bind mount the mode is cosmetic anyway.

import { dirname, join } from '@std/path';

/**
 * Generate a new token and write it to `path`, replacing whatever was there.
 *
 * Deliberately *not* "load or create": see the file header. Renamed from `ensureToken` so
 * that a caller expecting the old adopt-if-present behavior fails to compile rather than
 * silently changing meaning.
 */
export async function resetToken(path: string): Promise<string> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const token = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(
    '',
  );
  await writeTokenFile(path, token);
  return token;
}

/**
 * Write `token` to `path` without ever following a symlink at `path`.
 *
 * Same-directory temp + rename: `Deno.rename` replaces the link itself, so a planted
 * symlink is destroyed rather than written through, and the swap is atomic for readers.
 */
async function writeTokenFile(path: string, token: string): Promise<void> {
  const dir = dirname(path);
  await Deno.mkdir(dir, { recursive: true });
  const tmp = join(dir, `.token.tmp.${crypto.randomUUID()}`);
  try {
    await Deno.writeTextFile(tmp, token + '\n');
    await Deno.chmod(tmp, 0o644);
    await Deno.rename(tmp, path);
  } catch (e) {
    await Deno.remove(tmp).catch(() => {});
    throw e;
  }
}
