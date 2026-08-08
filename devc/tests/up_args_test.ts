import { assertEquals } from 'jsr:@std/assert@^1';
import { buildUpArgs } from '../container.ts';
import { emptyOverlay, loadMergedOverlay } from '../overlay.ts';
import { withTemp } from './helpers.ts';

const BASE = {
  localFolder: '/home/me/src/p',
  worktree: false,
  rebuild: false,
  noCache: false,
  configArg: null,
  overlay: emptyOverlay(),
  containerWorkspaceFolder: '/workspaces/p',
};

// The regression guard for the whole feature: with no overlay anywhere, the argv is exactly what
// devc emitted before the overlay existed.
Deno.test('no overlay: project mode argv is unchanged', () => {
  assertEquals(buildUpArgs(BASE), [
    'up',
    '--workspace-folder',
    '/home/me/src/p',
  ]);
});

Deno.test('no overlay: zero-config argv is unchanged', () => {
  assertEquals(
    buildUpArgs({
      ...BASE,
      worktree: true,
      rebuild: true,
      noCache: true,
      configArg: '/home/me/.cache/devc/default/devcontainer.json',
    }),
    [
      'up',
      '--workspace-folder',
      '/home/me/src/p',
      '--mount-git-worktree-common-dir',
      '--remove-existing-container',
      '--build-no-cache',
      '--config',
      '/home/me/.cache/devc/default/devcontainer.json',
    ],
  );
});

Deno.test("overlay args are appended after devc's own args", () => {
  assertEquals(
    buildUpArgs({
      ...BASE,
      configArg: '/cache/devcontainer.json',
      overlay: {
        mounts: ['type=bind,source=/a,target=/b'],
        additionalFeatures: { 'ghcr.io/x/rust:1': { version: 'latest' } },
        remoteEnv: { A: '1' },
      },
    }),
    [
      'up',
      '--workspace-folder',
      '/home/me/src/p',
      '--config',
      '/cache/devcontainer.json',
      '--mount',
      'type=bind,source=/a,target=/b',
      '--additional-features',
      '{"ghcr.io/x/rust:1":{"version":"latest"}}',
      '--remote-env',
      'A=1',
    ],
  );
});

// The reference implementation's bug: a project with its own `devcontainer.json` (so no
// `--config`) got no overlay args at all.
Deno.test('a project with its own devcontainer.json still gets overlay args', async () => {
  await withTemp(async (dir) => {
    await Deno.mkdir(`${dir}/.devcontainer`, { recursive: true });
    await Deno.writeTextFile(
      `${dir}/.devcontainer/devcontainer.json`,
      '{"image":"x"}',
    );
    await Deno.mkdir(`${dir}/.devc`, { recursive: true });
    await Deno.writeTextFile(
      `${dir}/.devc/devc.json`,
      '{"mounts":["type=bind,source=${containerWorkspaceFolder},target=/mirror"]}',
    );

    assertEquals(
      buildUpArgs({
        ...BASE,
        localFolder: dir,
        // `configArg` is null exactly because the project has its own config.
        configArg: null,
        overlay: await loadMergedOverlay(dir, `${dir}/nouser`),
      }),
      [
        'up',
        '--workspace-folder',
        dir,
        '--mount',
        'type=bind,source=/workspaces/p,target=/mirror',
      ],
    );
  });
});

// `--mount`/`--remote-env` have to exist before `devcontainer up` runs, so these substitute
// against the locally computed pre-`up` value. The post-`up` `remoteWorkspaceFolder` is
// authoritative but not yet available; the two calls are deliberately not unified.
Deno.test('buildUpArgs substitutes mounts against the pre-up containerWorkspaceFolder', () => {
  assertEquals(
    buildUpArgs({
      ...BASE,
      containerWorkspaceFolder: '/workspaces/outer/wt',
      overlay: {
        mounts: [
          'type=bind,source=${localWorkspaceFolder},target=${containerWorkspaceFolder}/self',
        ],
        additionalFeatures: {},
        remoteEnv: {},
      },
    }),
    [
      'up',
      '--workspace-folder',
      '/home/me/src/p',
      '--mount',
      'type=bind,source=/home/me/src/p,target=/workspaces/outer/wt/self',
    ],
  );
});
