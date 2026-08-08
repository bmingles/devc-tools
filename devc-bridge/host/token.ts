// Shared-secret token management for the bridge.
//
// The token is written to a file inside the bind-mounted run dir so the container
// client can read it (regular files cross the Docker Desktop mount fine). Mode 0644
// so the container user — which may map to a different uid than the host user — can
// still read it. Threat model: this keeps *other containers that never mounted the
// run dir* from invoking host commands over the loopback TCP port; it does not
// defend against other processes/users with filesystem access to your home dir.

import { dirname } from 'jsr:@std/path@^1';

/** Load the token at `path`, or generate + persist a new one if absent. */
export async function ensureToken(path: string): Promise<string> {
  try {
    const existing = (await Deno.readTextFile(path)).trim();
    if (existing.length > 0) return existing;
  } catch {
    // fall through to generate
  }
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const token = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(
    '',
  );
  await Deno.mkdir(dirname(path), { recursive: true });
  await Deno.writeTextFile(path, token + '\n');
  await Deno.chmod(path, 0o644);
  return token;
}
