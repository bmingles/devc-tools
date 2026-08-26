import { assertEquals, assertRejects } from 'jsr:@std/assert@^1';
import { initProject } from '../init.ts';

/** The embedded baseline, read straight off disk — no template layer, no helper in between. */
const bundledDevcontainerJson = () =>
  Deno.readTextFile(new URL('../default/devcontainer.json', import.meta.url));

/**
 * A templates dir that cannot exist, so these assertions hold regardless of whether the machine
 * running the tests happens to have a `~/.config/devc/templates/devcontainer.json`.
 */
const NO_TEMPLATES = '/nonexistent/devc-templates';

async function withTempDir(fn: (tmp: string) => Promise<void>) {
  const tmp = await Deno.makeTempDir();
  try {
    await fn(tmp);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
}

const mode = async (path: string) => (await Deno.stat(path)).mode! & 0o777;

Deno.test('initProject writes the whole bundled .devcontainer/', async () => {
  await withTempDir(async (tmp) => {
    const { configPath, written } = await initProject(tmp);
    assertEquals(configPath, `${tmp}/.devcontainer/devcontainer.json`);
    assertEquals(written, [
      `${tmp}/.devcontainer/devcontainer.json`,
      `${tmp}/.devcontainer/Dockerfile`,
      `${tmp}/.devcontainer/initialize-command.sh`,
    ]);
    for (const path of written) await Deno.stat(path); // every reported path exists
  });
});

Deno.test('initProject writes devcontainer.json byte-identical to the bundled default', async () => {
  await withTempDir(async (tmp) => {
    const { configPath } = await initProject(tmp, NO_TEMPLATES);
    assertEquals(
      await Deno.readTextFile(configPath),
      await bundledDevcontainerJson(),
    );
  });
});

// `devc config` inserts the fences later (see the applyFences "config that lacks them" test), so
// init has no reason to write empty ones. Matching the real `// >>> devc:<id>` / `// <<< devc:<id>`
// markers rather than the bare id — the bundled config mentions `devc:skills` in prose.
Deno.test('initProject writes no mount fences', async () => {
  await withTempDir(async (tmp) => {
    const text = await Deno.readTextFile((await initProject(tmp)).configPath);
    for (const id of ['source', 'skills']) {
      assertEquals(
        new RegExp(`^[ \\t]*//[ \\t]*(>>>|<<<)[ \\t]*devc:${id}\\b`, 'm').test(
          text,
        ),
        false,
        `expected no devc:${id} fence marker`,
      );
    }
  });
});

Deno.test('initProject makes initialize-command.sh executable', async () => {
  await withTempDir(async (tmp) => {
    await initProject(tmp);
    const dir = `${tmp}/.devcontainer`;
    assertEquals(await mode(`${dir}/initialize-command.sh`), 0o755);
    // Not everything is chmodded — the Dockerfile is not a script.
    assertEquals(await mode(`${dir}/Dockerfile`), 0o644);
  });
});

Deno.test('initProject refuses when .devcontainer/devcontainer.json exists, leaving it untouched', async () => {
  await withTempDir(async (tmp) => {
    await Deno.mkdir(`${tmp}/.devcontainer`);
    const configPath = `${tmp}/.devcontainer/devcontainer.json`;
    await Deno.writeTextFile(configPath, '{ "name": "mine" }');
    // The remedy must name the folder contents: deleting only devcontainer.json would leave the
    // rest of the scaffold behind and hit the not-empty guard instead.
    await assertRejects(
      () => initProject(tmp),
      Error,
      'delete the .devcontainer/ folder contents and run `devc init` again.',
    );
    assertEquals(await Deno.readTextFile(configPath), '{ "name": "mine" }');
    // Nothing else was scaffolded alongside it.
    assertEquals(
      await Deno.stat(`${tmp}/.devcontainer/Dockerfile`).then(() => true).catch(
        () => false,
      ),
      false,
    );
  });
});

// The root form counts too: scaffolding the directory form next to it would leave two configs
// and make which one applies ambiguous.
Deno.test('initProject refuses when a root .devcontainer.json exists', async () => {
  await withTempDir(async (tmp) => {
    await Deno.writeTextFile(`${tmp}/.devcontainer.json`, '{}');
    // A lone file, so here "delete it" is the whole remedy — no folder contents to clear.
    await assertRejects(
      () => initProject(tmp),
      Error,
      'or delete it and run `devc init` again.',
    );
    assertEquals(
      await Deno.stat(`${tmp}/.devcontainer`).then(() => true).catch(() =>
        false
      ),
      false,
    );
  });
});

// Stricter than "no config yet": installBundledAssets overwrites exactly the bundle's own paths,
// so scaffolding into an occupied directory would silently replace a hand-written Dockerfile or
// scripts/*.sh and leave everything else behind as stale debris.
Deno.test('initProject refuses when .devcontainer/ holds unrelated files, writing nothing', async () => {
  await withTempDir(async (tmp) => {
    await Deno.mkdir(`${tmp}/.devcontainer`);
    await Deno.writeTextFile(`${tmp}/.devcontainer/Dockerfile`, 'FROM mine');
    await Deno.writeTextFile(`${tmp}/.devcontainer/README.md`, 'notes');
    await assertRejects(() => initProject(tmp), Error, 'is not empty');
    assertEquals(
      await Deno.readTextFile(`${tmp}/.devcontainer/Dockerfile`),
      'FROM mine',
    );
    assertEquals(
      await Deno.stat(`${tmp}/.devcontainer/devcontainer.json`).then(() => true)
        .catch(() => false),
      false,
    );
  });
});

Deno.test('initProject refuses when .devcontainer/ holds only a subdirectory', async () => {
  await withTempDir(async (tmp) => {
    await Deno.mkdir(`${tmp}/.devcontainer/shell`, { recursive: true });
    await Deno.writeTextFile(
      `${tmp}/.devcontainer/shell/10-mine.sh`,
      'alias m=1',
    );
    await assertRejects(() => initProject(tmp), Error, 'is not empty');
    assertEquals(
      await Deno.readTextFile(`${tmp}/.devcontainer/shell/10-mine.sh`),
      'alias m=1',
    );
  });
});

Deno.test('initProject refuses when .devcontainer/ holds only a dotfile', async () => {
  await withTempDir(async (tmp) => {
    await Deno.mkdir(`${tmp}/.devcontainer`);
    await Deno.writeTextFile(`${tmp}/.devcontainer/.gitkeep`, '');
    await assertRejects(() => initProject(tmp), Error, 'is not empty');
  });
});

Deno.test('initProject names the offending directory and its contents in the error', async () => {
  await withTempDir(async (tmp) => {
    await Deno.mkdir(`${tmp}/.devcontainer`);
    await Deno.writeTextFile(`${tmp}/.devcontainer/stray.txt`, '');
    const err = await assertRejects(() => initProject(tmp), Error);
    assertEquals(err.message.includes(`${tmp}/.devcontainer`), true);
    assertEquals(err.message.includes('stray.txt'), true);
  });
});

// An empty directory is fine — someone may have `mkdir`'d it, and there is nothing to clobber.
Deno.test('initProject succeeds into an existing but empty .devcontainer/', async () => {
  await withTempDir(async (tmp) => {
    await Deno.mkdir(`${tmp}/.devcontainer`);
    const { configPath } = await initProject(tmp, NO_TEMPLATES);
    assertEquals(
      await Deno.readTextFile(configPath),
      await bundledDevcontainerJson(),
    );
  });
});

Deno.test('initProject is a no-op on a second run (refuses rather than overwriting)', async () => {
  await withTempDir(async (tmp) => {
    const { configPath } = await initProject(tmp);
    await Deno.writeTextFile(configPath, '// hand-edited\n{}');
    await assertRejects(() => initProject(tmp), Error, 'already exists');
    assertEquals(await Deno.readTextFile(configPath), '// hand-edited\n{}');
  });
});

// ── user template layer ─────────────────────────────────────────────────────────────────────

Deno.test("initProject writes the template's Dockerfile instead of the bundled one", async () => {
  await withTempDir(async (tmp) => {
    const templates = `${tmp}/templates`;
    await Deno.mkdir(templates, { recursive: true });
    await Deno.writeTextFile(`${templates}/Dockerfile`, 'FROM scratch\n');

    const project = `${tmp}/project`;
    await Deno.mkdir(project);
    await initProject(project, templates);

    assertEquals(
      await Deno.readTextFile(`${project}/.devcontainer/Dockerfile`),
      'FROM scratch\n',
    );
    // Sparse overlay: everything else still came from the bundle.
    assertEquals(
      (await Deno.stat(`${project}/.devcontainer/initialize-command.sh`))
        .isFile,
      true,
    );
  });
});

Deno.test("initProject writes the template's devcontainer.json instead of the bundled one", async () => {
  await withTempDir(async (tmp) => {
    const templates = `${tmp}/templates`;
    await Deno.mkdir(templates, { recursive: true });
    await Deno.writeTextFile(
      `${templates}/devcontainer.json`,
      '{"name":"mine"}',
    );

    const project = `${tmp}/project`;
    await Deno.mkdir(project);
    const { configPath } = await initProject(project, templates);

    assertEquals(await Deno.readTextFile(configPath), '{"name":"mine"}');
  });
});

// Deliberate, and pinned so a later change does not "helpfully" exempt the overlay: `init` is a
// clean-slate operation, and requiring an empty directory is what guarantees its output is
// exactly the bundle with nothing carried over. A user with a local overlay moves it aside, runs
// `init`, and moves it back — which is what the error already advises.
Deno.test('initProject refuses a .devcontainer/ containing only devc.json, naming it', async () => {
  await withTempDir(async (tmp) => {
    await Deno.mkdir(`${tmp}/.devcontainer`);
    const overlay = `${tmp}/.devcontainer/devc.json`;
    await Deno.writeTextFile(overlay, '{"mounts":[]}');
    const err = await assertRejects(
      () => initProject(tmp),
      Error,
      'is not empty',
    );
    assertEquals(err.message.includes('devc.json'), true);
    assertEquals(
      err.message.includes('Move its contents aside and re-run'),
      true,
    );
    // The overlay is left exactly as it was, and nothing was scaffolded.
    assertEquals(await Deno.readTextFile(overlay), '{"mounts":[]}');
    assertEquals(
      await Deno.stat(`${tmp}/.devcontainer/devcontainer.json`).then(() => true)
        .catch(() => false),
      false,
    );
  });
});
