// `resetToken`'s contract: replace, never adopt, and never write through a symlink.
//
// Both properties are security-relevant and neither is visible from a happy-path test, so
// they are pinned here rather than left to review. See
// .plans/archived/devc-bridge-client-download.md.

import { assert, assertEquals, assertNotEquals } from '@std/assert';
import { join } from '@std/path';
import { resetToken } from '../token.ts';

async function withTemp(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: 'devc-bridge-token-' });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

Deno.test('resetToken generates a token and writes it to the file', async () => {
  await withTemp(async (dir) => {
    const path = join(dir, 'token');
    const token = await resetToken(path);

    assertEquals(token.length, 64, 'want 32 random bytes as hex');
    assert(/^[0-9a-f]+$/.test(token), `not hex: ${token}`);
    assertEquals((await Deno.readTextFile(path)).trim(), token);
  });
});

Deno.test('resetToken creates the run dir when it does not exist yet', async () => {
  await withTemp(async (dir) => {
    const path = join(dir, 'nested', 'run', 'token');
    const token = await resetToken(path);
    assertEquals((await Deno.readTextFile(path)).trim(), token);
  });
});

Deno.test('resetToken REPLACES an existing token — it does not adopt it', async () => {
  // The whole reason `ensureToken` was renamed. Adoption was the one way a writable run/
  // became an escalation: a container could write a token it chose and have the next start
  // take it up, handing bridge access to something never given the mount.
  await withTemp(async (dir) => {
    const path = join(dir, 'token');
    const planted = 'a'.repeat(64);
    await Deno.writeTextFile(path, planted + '\n');

    const token = await resetToken(path);

    assertNotEquals(token, planted, 'adopted the planted token');
    assertEquals((await Deno.readTextFile(path)).trim(), token);
  });
});

Deno.test('resetToken returns a different token on every call', async () => {
  await withTemp(async (dir) => {
    const path = join(dir, 'token');
    const a = await resetToken(path);
    const b = await resetToken(path);
    assertNotEquals(a, b);
    assertEquals((await Deno.readTextFile(path)).trim(), b);
  });
});

Deno.test('resetToken replaces a symlinked token path and leaves its target alone', async () => {
  // The regression test for the risk this design introduces. run/ is container-writable
  // whenever the consumer omits `readonly` (and always, under Docker Compose, where the CLI
  // drops it). A container can then replace `token` with a symlink to any host path, and a
  // plain write would follow it and overwrite that file with the new token — an arbitrary
  // host-file write triggered from inside a container. Same-dir temp + rename replaces the
  // link instead of following it.
  await withTemp(async (dir) => {
    const victim = join(dir, 'precious');
    const original = 'do not clobber me\n';
    await Deno.writeTextFile(victim, original);

    const path = join(dir, 'token');
    await Deno.symlink(victim, path);

    const token = await resetToken(path);

    assertEquals(
      await Deno.readTextFile(victim),
      original,
      'wrote through the symlink and clobbered the target',
    );
    assertEquals((await Deno.lstat(path)).isSymlink, false, 'still a symlink');
    assert((await Deno.lstat(path)).isFile, 'token path is not a regular file');
    assertEquals((await Deno.readTextFile(path)).trim(), token);
  });
});

Deno.test('resetToken leaves no temp file behind', async () => {
  await withTemp(async (dir) => {
    await resetToken(join(dir, 'token'));
    const names: string[] = [];
    for await (const e of Deno.readDir(dir)) names.push(e.name);
    assertEquals(names, ['token']);
  });
});
