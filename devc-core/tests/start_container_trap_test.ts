// The regression guard for the isEmptyOverlay trap documented at its call site in
// startContainer (container.ts) and in isEmptyOverlay's own doc comment (overlay.ts): after
// baseline Feature injection, the *effective* overlay is (almost) never empty, so
// computeContainerWorkspaceFolder must be gated on the user's own overlay, not the effective
// one — otherwise every `up`/`exec` pays for its git subprocesses forever, silently.
//
// Reverting the call site to `isEmptyOverlay(effective)` must make this test fail — that is
// what earns this test its place, mirroring how `ensureDefaultConfig`'s `finalDir` trap has its
// own test. No Docker needed: a fake DevcontainerRunner stands in for `devcontainer up`, and a
// fake `git` on PATH turns "did computeContainerWorkspaceFolder run" into an observable —
// `--show-cdup` is the one flag only it asks for; `isGitWorktree` (which always runs) never
// does.
import process from 'node:process';
import { startContainer } from '../container.ts';
import type { DevcontainerRunner } from '../devcontainer.ts';
import { withTemp } from './helpers.ts';

const FAKE_RUNNER: DevcontainerRunner = {
  run: () =>
    Promise.resolve({
      code: 0,
      stdout: JSON.stringify({
        outcome: 'success',
        containerId: 'deadbeef',
        remoteUser: 'vscode',
        remoteWorkspaceFolder: '/workspaces/x',
      }) + '\n',
    }),
};

// Project mode: a repo with its own devcontainer.json that devc did not write, and no devc.json
// overlay anywhere. withBaselineFeatures injects devc-config here (the bundled default
// devcontainer.json never declares it itself — see overlay.ts's DEVC_CONFIG_FEATURE), so
// `effective` diverges from the empty `overlay`, which is what makes this the case that can
// actually distinguish the two arguments to isEmptyOverlay.
Deno.test('startContainer: project mode, no devc.json anywhere, never shells out for the container workspace folder', async () => {
  await withTemp(async (dir) => {
    const binDir = `${dir}/bin`;
    await Deno.mkdir(binDir);
    const logPath = `${dir}/git.log`;
    await Deno.writeTextFile(logPath, '');
    // Logs its args and fails, like git would against a directory with no repo — good enough
    // here, since this test only cares which flags were asked for, not what git would answer.
    await Deno.writeTextFile(
      `${binDir}/git`,
      '#!/bin/sh\necho "$@" >> "$GIT_LOG_FILE"\nexit 1\n',
    );
    await Deno.chmod(`${binDir}/git`, 0o755);

    const project = `${dir}/project`;
    await Deno.mkdir(`${project}/.devcontainer`, { recursive: true });
    await Deno.writeTextFile(
      `${project}/.devcontainer/devcontainer.json`,
      JSON.stringify({ image: 'mcr.microsoft.com/devcontainers/base:ubuntu' }),
    );

    const originalPath = process.env.PATH;
    const originalLog = process.env.GIT_LOG_FILE;
    // Prepended, not replaced: startContainer's other steps (docker inspect/tag, both
    // best-effort and already offline-safe) are unaffected either way.
    process.env.PATH = `${binDir}:${originalPath ?? ''}`;
    process.env.GIT_LOG_FILE = logPath;
    try {
      await startContainer(project, false, { devcontainer: FAKE_RUNNER });
    } finally {
      process.env.PATH = originalPath;
      if (originalLog === undefined) delete process.env.GIT_LOG_FILE;
      else process.env.GIT_LOG_FILE = originalLog;
    }

    const log = await Deno.readTextFile(logPath);
    if (log.includes('--show-cdup')) {
      throw new Error(
        'computeContainerWorkspaceFolder ran (git invoked with --show-cdup) even though the ' +
          `user overlay was empty:\n${log}`,
      );
    }
  });
});
