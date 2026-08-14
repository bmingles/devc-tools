import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert@^1';
import {
  DEVCONTAINER_SUBCOMMAND,
  devcontainerArgv,
} from '../devcontainer_cli.ts';
import { fromFileUrl } from 'jsr:@std/path';

/**
 * Spawn the embedded CLI the way `devcontainerCommand` does from source, through the real
 * {@link devcontainerArgv} — so these tests cover the permission set the child is given, not just
 * a hand-written argv that happens to work.
 *
 * `devcontainerCommand` itself cannot be called here: it reads `Deno.mainModule`, which under
 * `deno test` is a test module rather than `main.ts`. Only that one field is substituted.
 */
function runEmbedded(args: string[]): Promise<Deno.CommandOutput> {
  return new Deno.Command(Deno.execPath(), {
    args: devcontainerArgv(args, {
      execPath: Deno.execPath(),
      standalone: false,
      mainModule: import.meta.resolve('../main.ts'),
    }),
    stdout: 'piped',
    stderr: 'piped',
  }).output();
}

// Compiled is the shipping shape and the one no test can reach by running: `Deno.build.standalone`
// is false under `deno test`, so the branch is only checkable through the pure function.
Deno.test('compiled: the binary re-execs itself with the hidden subcommand', () => {
  assertEquals(
    devcontainerArgv(['up', '--workspace-folder', '/home/me/src/p'], {
      execPath: '/home/me/.local/bin/devc',
      standalone: true,
      mainModule: 'file:///home/me/.local/bin/devc',
    }),
    [DEVCONTAINER_SUBCOMMAND, 'up', '--workspace-folder', '/home/me/src/p'],
  );
});

// From source `execPath` is `deno` itself, so the whole invocation has to be rebuilt around
// main.ts — and with permissions spelled out, since a spawned process inherits none.
Deno.test('from source: the argv is a full `deno run` of main.ts', () => {
  const argv = devcontainerArgv(['up'], {
    execPath: '/usr/local/bin/deno',
    standalone: false,
    mainModule: 'file:///home/me/src/devc-tools/devc/main.ts',
  });

  assertEquals(argv[0], 'run');
  assertEquals(argv.at(-2), DEVCONTAINER_SUBCOMMAND);
  assertEquals(argv.at(-1), 'up');
  assertEquals(argv.at(-3), '/home/me/src/devc-tools/devc/main.ts');
  // The CLI's own needs, beyond devc's: `osRelease` on startup, and its HTTPS fetches of
  // Features from OCI registries during `up`.
  assert(argv.includes('--allow-sys'));
  assert(argv.includes('--allow-net'));
});

// devc's own args are passed through untouched — the CLI parses them, devc does not.
Deno.test('devcontainer args are appended verbatim', () => {
  const argv = devcontainerArgv(
    [
      'up',
      '--additional-features',
      '{"a":{}}',
      '--mount',
      'type=bind,source=/a,target=/b',
    ],
    { execPath: '/devc', standalone: true, mainModule: 'file:///devc' },
  );
  assertEquals(argv.slice(1), [
    'up',
    '--additional-features',
    '{"a":{}}',
    '--mount',
    'type=bind,source=/a,target=/b',
  ]);
});

// The one test that proves the embedding actually works: spawn the hidden subcommand for real and
// make the child answer as the devcontainer CLI. Nothing else here would notice if the npm pin,
// the argv shim or the dynamic import broke — the pure tests above all pass against a child that
// never starts.
//
// Pinned to the exact version in deno.json's `imports`, so a drifted pin fails here rather than in
// a release binary.
Deno.test('the embedded CLI runs and reports its pinned version', async () => {
  const { code, stdout, stderr } = await runEmbedded(['--version']);

  assertEquals(
    code,
    0,
    `exited ${code}: ${new TextDecoder().decode(stderr)}`,
  );
  assertEquals(new TextDecoder().decode(stdout).trim(), '0.88.0');
});

// `up` is the only command devc runs, and it is the JSON-per-line stdout that `startContainer`
// parses. Run it somewhere with no Docker: reaching a *docker* failure means the argv shim, the
// config discovery and the log format all worked — the only thing missing is a daemon.
Deno.test('the embedded CLI runs `up` and emits parseable JSON outcome', async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${dir}/.devcontainer`);
    await Deno.writeTextFile(
      `${dir}/.devcontainer/devcontainer.json`,
      '{ "image": "mcr.microsoft.com/devcontainers/base:ubuntu" }',
    );

    const { stdout } = await runEmbedded([
      'up',
      '--workspace-folder',
      dir,
      '--log-format',
      'json',
      // Point at a Docker CLI that cannot exist, so the outcome is the same whether or not the
      // machine running the tests has a daemon.
      '--docker-path',
      `${dir}/no-such-docker`,
    ]);

    const lines = new TextDecoder().decode(stdout).trim().split('\n').filter(
      Boolean,
    );
    assert(lines.length > 0, 'the CLI produced no stdout at all');
    const result = JSON.parse(lines[lines.length - 1]);
    assertEquals(result.outcome, 'error');
    assertStringIncludes(result.message, 'no-such-docker');
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
