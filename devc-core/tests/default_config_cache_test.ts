// `ensureDefaultConfig` — the content-addressed zero-config cache — and the key it is addressed
// by. The plain materializer (`materializeDefaultConfig`) is covered in `default_config_test.ts`
// and is deliberately untouched by any of this: the two-function split is what lets those tests
// keep passing unmodified.
//
// Nothing here can observe the key directly (it is module-private, and rightly so — it is an
// implementation detail of a path). Everything is asserted through the *path* `ensureDefaultConfig
// ` returns, which is the actual contract: same inputs → same directory, different inputs →
// different directory.

import { assert, assertEquals, assertNotEquals } from 'jsr:@std/assert@^1';
import { ensureDefaultConfig } from '../default_config.ts';

/**
 * A templates dir that cannot exist, so the bundled-only behavior is asserted without depending
 * on whether the machine running the tests happens to have `~/.config/devc/templates`.
 */
const NO_TEMPLATES = '/nonexistent/devc-templates';

/** The real bundled `default/` tree, the first half of every key. */
const DEFAULT_DIR = new URL('../default/', import.meta.url);

async function withTempDir(fn: (tmp: string) => Promise<void>) {
  const tmp = await Deno.makeTempDir({ prefix: 'devc-cache-test-' });
  try {
    await fn(await Deno.realPath(tmp));
  } finally {
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
  }
}

/** `default-<key>` — the last directory segment of a returned config path. */
function keyedDirName(configPath: string): string {
  const parts = configPath.split('/');
  return parts[parts.length - 2];
}

/** Names of everything directly under `dir`, sorted. */
async function entriesOf(dir: string): Promise<string[]> {
  const names: string[] = [];
  for await (const entry of Deno.readDir(dir)) names.push(entry.name);
  return names.sort();
}

Deno.test('ensureDefaultConfig returns a default-<key> path under the cache root', async () => {
  await withTempDir(async (tmp) => {
    const configPath = await ensureDefaultConfig(tmp, NO_TEMPLATES);

    assertEquals(configPath.startsWith(`${tmp}/default-`), true, configPath);
    assertEquals(configPath.endsWith('/devcontainer.json'), true, configPath);
    // 12 hex chars, per the plan's key definition.
    assert(
      /^default-[0-9a-f]{12}$/.test(keyedDirName(configPath)),
      `not a keyed dir name: ${keyedDirName(configPath)}`,
    );
    // The whole tree, not just the config — this is what `devcontainer up` reads.
    assertEquals(
      await entriesOf(`${tmp}/${keyedDirName(configPath)}`),
      [
        'Dockerfile',
        'devcontainer.json',
        'initialize-command.sh',
      ],
    );
  });
});

Deno.test('ensureDefaultConfig: identical inputs give the identical path', async () => {
  await withTempDir(async (a) => {
    await withTempDir(async (b) => {
      // Two *different* cache roots, so this compares the key itself and not merely "the same
      // directory was already there".
      assertEquals(
        keyedDirName(await ensureDefaultConfig(a, NO_TEMPLATES)),
        keyedDirName(await ensureDefaultConfig(b, NO_TEMPLATES)),
      );
    });
  });
});

Deno.test('ensureDefaultConfig: a second call writes nothing and returns the same path', async () => {
  await withTempDir(async (tmp) => {
    const first = await ensureDefaultConfig(tmp, NO_TEMPLATES);

    // Overwrite the materialized config with a marker and take its mtime. A hit must leave both
    // alone; a marker survives regardless of filesystem timestamp granularity, which mtime alone
    // would be at the mercy of.
    await Deno.writeTextFile(first, 'MARKER');
    const before = (await Deno.stat(first)).mtime;

    const second = await ensureDefaultConfig(tmp, NO_TEMPLATES);

    assertEquals(second, first);
    assertEquals(await Deno.readTextFile(first), 'MARKER');
    assertEquals((await Deno.stat(first)).mtime?.getTime(), before?.getTime());
    // And no staging directory was even created.
    assertEquals(
      (await entriesOf(tmp)).filter((n) => n.startsWith('.tmp-')),
      [],
    );
  });
});

Deno.test('ensureDefaultConfig: a changed template file changes the key', async () => {
  await withTempDir(async (tmp) => {
    const templates = `${tmp}/templates`;
    await Deno.mkdir(templates, { recursive: true });
    await Deno.writeTextFile(`${templates}/Dockerfile`, 'FROM one\n');
    const one = await ensureDefaultConfig(tmp, templates);

    await Deno.writeTextFile(`${templates}/Dockerfile`, 'FROM two\n');
    const two = await ensureDefaultConfig(tmp, templates);

    // Without the templates tree in the key this would silently return `one` — the one way the
    // whole design gets got wrong, since a hit writes nothing and the edit would appear to do
    // nothing.
    assertNotEquals(keyedDirName(one), keyedDirName(two));
    assertEquals(
      await Deno.readTextFile(`${tmp}/${keyedDirName(two)}/Dockerfile`),
      'FROM two\n',
    );
  });
});

Deno.test('ensureDefaultConfig: adding a template file changes the key', async () => {
  await withTempDir(async (tmp) => {
    const templates = `${tmp}/templates`;
    await Deno.mkdir(templates, { recursive: true });
    const before = await ensureDefaultConfig(tmp, templates);

    await Deno.writeTextFile(`${templates}/Dockerfile`, 'FROM added\n');
    const after = await ensureDefaultConfig(tmp, templates);

    assertNotEquals(keyedDirName(before), keyedDirName(after));
  });
});

Deno.test('ensureDefaultConfig: an absent templates dir keys the same as an empty one', async () => {
  await withTempDir(async (tmp) => {
    const empty = `${tmp}/empty-templates`;
    await Deno.mkdir(empty, { recursive: true });
    // "A missing directory contributes nothing" — so it must hash identically to one that is
    // present but has nothing in it.
    assertEquals(
      keyedDirName(await ensureDefaultConfig(tmp, NO_TEMPLATES)),
      keyedDirName(await ensureDefaultConfig(tmp, empty)),
    );
  });
});

Deno.test('ensureDefaultConfig: a changed bundled file changes the key', async () => {
  // The bundled tree is the first half of the key and cannot be swapped out by a parameter, so
  // this temporarily adds a file to the real `default/` tree and removes it again. Deno runs test
  // files (and the tests within one) sequentially, so nothing else is reading the tree meanwhile.
  const scratch = new URL('./devc-key-probe.txt', DEFAULT_DIR);
  await withTempDir(async (tmp) => {
    const before = await ensureDefaultConfig(tmp, NO_TEMPLATES);
    try {
      await Deno.writeTextFile(scratch, 'probe\n');
      const after = await ensureDefaultConfig(tmp, NO_TEMPLATES);
      assertNotEquals(keyedDirName(before), keyedDirName(after));
      // A different bundled tree — a different `devc` version, in practice — gets its own
      // directory rather than rewriting the other version's.
      assertEquals(
        await Deno.readTextFile(`${tmp}/${keyedDirName(before)}/Dockerfile`),
        await Deno.readTextFile(`${tmp}/${keyedDirName(after)}/Dockerfile`),
      );
    } finally {
      await Deno.remove(scratch).catch(() => {});
    }
    // Restored, so the key is back where it started.
    assertEquals(
      keyedDirName(await ensureDefaultConfig(tmp, NO_TEMPLATES)),
      keyedDirName(before),
    );
  });
});

Deno.test('the key does not depend on filesystem enumeration order', async () => {
  await withTempDir(async (tmp) => {
    const forward = `${tmp}/forward`;
    const reverse = `${tmp}/reverse`;
    // Same set of template files, created in opposite orders. On ext4 `readdir` returns entries
    // roughly in creation order, so these two directories enumerate differently; the sorted walk
    // is what makes them hash the same.
    const names = ['a.txt', 'b.txt', 'c.txt', 'nested/d.txt', 'nested/e.txt'];
    for (
      const [dir, order] of [[forward, names], [
        reverse,
        [...names].reverse(),
      ]] as const
    ) {
      for (const name of order) {
        const path = `${dir}/${name}`;
        await Deno.mkdir(path.slice(0, path.lastIndexOf('/')), {
          recursive: true,
        });
        await Deno.writeTextFile(path, `content of ${name}\n`);
      }
    }

    assertEquals(
      keyedDirName(await ensureDefaultConfig(tmp, forward)),
      keyedDirName(await ensureDefaultConfig(tmp, reverse)),
    );
  });
});

Deno.test('ensureDefaultConfig rewrites initializeCommand to the final directory, never the staging one', async () => {
  // The trap in the whole design: the tree is materialized under `.tmp-<pid>-<rand>/` and renamed
  // into place, but the `initializeCommand` path baked into the config is *absolute*. Without
  // `finalDir` threaded through, it would name a staging directory that no longer exists.
  await withTempDir(async (tmp) => {
    const configPath = await ensureDefaultConfig(tmp, NO_TEMPLATES);
    const text = await Deno.readTextFile(configPath);

    const dir = keyedDirName(configPath);
    assert(
      text.includes(`${tmp}/${dir}/initialize-command.sh`),
      `initializeCommand does not name the final dir:\n${text}`,
    );
    assert(
      !text.includes('.tmp-'),
      `staging path leaked into the config:\n${text}`,
    );

    // And the script the baked path names is actually there.
    await Deno.stat(`${tmp}/${dir}/initialize-command.sh`);
  });
});

Deno.test('ensureDefaultConfig discards its staging dir rather than overwriting a populated target', async () => {
  await withTempDir(async (tmp) => {
    // Learn the key first, then pre-populate that exact directory with something that is *not* a
    // materialized tree — which is what losing the `rename` race looks like from in here.
    const probe = `${tmp}/probe`;
    const dir = keyedDirName(await ensureDefaultConfig(probe, NO_TEMPLATES));

    await Deno.mkdir(`${tmp}/${dir}`, { recursive: true });
    await Deno.writeTextFile(`${tmp}/${dir}/winner.txt`, 'the other process');

    const configPath = await ensureDefaultConfig(tmp, NO_TEMPLATES);

    assertEquals(configPath, `${tmp}/${dir}/devcontainer.json`);
    // The winner's tree is untouched...
    assertEquals(
      await Deno.readTextFile(`${tmp}/${dir}/winner.txt`),
      'the other process',
    );
    // ...and the staging copy is gone rather than left behind as garbage.
    assertEquals(
      (await entriesOf(tmp)).filter((n) => n.startsWith('.tmp-')),
      [],
    );
  });
});

Deno.test('ensureDefaultConfig: a fully materialized target is a hit, and nothing is staged', async () => {
  await withTempDir(async (tmp) => {
    const first = await ensureDefaultConfig(tmp, NO_TEMPLATES);
    await Deno.writeTextFile(`${first}.sentinel`, 'untouched');

    await ensureDefaultConfig(tmp, NO_TEMPLATES);

    assertEquals(await Deno.readTextFile(`${first}.sentinel`), 'untouched');
    assertEquals(
      (await entriesOf(tmp)).filter((n) => n.startsWith('.tmp-')),
      [],
    );
  });
});

Deno.test('concurrent ensureDefaultConfig calls agree on one complete directory', async () => {
  await withTempDir(async (tmp) => {
    // Eight starters against one empty cache root: exactly the shape a long-running consumer
    // plus an installed CLI produce, and the case the unconditional `rm -rf` could not survive.
    const paths = await Promise.all(
      Array.from({ length: 8 }, () => ensureDefaultConfig(tmp, NO_TEMPLATES)),
    );

    assertEquals(new Set(paths).size, 1, `diverged: ${JSON.stringify(paths)}`);

    const dir = keyedDirName(paths[0]);
    // Exactly one keyed directory, and no staging leftovers from the seven that lost.
    assertEquals(await entriesOf(tmp), [dir]);
    // The tree is complete — a reader that arrived mid-race would have seen either nothing or
    // all of this, never a half-copy.
    assertEquals(
      await entriesOf(`${tmp}/${dir}`),
      [
        'Dockerfile',
        'devcontainer.json',
        'initialize-command.sh',
      ],
    );
    assert(
      (await Deno.readTextFile(paths[0])).includes(
        `${tmp}/${dir}/initialize-command.sh`,
      ),
    );
  });
});
