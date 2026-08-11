import { assertEquals, assertRejects } from 'jsr:@std/assert@^1';
import { fromFileUrl } from 'jsr:@std/path@^1';
import {
  ensureClaudeSeedDir,
  findOwnDevcontainerConfig,
  installBundledAssets,
  loadResolvedRemoteEnv,
  materializeDefaultConfig,
  substituteVars,
} from '../default_config.ts';

async function mkdir(path: string) {
  await Deno.mkdir(path, { recursive: true });
}

/** Drop `//`-to-end-of-line comment lines so a JSONC config parses as JSON. */
function stripLineComments(text: string): string {
  return text.split('\n').filter((line) => !/^\s*\/\//.test(line)).join('\n');
}

async function withTempDir(fn: (tmp: string) => Promise<void>) {
  const tmp = await Deno.makeTempDir();
  try {
    await fn(tmp);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
}

/**
 * A templates dir that cannot exist, so the bundled-only behavior is asserted without depending
 * on whether the machine running the tests happens to have `~/.config/devc/templates`.
 */
const NO_TEMPLATES = '/nonexistent/devc-templates';

Deno.test('findOwnDevcontainerConfig is null for a plain directory', async () => {
  await withTempDir(async (tmp) => {
    assertEquals(await findOwnDevcontainerConfig(tmp), null);
  });
});

Deno.test('findOwnDevcontainerConfig returns the .devcontainer/devcontainer.json path', async () => {
  await withTempDir(async (tmp) => {
    await mkdir(`${tmp}/.devcontainer`);
    await Deno.writeTextFile(`${tmp}/.devcontainer/devcontainer.json`, '{}');
    assertEquals(
      await findOwnDevcontainerConfig(tmp),
      `${tmp}/.devcontainer/devcontainer.json`,
    );
  });
});

Deno.test('findOwnDevcontainerConfig returns the .devcontainer.json path', async () => {
  await withTempDir(async (tmp) => {
    await Deno.writeTextFile(`${tmp}/.devcontainer.json`, '{}');
    assertEquals(
      await findOwnDevcontainerConfig(tmp),
      `${tmp}/.devcontainer.json`,
    );
  });
});

Deno.test('findOwnDevcontainerConfig prefers .devcontainer/devcontainer.json over .devcontainer.json', async () => {
  await withTempDir(async (tmp) => {
    await mkdir(`${tmp}/.devcontainer`);
    await Deno.writeTextFile(`${tmp}/.devcontainer/devcontainer.json`, '{}');
    await Deno.writeTextFile(`${tmp}/.devcontainer.json`, '{}');
    assertEquals(
      await findOwnDevcontainerConfig(tmp),
      `${tmp}/.devcontainer/devcontainer.json`,
    );
  });
});

Deno.test('substituteVars resolves ${containerWorkspaceFolder}', () => {
  assertEquals(
    substituteVars('${containerWorkspaceFolder}/sub', '/workspaces/x'),
    '/workspaces/x/sub',
  );
});

Deno.test('substituteVars resolves ${localEnv:HOME}', () => {
  const home = Deno.env.get('HOME') ?? Deno.env.get('USERPROFILE') ?? '.';
  assertEquals(
    substituteVars('${localEnv:HOME}/foo', '/workspaces/x'),
    `${home}/foo`,
  );
});

Deno.test('substituteVars resolves an arbitrary ${localEnv:VAR}', () => {
  const prev = Deno.env.get('SOME_VAR');
  Deno.env.set('SOME_VAR', '/custom/path');
  Deno.env.delete('UNSET_VAR');
  try {
    assertEquals(
      substituteVars('${localEnv:SOME_VAR}/foo', '/workspaces/x'),
      '/custom/path/foo',
    );
    assertEquals(
      substituteVars('${localEnv:UNSET_VAR}/foo', '/workspaces/x'),
      '/foo',
    );
  } finally {
    if (prev === undefined) Deno.env.delete('SOME_VAR');
    else Deno.env.set('SOME_VAR', prev);
  }
});

Deno.test('substituteVars resolves both variables in one value', () => {
  const home = Deno.env.get('HOME') ?? Deno.env.get('USERPROFILE') ?? '.';
  assertEquals(
    substituteVars(
      '${localEnv:HOME}/data:${containerWorkspaceFolder}/data',
      '/workspaces/x',
    ),
    `${home}/data:/workspaces/x/data`,
  );
});

Deno.test('loadResolvedRemoteEnv returns remoteEnv from config with ${containerWorkspaceFolder} resolved', async () => {
  await withTempDir(async (tmp) => {
    await Deno.writeTextFile(
      `${tmp}/devcontainer.json`,
      JSON.stringify({
        remoteEnv: {
          PROJECT_PATH: '${containerWorkspaceFolder}',
          TZ: 'America/Chicago',
        },
      }),
    );
    assertEquals(
      await loadResolvedRemoteEnv(
        `${tmp}/devcontainer.json`,
        '/workspaces/myproject',
      ),
      { PROJECT_PATH: '/workspaces/myproject', TZ: 'America/Chicago' },
    );
  });
});

Deno.test('loadResolvedRemoteEnv returns {} when config has no remoteEnv', async () => {
  await withTempDir(async (tmp) => {
    await Deno.writeTextFile(`${tmp}/devcontainer.json`, '{}');
    assertEquals(
      await loadResolvedRemoteEnv(
        `${tmp}/devcontainer.json`,
        '/workspaces/x',
      ),
      {},
    );
  });
});

Deno.test('loadResolvedRemoteEnv strips // line comments from config before parsing', async () => {
  await withTempDir(async (tmp) => {
    await Deno.writeTextFile(
      `${tmp}/devcontainer.json`,
      `{
  // a comment
  "remoteEnv": { "FOO": "bar" }
}`,
    );
    assertEquals(
      await loadResolvedRemoteEnv(
        `${tmp}/devcontainer.json`,
        '/workspaces/x',
      ),
      { FOO: 'bar' },
    );
  });
});

// A project's own devcontainer.json is hand-written, so the reader has to survive real JSONC
// (not just whole-line `//`) and has to fail soft: losing env vars beats breaking `devc exec`.
Deno.test('loadResolvedRemoteEnv parses trailing commas, block comments, and end-of-line comments', async () => {
  await withTempDir(async (tmp) => {
    await Deno.writeTextFile(
      `${tmp}/devcontainer.json`,
      `{
  /* block
     comment */
  "remoteEnv": {
    "FOO": "bar", // trailing note after a value
    "BAZ": "qux",
  },
}`,
    );
    assertEquals(
      await loadResolvedRemoteEnv(`${tmp}/devcontainer.json`, '/workspaces/x'),
      { FOO: 'bar', BAZ: 'qux' },
    );
  });
});

Deno.test('loadResolvedRemoteEnv returns {} for an unparseable config instead of throwing', async () => {
  await withTempDir(async (tmp) => {
    await Deno.writeTextFile(`${tmp}/devcontainer.json`, '{ not json at all');
    assertEquals(
      await loadResolvedRemoteEnv(`${tmp}/devcontainer.json`, '/workspaces/x'),
      {},
    );
  });
});

Deno.test('loadResolvedRemoteEnv returns {} for a missing config instead of throwing', async () => {
  await withTempDir(async (tmp) => {
    assertEquals(
      await loadResolvedRemoteEnv(`${tmp}/nope.json`, '/workspaces/x'),
      {},
    );
  });
});

Deno.test('loadResolvedRemoteEnv skips non-string remoteEnv values', async () => {
  await withTempDir(async (tmp) => {
    await Deno.writeTextFile(
      `${tmp}/devcontainer.json`,
      JSON.stringify({ remoteEnv: { OK: 'yes', N: 1, B: true, O: {} } }),
    );
    assertEquals(
      await loadResolvedRemoteEnv(`${tmp}/devcontainer.json`, '/workspaces/x'),
      { OK: 'yes' },
    );
  });
});

Deno.test('loadResolvedRemoteEnv resolves ${localWorkspaceFolder} and its basename when given the local folder', async () => {
  await withTempDir(async (tmp) => {
    await Deno.writeTextFile(
      `${tmp}/devcontainer.json`,
      JSON.stringify({
        remoteEnv: {
          LOCAL: '${localWorkspaceFolder}',
          BASE: '${localWorkspaceFolderBasename}',
        },
      }),
    );
    assertEquals(
      await loadResolvedRemoteEnv(
        `${tmp}/devcontainer.json`,
        '/workspaces/myproject',
        '/home/me/src/myproject',
      ),
      { LOCAL: '/home/me/src/myproject', BASE: 'myproject' },
    );
  });
});

// `${localWorkspaceFolder}` is a prefix of `${localWorkspaceFolderBasename}`, so substituting
// in the wrong order yields `/home/me/src/myprojectBasename}`.
Deno.test('substituteVars substitutes the basename token before the folder token', () => {
  assertEquals(
    substituteVars(
      '${localWorkspaceFolderBasename}:${localWorkspaceFolder}',
      '/workspaces/x',
      '/home/me/src/myproject',
    ),
    'myproject:/home/me/src/myproject',
  );
});

Deno.test('substituteVars leaves local-folder tokens alone when no local folder is given', () => {
  assertEquals(
    substituteVars('${localWorkspaceFolder}/x', '/workspaces/x'),
    '${localWorkspaceFolder}/x',
  );
});

Deno.test('materializeDefaultConfig copies the embedded tree flat to cacheDir and returns the config path', async () => {
  await withTempDir(async (cacheDir) => {
    const path = await materializeDefaultConfig(cacheDir, NO_TEMPLATES);
    // Flat layout: zero-config uses no project `.devcontainer/`, so the cache holds the
    // config, Dockerfile, the two lifecycle entry scripts, and `scripts/` directly.
    assertEquals(path, `${cacheDir}/devcontainer.json`);

    for (
      const file of [
        'devcontainer.json',
        'Dockerfile',
        'post-create.sh',
        'initialize-command.sh',
        'scripts/agents-setup.sh',
        'scripts/node-setup.sh',
        'scripts/git-setup.sh',
        'scripts/project-hook.sh',
        'scripts/bashrc-additions.sh',
      ]
    ) {
      assertEquals((await Deno.stat(`${cacheDir}/${file}`)).isFile, true);
    }
  });
});

Deno.test('materialized (zero-config) devcontainer.json has no Feature and a top-level postCreateCommand', async () => {
  await withTempDir(async (cacheDir) => {
    await materializeDefaultConfig(cacheDir, NO_TEMPLATES);

    // The cache copy is verbatim JSONC — strip line comments before parsing.
    const dc = JSON.parse(
      stripLineComments(
        await Deno.readTextFile(`${cacheDir}/devcontainer.json`),
      ),
    );
    // No local Feature reference (the baseline is delivered another way)...
    assertEquals(Object.hasOwn(dc.features, './features/devc'), false);
    // ...ghcr features kept...
    assertEquals(
      Object.hasOwn(dc.features, 'ghcr.io/devcontainers/features/node:1'),
      true,
    );
    // ...and the baseline runtime runs via a top-level postCreateCommand, rewritten from the
    // in-project workspace path to the image-baked path (the cache dir is not mounted in).
    assertEquals(
      dc.postCreateCommand,
      'bash "/usr/local/share/devc/post-create.sh"',
    );
  });
});

Deno.test('canonical default devcontainer.json has no Feature and a project-relative postCreateCommand', async () => {
  // The embedded source is what `devc config` writes into a project: it references the copies
  // in the project's own .devcontainer/, so edits apply on recreate. (The zero-config cache
  // rewrites this to the baked path — see the materialize test above.)
  const text = await Deno.readTextFile(
    new URL('../default/devcontainer.json', import.meta.url),
  );
  const dc = JSON.parse(stripLineComments(text));
  assertEquals(Object.hasOwn(dc.features, './features/devc'), false);
  assertEquals(
    dc.postCreateCommand,
    'bash "${containerWorkspaceFolder}/.devcontainer/post-create.sh"',
  );
});

Deno.test('canonical default devcontainer.json gets the bridge from the Feature, not its own mounts', async () => {
  // The bridge's container half is a published Feature (features/devc-bridge/), so any
  // project — devc or not — opts in with one line. devc consumes the same Feature rather
  // than carrying its own copy of the mounts: two mechanisms would collide, since Docker
  // fails a create with `Duplicate mount point` when the same target is mounted twice.
  const text = await Deno.readTextFile(
    new URL('../default/devcontainer.json', import.meta.url),
  );
  const dc = JSON.parse(stripLineComments(text));

  const feature = Object.keys(dc.features).find((id) =>
    id.startsWith('ghcr.io/bmingles/devc-tools/devc-bridge:')
  );
  assertEquals(typeof feature, 'string', 'no devc-bridge Feature reference');

  // ...and no leftover bridge mount of devc's own, at any target.
  const mounts: string[] = dc.mounts;
  assertEquals(
    mounts.filter((m) => m.includes('/.config/devc-bridge/')),
    [],
    'bridge mounts must come from the Feature only',
  );
});

Deno.test('the devc-bridge Feature declares both bridge mounts as readonly strings', async () => {
  // Guards the one thing this whole arrangement rests on, in the file devc now delegates
  // to. A Feature mount written as a *string* is passed through to Docker verbatim, so
  // `readonly` survives; the object form the published Feature schema documents is
  // re-serialized through the CLI's `Mount` interface, which has no `readonly` field, and
  // silently makes both mounts writable. A writable client/ lets one container rewrite a
  // binary the others execute; a writable run/ lets a container pin the host's shared
  // secret, since the host adopts an existing token rather than regenerating it.
  const meta = JSON.parse(
    await Deno.readTextFile(
      new URL(
        '../../features/devc-bridge/devcontainer-feature.json',
        import.meta.url,
      ),
    ),
  );

  for (
    const [source, target] of [
      ['${localEnv:HOME}/.config/devc-bridge/run', '/run/devc-bridge'],
      [
        '${localEnv:HOME}/.config/devc-bridge/client',
        '/usr/local/share/devc-bridge/client',
      ],
    ]
  ) {
    const mount = (meta.mounts as unknown[]).find((m) =>
      typeof m === 'string' && m.includes(`source=${source},`) &&
      m.includes(`target=${target},`)
    ) as string | undefined;
    assertEquals(typeof mount, 'string', `no string bind mount for ${target}`);
    assertEquals(mount!.startsWith('type=bind,'), true);
    assertEquals(
      mount!.split(',').includes('readonly'),
      true,
      `${target} must be mounted readonly`,
    );
  }
});

Deno.test('materializeDefaultConfig overwrites an existing copy without erroring', async () => {
  await withTempDir(async (cacheDir) => {
    await Deno.mkdir(cacheDir, { recursive: true });
    await Deno.writeTextFile(
      `${cacheDir}/devcontainer.json`,
      '{"marker":"STALE"}',
    );
    const first = await materializeDefaultConfig(cacheDir, NO_TEMPLATES);
    const second = await materializeDefaultConfig(cacheDir, NO_TEMPLATES);
    assertEquals(first, second);
    const contents = await Deno.readTextFile(`${cacheDir}/devcontainer.json`);
    assertEquals(contents.includes('STALE'), false);
  });
});

Deno.test('materializeDefaultConfig writes the embedded tree to real disk (default cache dir)', async () => {
  const path = await materializeDefaultConfig();
  assertEquals(path.endsWith('/devcontainer.json'), true);

  const stat = await Deno.stat(path);
  assertEquals(stat.isFile, true);

  const dir = path.slice(0, -'/devcontainer.json'.length);
  for (
    const sibling of [
      'Dockerfile',
      'post-create.sh',
      'initialize-command.sh',
      'scripts/agents-setup.sh',
      'scripts/node-setup.sh',
      'scripts/git-setup.sh',
      'scripts/project-hook.sh',
      'scripts/bashrc-additions.sh',
    ]
  ) {
    const siblingStat = await Deno.stat(`${dir}/${sibling}`);
    assertEquals(siblingStat.isFile, true);
  }
});

Deno.test('materializeDefaultConfig rewrites the initializeCommand host path to the cache copy', async () => {
  await withTempDir(async (tmp) => {
    const cacheDir = `${tmp}/cache`;
    const configPath = await materializeDefaultConfig(cacheDir, NO_TEMPLATES);
    const config = JSON.parse(
      stripLineComments(await Deno.readTextFile(configPath)),
    );
    // initializeCommand runs on the host before create; in zero-config the workspace is the
    // user's project (no `.devcontainer/`), so the `${localWorkspaceFolder}` reference is
    // resolved to this cache dir where initialize-command.sh actually lives.
    assertEquals(
      config.initializeCommand,
      `bash "${cacheDir}/initialize-command.sh"`,
    );
    assertEquals(
      (await Deno.stat(`${cacheDir}/initialize-command.sh`)).isFile,
      true,
    );
  });
});

// ── user template layer ─────────────────────────────────────────────────────────────────────

/** Sorted relative paths of every file under `dir`. */
async function fileTree(dir: string, prefix = ''): Promise<string[]> {
  const out: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    const rel = `${prefix}${entry.name}`;
    if (entry.isDirectory) {
      out.push(...await fileTree(`${dir}/${entry.name}`, `${rel}/`));
    } else out.push(rel);
  }
  return out.sort();
}

/** The embedded `default/` tree as a real path, for byte-comparison against a cache dir. */
const BUNDLED_DIR = fromFileUrl(new URL('../default', import.meta.url));

/** The two path rewrites `materializeDefaultConfig` applies, for a given cache dir. */
function withRewrites(configText: string, cacheDir: string): string {
  return configText
    .replaceAll(
      '${localWorkspaceFolder}/.devcontainer/initialize-command.sh',
      `${cacheDir}/initialize-command.sh`,
    )
    .replaceAll(
      '${containerWorkspaceFolder}/.devcontainer/post-create.sh',
      '/usr/local/share/devc/post-create.sh',
    );
}

/**
 * Assert `cacheDir` is the bundled tree with the two rewrites applied, except for the relative
 * paths in `overridden`, whose expected contents are given explicitly.
 */
async function assertBundledExcept(
  cacheDir: string,
  overridden: Record<string, string> = {},
): Promise<void> {
  assertEquals(await fileTree(cacheDir), await fileTree(BUNDLED_DIR));
  for (const rel of await fileTree(BUNDLED_DIR)) {
    const actual = await Deno.readTextFile(`${cacheDir}/${rel}`);
    if (rel in overridden) {
      assertEquals(actual, overridden[rel], rel);
      continue;
    }
    const bundled = await Deno.readTextFile(`${BUNDLED_DIR}/${rel}`);
    assertEquals(
      actual,
      rel === 'devcontainer.json' ? withRewrites(bundled, cacheDir) : bundled,
      rel,
    );
  }
}

Deno.test('materializeDefaultConfig with no templates dir yields the bundled tree plus the two rewrites', async () => {
  await withTempDir(async (tmp) => {
    // An absent templates dir is a silent no-op, not an error — whether its parent exists or not.
    await materializeDefaultConfig(`${tmp}/a`, NO_TEMPLATES);
    await assertBundledExcept(`${tmp}/a`);
    await materializeDefaultConfig(`${tmp}/b`, `${tmp}/never-created`);
    await assertBundledExcept(`${tmp}/b`);
  });
});

Deno.test('a templates dir holding only a Dockerfile overrides that file and nothing else', async () => {
  await withTempDir(async (tmp) => {
    const templates = `${tmp}/templates`;
    await mkdir(templates);
    await Deno.writeTextFile(`${templates}/Dockerfile`, 'FROM scratch\n');

    const cacheDir = `${tmp}/cache`;
    await materializeDefaultConfig(cacheDir, templates);

    // Sparse overlay: the file list is identical, only the one file's contents changed.
    await assertBundledExcept(cacheDir, { Dockerfile: 'FROM scratch\n' });
  });
});

Deno.test('a templates subdirectory file overrides the bundled one in place', async () => {
  await withTempDir(async (tmp) => {
    const templates = `${tmp}/templates`;
    await mkdir(`${templates}/scripts`);
    await Deno.writeTextFile(`${templates}/scripts/node-setup.sh`, '# mine\n');

    const cacheDir = `${tmp}/cache`;
    await materializeDefaultConfig(cacheDir, templates);

    assertEquals(
      await Deno.readTextFile(`${cacheDir}/scripts/node-setup.sh`),
      '# mine\n',
    );
    // Its siblings in the same subdirectory came from the bundle.
    assertEquals(
      (await Deno.stat(`${cacheDir}/scripts/agents-setup.sh`)).isFile,
      true,
    );
  });
});

// The two path rewrites have to run *after* the overlay, or a user template that keeps the
// standard in-project references would resolve to a `.devcontainer/` that does not exist in the
// zero-config path.
Deno.test('a templates devcontainer.json still receives the initializeCommand/postCreateCommand rewrites', async () => {
  await withTempDir(async (tmp) => {
    const templates = `${tmp}/templates`;
    await mkdir(templates);
    await Deno.writeTextFile(
      `${templates}/devcontainer.json`,
      JSON.stringify({
        name: 'mine',
        initializeCommand:
          'bash "${localWorkspaceFolder}/.devcontainer/initialize-command.sh"',
        postCreateCommand:
          'bash "${containerWorkspaceFolder}/.devcontainer/post-create.sh"',
      }),
    );

    const cacheDir = `${tmp}/cache`;
    const configPath = await materializeDefaultConfig(cacheDir, templates);
    const config = JSON.parse(await Deno.readTextFile(configPath));

    assertEquals(config.name, 'mine');
    assertEquals(
      config.initializeCommand,
      `bash "${cacheDir}/initialize-command.sh"`,
    );
    assertEquals(
      config.postCreateCommand,
      'bash "/usr/local/share/devc/post-create.sh"',
    );
  });
});

Deno.test('removing a file from the templates dir restores the bundled version', async () => {
  await withTempDir(async (tmp) => {
    const bundledDockerfile = await Deno.readTextFile(
      new URL('../default/Dockerfile', import.meta.url),
    );
    const templates = `${tmp}/templates`;
    await mkdir(templates);
    await Deno.writeTextFile(`${templates}/Dockerfile`, 'FROM scratch\n');

    const cacheDir = `${tmp}/cache`;
    await materializeDefaultConfig(cacheDir, templates);
    assertEquals(
      await Deno.readTextFile(`${cacheDir}/Dockerfile`),
      'FROM scratch\n',
    );

    // The overlay is re-applied every run, so a deletion takes effect on the next call.
    await Deno.remove(`${templates}/Dockerfile`);
    await materializeDefaultConfig(cacheDir, templates);
    assertEquals(
      await Deno.readTextFile(`${cacheDir}/Dockerfile`),
      bundledDockerfile,
    );
  });
});

Deno.test('a file in a previous cache but in neither bundled nor templates is pruned', async () => {
  await withTempDir(async (tmp) => {
    const cacheDir = `${tmp}/cache`;
    await materializeDefaultConfig(cacheDir, NO_TEMPLATES);
    await Deno.writeTextFile(
      `${cacheDir}/leftover.sh`,
      '# from an older devc\n',
    );
    await mkdir(`${cacheDir}/stale`);
    await Deno.writeTextFile(`${cacheDir}/stale/x.sh`, '# also stale\n');

    await materializeDefaultConfig(cacheDir, NO_TEMPLATES);

    const tree = await fileTree(cacheDir);
    assertEquals(tree.includes('leftover.sh'), false);
    assertEquals(tree.includes('stale/x.sh'), false);
    assertEquals(tree.includes('devcontainer.json'), true);
  });
});

// `devcontainer.json` rides the same per-file overlay as everything else, and is reported first
// in the written list. No special case: the exception that used to exist here was for the
// wizard's mount fences, which now live in the `devc.json` overlay instead.
Deno.test('installBundledAssets overlays templates, devcontainer.json included', async () => {
  await withTempDir(async (tmp) => {
    const templates = `${tmp}/templates`;
    await mkdir(templates);
    await Deno.writeTextFile(`${templates}/Dockerfile`, 'FROM scratch\n');
    await Deno.writeTextFile(
      `${templates}/devcontainer.json`,
      '{"name":"mine"}',
    );
    await Deno.writeTextFile(`${templates}/extra.txt`, 'brought along\n');

    const dest = `${tmp}/.devcontainer`;
    const written = await installBundledAssets(dest, templates);

    assertEquals(written[0], `${dest}/devcontainer.json`);
    assertEquals(
      await Deno.readTextFile(`${dest}/Dockerfile`),
      'FROM scratch\n',
    );
    assertEquals(
      await Deno.readTextFile(`${dest}/extra.txt`),
      'brought along\n',
    );
    assertEquals(
      await Deno.readTextFile(`${dest}/devcontainer.json`),
      '{"name":"mine"}',
    );
    // The two lifecycle entry scripts still get the exec bit.
    assertEquals(
      (await Deno.stat(`${dest}/post-create.sh`)).mode! & 0o111,
      0o111,
    );
  });
});

Deno.test('installBundledAssets writes the bundled devcontainer.json when no template overrides it', async () => {
  await withTempDir(async (tmp) => {
    const dest = `${tmp}/.devcontainer`;
    await installBundledAssets(dest, NO_TEMPLATES);
    assertEquals(
      await Deno.readTextFile(`${dest}/devcontainer.json`),
      await Deno.readTextFile(
        new URL('../default/devcontainer.json', import.meta.url),
      ),
    );
  });
});

// The guard for the adjacent-paths mistake: `templates/devc.json` would otherwise be copied to
// `<project>/.devcontainer/devc.json` and read back as that project's own overlay — the
// highest-precedence slot — putting one machine's mounts into every scaffolded repo. It is
// skipped, loudly (the warning is what keeps this from reproducing "my overlay does nothing").
Deno.test('installBundledAssets never copies a devc.json overlay out of templates', async () => {
  await withTempDir(async (tmp) => {
    const templates = `${tmp}/templates`;
    await mkdir(templates);
    for (const name of ['devc.json', 'devc.jsonc']) {
      await Deno.writeTextFile(`${templates}/${name}`, '{"mounts":[]}');
    }

    const dest = `${tmp}/.devcontainer`;
    const warnings: string[] = [];
    const realError = console.error;
    console.error = (...args) => void warnings.push(args.join(' '));
    try {
      await installBundledAssets(dest, templates);
    } finally {
      console.error = realError;
    }

    for (const name of ['devc.json', 'devc.jsonc']) {
      assertEquals(
        await Deno.stat(`${dest}/${name}`).then(() => true).catch(() => false),
        false,
        `expected ${name} not to be copied`,
      );
      // Skipping silently would leave exactly the "my overlay does nothing" this guards against,
      // so the warning has to name the offending file and where the overlay really goes.
      const warning = warnings.find((w) => w.includes(`${templates}/${name}`));
      assertEquals(
        typeof warning,
        'string',
        `expected a warning naming ${name}`,
      );
      assertEquals(warning!.includes('devc.jsonc'), true);
    }
  });
});

// Top-level only: nested files by that name are ordinary data with no overlay meaning.
Deno.test('the templates overlay still copies a nested devc.json', async () => {
  await withTempDir(async (tmp) => {
    const templates = `${tmp}/templates`;
    await mkdir(`${templates}/scripts`);
    await Deno.writeTextFile(`${templates}/scripts/devc.json`, '{"a":1}');

    const dest = `${tmp}/.devcontainer`;
    await installBundledAssets(dest, templates);

    assertEquals(
      await Deno.readTextFile(`${dest}/scripts/devc.json`),
      '{"a":1}',
    );
  });
});

Deno.test('materializeDefaultConfig also refuses a templates devc.json', async () => {
  await withTempDir(async (tmp) => {
    const templates = `${tmp}/templates`;
    await mkdir(templates);
    await Deno.writeTextFile(`${templates}/devc.json`, '{"mounts":[]}');

    const cacheDir = `${tmp}/cache`;
    await materializeDefaultConfig(cacheDir, templates);

    assertEquals(
      await Deno.stat(`${cacheDir}/devc.json`).then(() => true).catch(() =>
        false
      ),
      false,
    );
  });
});

Deno.test('ensureClaudeSeedDir creates the directory and reports it', async () => {
  await withTempDir(async (tmp) => {
    const seed = `${tmp}/seed`;
    const result = await ensureClaudeSeedDir(seed);
    assertEquals(result.created, true);
    assertEquals((await Deno.stat(seed)).isDirectory, true);
  });
});

Deno.test('ensureClaudeSeedDir is idempotent on an existing directory', async () => {
  await withTempDir(async (tmp) => {
    const seed = `${tmp}/seed`;
    await ensureClaudeSeedDir(seed);
    assertEquals((await ensureClaudeSeedDir(seed)).created, false);
  });
});

// Pinned deliberately, and the inverse of what an earlier `devc` did: the seed directory is
// created *empty* and nothing is ever copied out of the host's real `~/.claude`. Publishing a
// machine's personal CLAUDE.md/settings into every container is the user's decision to make by
// putting the file here, so a regression that "helpfully" seeds it must fail.
Deno.test('ensureClaudeSeedDir creates an empty directory, copying nothing from ~/.claude', async () => {
  await withTempDir(async (tmp) => {
    const home = `${tmp}/home/.claude`;
    await mkdir(home);
    for (
      const name of [
        'CLAUDE.md',
        'settings.json',
        'settings.devc.json',
        'statusline.sh',
      ]
    ) {
      await Deno.writeTextFile(`${home}/${name}`, 'personal\n');
    }

    const seed = `${tmp}/seed`;
    assertEquals((await ensureClaudeSeedDir(seed)).created, true);
    assertEquals([...Deno.readDirSync(seed)], []);
  });
});

Deno.test('ensureClaudeSeedDir rejects a seed path that is not a directory', async () => {
  await withTempDir(async (tmp) => {
    const seed = `${tmp}/seed`;
    await Deno.writeTextFile(seed, 'oops\n');
    await assertRejects(
      () => ensureClaudeSeedDir(seed),
      Error,
      'is not a directory',
    );
  });
});

Deno.test('ensureClaudeSeedDir rejects a dangling symlink at the seed path', async () => {
  await withTempDir(async (tmp) => {
    const seed = `${tmp}/seed`;
    // Recursive mkdir reports AlreadyExists here rather than following through, so the
    // not-a-directory guard is what turns this into a readable error.
    await Deno.symlink(`${tmp}/nonexistent`, seed);
    await assertRejects(
      () => ensureClaudeSeedDir(seed),
      Error,
      'is not a directory',
    );
  });
});
