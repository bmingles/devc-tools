import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from 'jsr:@std/assert@^1';
import { fromFileUrl } from 'jsr:@std/path@^1';
import {
  declaresBridgeFeature,
  declaresFeatureNamed,
  ensureClaudeSeedDir,
  findOwnDevcontainerConfig,
  installBundledAssets,
  loadDeclaredFeatureIds,
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
        'scripts/bashrc-additions.sh',
      ]
    ) {
      assertEquals((await Deno.stat(`${cacheDir}/${file}`)).isFile, true);
    }
  });
});

Deno.test('materialized (zero-config) devcontainer.json has no local Feature, keeps the ghcr ones, and the baseline runs via a top-level onCreateCommand', async () => {
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
    // ...and the devc-config Feature is deliberately absent here too — devc contributes it
    // dynamically, via withBaselineFeatures/--additional-features, never by declaring it in the
    // bundled config itself. What this Feature does (running a devc-post-create.sh a project
    // committed for devc's own convention) is devc-specific, so unlike the other bundled
    // Features it is fine for a `devc init`-scaffolded project to lose it once `devc` itself is
    // uninstalled — see overlay.ts's DEVC_CONFIG_FEATURE doc comment.
    assertEquals(
      Object.hasOwn(
        dc.features,
        'ghcr.io/bmingles/devc-tools/devc-config:0.1.0',
      ),
      false,
    );
    // ...and the baseline runtime runs via a top-level **onCreateCommand** — not
    // postCreateCommand, so it still precedes a Feature-declared postCreateCommand (the
    // injected devc-config Feature's included) — rewritten from the in-project workspace path
    // to the image-baked path (the cache dir is not mounted in).
    assertEquals(dc.postCreateCommand, undefined);
    assertEquals(
      dc.onCreateCommand,
      'bash "/usr/local/share/devc/post-create.sh"',
    );
  });
});

Deno.test('canonical default devcontainer.json has no local Feature and a project-relative onCreateCommand', async () => {
  // The embedded source is what `devc config` writes into a project: it references the copies
  // in the project's own .devcontainer/, so edits apply on recreate. (The zero-config cache
  // rewrites this to the baked path — see the materialize test above.)
  const text = await Deno.readTextFile(
    new URL('../default/devcontainer.json', import.meta.url),
  );
  const dc = JSON.parse(stripLineComments(text));
  assertEquals(Object.hasOwn(dc.features, './features/devc'), false);
  // `postCreateCommand` was renamed to `onCreateCommand` (see the Ordering section of
  // .plans/archived/devc-inject-project-hook.md); the rewrite in materializeDefaultConfig matches on the
  // *value*, not the key, so it still finds and rewrites this regardless of the rename.
  assertEquals(dc.postCreateCommand, undefined);
  assertEquals(
    dc.onCreateCommand,
    'bash "${containerWorkspaceFolder}/.devcontainer/post-create.sh"',
  );
});

Deno.test('canonical default devcontainer.json does not install devc-bridge', async () => {
  // The bridge is an opt-in add-on, never part of devc's baseline — neither as a Feature
  // reference nor as mounts of devc's own. Two reasons, and the first is the load-bearing
  // one: a devc container must come up on a host that never installed the bridge, and a
  // Feature ref in the *bundled* default makes every create depend on that ref resolving,
  // so an unpublished (or renamed, or yanked) Feature breaks devc for everyone. Second,
  // carrying mounts here as well as in the Feature would collide for anyone who did opt
  // in — Docker fails a create with `Duplicate mount point` on the same target twice.
  // Opting in is `additionalFeatures` in a user- or project-level devc.json.
  const text = await Deno.readTextFile(
    new URL('../default/devcontainer.json', import.meta.url),
  );
  const dc = JSON.parse(stripLineComments(text));

  assertEquals(
    Object.keys(dc.features).filter((id) => id.includes('devc-bridge')),
    [],
    'devc-bridge must not be a baseline Feature — it is opt-in',
  );

  const mounts: string[] = dc.mounts;
  assertEquals(
    mounts.filter((m) => m.includes('/.config/devc-bridge/')),
    [],
    'devc must not carry bridge mounts of its own',
  );

  // Not even in a comment. This file is what `devc init` copies into a project, and an
  // insertion anchor (with the paragraph that has to explain it) would leave every scaffolded
  // repo carrying a marker for an add-on its author may never opt into. The mount is spliced
  // into the cache copy as the `devc:bridge-mount` fence, which needs nothing here — see
  // `injectBridgeMount`. Keep the bundled config silent about the bridge; devc/README.md is
  // where opting in is explained.
  assertEquals(
    text.includes('devc-bridge') || text.includes('bridge-mount'),
    false,
    'the bundled config must not mention devc-bridge at all, comments included',
  );
});

Deno.test('the devc-bridge Feature declares no mounts at all', async () => {
  // The inverse of what this test used to assert, and deliberately so.
  //
  // The Feature used to carry both bridge mounts as *strings*, because a string mount is
  // passed to Docker verbatim so `readonly` survives, while the object form the published
  // Feature schema allows is re-serialized as `type=,src=,dst=` and silently drops it. That
  // worked, but it put a security guarantee on undocumented CLI behavior: a future CLI that
  // normalized string mounts would quietly make them writable.
  //
  // So the Feature stopped needing mounts. The client is downloaded into an image layer at
  // build time (root-owned, and no shared host file for another container to reach), and the
  // token mount belongs to whoever consumes the Feature — in a `devcontainer.json` `mounts`
  // array, where the string form is in the published schema (`anyOf: [Mount, string]`) and is
  // specified to be Docker's own `--mount` syntax, so `readonly` is a promise rather than an
  // accident.
  //
  // Re-adding a `mounts` key here would reintroduce the off-schema dependency AND collide
  // with the consumer's own mount as Docker's `Duplicate mount point`. See
  // .plans/archived/devc-bridge-client-download.md.
  const meta = JSON.parse(
    await Deno.readTextFile(
      new URL(
        '../../features/devc-bridge/devcontainer-feature.json',
        import.meta.url,
      ),
    ),
  );

  assertEquals(
    Object.hasOwn(meta, 'mounts'),
    false,
    'the Feature must declare no mounts — the consumer owns the token mount',
  );
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

// --- the devc-bridge token mount ---------------------------------------------------------
//
// devc injects it into the config it *materializes*, and only when a devc.json opts into the
// Feature. Everything below defends one boundary or the other: the baseline must stay
// bridge-free (a devc container has to come up on a host that never installed the bridge —
// `0d46b51` removed the mkdir that used to paper over a missing mount source), and the mount
// must stay a *string* carrying `readonly`, which is the only reason it lives in a
// devcontainer.json at all rather than in the devc.json overlay.

Deno.test('declaresBridgeFeature matches the Feature by id, whatever the tag', async (t) => {
  const yes = [
    'ghcr.io/bmingles/devc-tools/devc-bridge',
    'ghcr.io/bmingles/devc-tools/devc-bridge:0',
    'ghcr.io/bmingles/devc-tools/devc-bridge:1',
    'ghcr.io/bmingles/devc-tools/devc-bridge:0.1.0',
    // A local path reference — how this repo consumes its own Feature in development.
    './features/devc-bridge',
    '../devc-tools/features/devc-bridge',
  ];
  const no = [
    'ghcr.io/devcontainers/features/node:1',
    'ghcr.io/bmingles/devc-tools/devc-bridge-client:0', // near-miss, different Feature
    './features/devc',
    '',
  ];

  for (const id of yes) {
    await t.step(`opts in: ${id || '(empty)'}`, () => {
      assertEquals(declaresBridgeFeature({ [id]: {} }), true);
    });
  }
  for (const id of no) {
    await t.step(`does not: ${id || '(empty)'}`, () => {
      assertEquals(declaresBridgeFeature({ [id]: {} }), false);
    });
  }

  assertEquals(declaresBridgeFeature({}), false);
  // Found among others, not only when it is the sole entry.
  assertEquals(
    declaresBridgeFeature({
      'ghcr.io/devcontainers/features/go:1': {},
      'ghcr.io/bmingles/devc-tools/devc-bridge:0': {},
    }),
    true,
  );
});

// declaresBridgeFeature is now a one-line wrapper over the general form; this asserts that
// wrapping held, not the matching logic itself (already covered above).
Deno.test('declaresBridgeFeature: an alias for declaresFeatureNamed(_, "devc-bridge")', () => {
  const features = { 'ghcr.io/bmingles/devc-tools/devc-bridge:0': {} };
  assertEquals(
    declaresBridgeFeature(features),
    declaresFeatureNamed(features, 'devc-bridge'),
  );
});

Deno.test('declaresFeatureNamed matches by name, whatever the tag or registry', async (t) => {
  const yes = [
    'ghcr.io/bmingles/devc-tools/devc-config',
    'ghcr.io/bmingles/devc-tools/devc-config:0',
    'ghcr.io/bmingles/devc-tools/devc-config:0.1.0',
    'ghcr.io/someone-else/devc-config:1',
    './features/devc-config',
  ];
  const no = [
    'ghcr.io/devcontainers/features/node:1',
    'ghcr.io/bmingles/devc-tools/devc-config-extra:0', // near-miss, different Feature
    './features/devc',
    '',
  ];

  for (const id of yes) {
    await t.step(`matches: ${id}`, () => {
      assertEquals(declaresFeatureNamed({ [id]: {} }, 'devc-config'), true);
    });
  }
  for (const id of no) {
    await t.step(`does not match: ${id || '(empty)'}`, () => {
      assertEquals(declaresFeatureNamed({ [id]: {} }, 'devc-config'), false);
    });
  }

  assertEquals(declaresFeatureNamed({}, 'devc-config'), false);
});

// --- loadDeclaredFeatureIds ------------------------------------------------------------------
//
// The baseline-injection half of the contract: withBaselineFeatures needs the raw ids the
// in-play config already declares, so it can skip injecting a Feature the config names itself.

Deno.test("loadDeclaredFeatureIds returns the config's raw feature ids", async () => {
  await withTempDir(async (dir) => {
    const path = `${dir}/devcontainer.json`;
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        features: {
          'ghcr.io/x/rust:1': { version: 'latest' },
          'ghcr.io/bmingles/devc-tools/devc-config:0.1.0': {},
        },
      }),
    );
    assertEquals(await loadDeclaredFeatureIds(path), [
      'ghcr.io/x/rust:1',
      'ghcr.io/bmingles/devc-tools/devc-config:0.1.0',
    ]);
  });
});

Deno.test('loadDeclaredFeatureIds returns [] when the config declares no features', async () => {
  await withTempDir(async (dir) => {
    const path = `${dir}/devcontainer.json`;
    await Deno.writeTextFile(path, JSON.stringify({ image: 'x' }));
    assertEquals(await loadDeclaredFeatureIds(path), []);
  });
});

Deno.test('loadDeclaredFeatureIds parses real JSONC: comments and trailing commas', async () => {
  await withTempDir(async (dir) => {
    const path = `${dir}/devcontainer.json`;
    await Deno.writeTextFile(
      path,
      `{
  // a hand-written config
  "features": {
    "ghcr.io/x/rust:1": {}, // trailing comma below
  },
}`,
    );
    assertEquals(await loadDeclaredFeatureIds(path), ['ghcr.io/x/rust:1']);
  });
});

// Degrades to [] ("nothing declared") rather than throwing — deliberately, so devc still
// injects the baseline rather than silently withholding it from a config it cannot parse. See
// loadDeclaredFeatureIds's own doc comment for why this is the safer default than the reverse.
Deno.test('loadDeclaredFeatureIds degrades to [] with a warning when the config cannot be read', async () => {
  await withTempDir(async (dir) => {
    const path = `${dir}/devcontainer.json`;
    await Deno.writeTextFile(path, '{ not json');
    const warnings: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => warnings.push(args.join(' '));
    try {
      assertEquals(await loadDeclaredFeatureIds(path), []);
    } finally {
      console.error = original;
    }
    assertEquals(warnings.length, 1);
    assertStringIncludes(warnings[0], path);
  });
});

Deno.test('loadDeclaredFeatureIds degrades to [] with a warning when the file does not exist', async () => {
  await withTempDir(async (dir) => {
    const path = `${dir}/nope/devcontainer.json`;
    const warnings: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => warnings.push(args.join(' '));
    try {
      assertEquals(await loadDeclaredFeatureIds(path), []);
    } finally {
      console.error = original;
    }
    assertEquals(warnings.length, 1);
  });
});

Deno.test('materializeDefaultConfig injects the bridge mount only when opted in', async () => {
  await withTempDir(async (cacheDir) => {
    await materializeDefaultConfig(cacheDir, NO_TEMPLATES, { bridge: true });
    const withBridge = JSON.parse(
      stripLineComments(
        await Deno.readTextFile(`${cacheDir}/devcontainer.json`),
      ),
    );
    const mounts: string[] = withBridge.mounts;
    const mount = mounts.filter((m) => m.includes('/run/devc-bridge'));
    assertEquals(mount.length, 1, 'want exactly one bridge mount');

    // A *string*, and read-only. Both halves matter: an object mount cannot express
    // `readonly` (the CLI re-serializes it as type=/src=/dst=), and without `readonly` a
    // container can pin the host's token for the next restart. Do not "normalize" this.
    assertEquals(typeof mount[0], 'string');
    assertEquals(mount[0].startsWith('type=bind,'), true);
    assertEquals(mount[0].split(',').includes('readonly'), true);
    assertEquals(
      mount[0].includes('source=${localEnv:HOME}/.config/devc-bridge/run'),
      true,
    );
  });

  await withTempDir(async (cacheDir) => {
    await materializeDefaultConfig(cacheDir, NO_TEMPLATES, { bridge: false });
    const without = JSON.parse(
      stripLineComments(
        await Deno.readTextFile(`${cacheDir}/devcontainer.json`),
      ),
    );
    assertEquals(
      (without.mounts as string[]).filter((m) =>
        m.includes('/.config/devc-bridge/')
      ),
      [],
      'no opt-in means no bridge mount',
    );
  });

  // The default is off — a caller that forgets the option must not silently mount.
  await withTempDir(async (cacheDir) => {
    await materializeDefaultConfig(cacheDir, NO_TEMPLATES);
    const dc = JSON.parse(
      stripLineComments(
        await Deno.readTextFile(`${cacheDir}/devcontainer.json`),
      ),
    );
    assertEquals(
      (dc.mounts as string[]).filter((m) =>
        m.includes('/.config/devc-bridge/')
      ),
      [],
    );
  });
});

Deno.test('the injected bridge mount leaves the rest of the config intact', async () => {
  // Text insertion into JSONC: the risk is a broken array or lost comments, neither of which a
  // parse of the mounts array alone would catch.
  await withTempDir(async (cacheDir) => {
    await materializeDefaultConfig(cacheDir, NO_TEMPLATES, { bridge: true });
    const text = await Deno.readTextFile(`${cacheDir}/devcontainer.json`);
    const dc = JSON.parse(stripLineComments(text));

    assertEquals(
      typeof dc.image === 'string' || typeof dc.build === 'object',
      true,
    );
    assertEquals(Array.isArray(dc.mounts), true);
    // The comments survive — this is JSONC on purpose — and the mount arrives fenced, so the
    // one config that has it also says who put it there.
    assertEquals(text.includes('// >>> devc:bridge-mount'), true);
    assertEquals(text.includes('// <<< devc:bridge-mount'), true);
    assertEquals(text.includes('// ~/.claude folder'), true);
    // And the other mounts are still there, unduplicated.
    const claudeSeed = (dc.mounts as string[]).filter((m) =>
      m.includes('claude-seed')
    );
    assertEquals(claudeSeed.length, 1);
  });
});

Deno.test('bridge injection is skipped when the config already declares the mount', async () => {
  // A user template that wrote the mount itself wins: two mounts on the same target is
  // Docker's `Duplicate mount point`, a hard create failure.
  await withTempDir(async (tmp) => {
    const templates = `${tmp}/templates`;
    const cacheDir = `${tmp}/cache`;
    await mkdir(templates);
    await Deno.writeTextFile(
      `${templates}/devcontainer.json`,
      JSON.stringify(
        {
          name: 'mine',
          image: 'ubuntu',
          mounts: [
            'type=bind,source=${localEnv:HOME}/.config/devc-bridge/run,target=/run/devc-bridge,readonly',
          ],
        },
        null,
        2,
      ),
    );

    await materializeDefaultConfig(cacheDir, templates, { bridge: true });
    const dc = JSON.parse(
      stripLineComments(
        await Deno.readTextFile(`${cacheDir}/devcontainer.json`),
      ),
    );
    assertEquals(
      (dc.mounts as string[]).filter((m) => m.includes('/run/devc-bridge'))
        .length,
      1,
      'must not double up on the same mount target',
    );
  });
});

Deno.test('a user template with no mounts array still gets the bridge mount', async () => {
  // The injection needs no marker in the config it edits — that is what lets the bundled
  // default (and every project `devc init` scaffolds from it) stay free of bridge references.
  // A hand-written template that never declared `mounts` gets the array created for it, rather
  // than the mount being silently dropped for want of an anchor.
  await withTempDir(async (tmp) => {
    const templates = `${tmp}/templates`;
    const cacheDir = `${tmp}/cache`;
    await mkdir(templates);
    await Deno.writeTextFile(
      `${templates}/devcontainer.json`,
      '{\n  // hand-written\n  "name": "mine",\n  "image": "ubuntu"\n}\n',
    );

    await materializeDefaultConfig(cacheDir, templates, { bridge: true });
    const text = await Deno.readTextFile(`${cacheDir}/devcontainer.json`);
    const dc = JSON.parse(stripLineComments(text));
    assertEquals(dc.mounts, [
      'type=bind,source=${localEnv:HOME}/.config/devc-bridge/run,target=/run/devc-bridge,readonly',
    ]);
    // Their own file survives intact, comment included.
    assertEquals(dc.image, 'ubuntu');
    assertEquals(text.includes('// hand-written'), true);
  });
});
