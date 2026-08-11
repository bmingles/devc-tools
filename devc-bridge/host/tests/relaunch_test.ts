// The relaunch argv: what `devc-bridge start` hands to the detached child.
//
// Both modes are covered here because only one of them is ever observable at a
// time — a test run is `deno run`, so the compiled branch would otherwise be
// exercised for the first time by a released binary. That branch failing is the
// bug this whole change exists to fix, so it is pinned rather than assumed.

import { assertEquals, assertStringIncludes, assertThrows } from '@std/assert';
import { fromFileUrl } from '@std/path';
import { relaunchArgv } from '../main.ts';

const MAIN = fromFileUrl(new URL('../main.ts', import.meta.url));

Deno.test('relaunchArgv: compiled — the binary is the whole command', () => {
  assertEquals(
    relaunchArgv(['run'], {
      standalone: true,
      execPath: '/usr/local/bin/devc-bridge',
      // A compiled binary reports this virtual path; nothing may consume it.
      mainModule: 'file:///tmp/deno-compile-devc-bridge/main.ts',
    }),
    ['/usr/local/bin/devc-bridge', 'run'],
  );
});

Deno.test('relaunchArgv: from source — deno run, permissions, script', () => {
  assertEquals(
    relaunchArgv(['run'], {
      standalone: false,
      execPath: '/usr/local/bin/deno',
      mainModule: 'file:///repo/devc-bridge/host/main.ts',
    }),
    [
      '/usr/local/bin/deno',
      'run',
      '--allow-read',
      '--allow-write',
      '--allow-run',
      '--allow-env',
      '--allow-net',
      '/repo/devc-bridge/host/main.ts',
      'run',
    ],
  );
});

Deno.test('relaunchArgv: extra args are passed through in order', () => {
  assertEquals(
    relaunchArgv(['run', '--tray'], {
      standalone: true,
      execPath: '/bin/devc-bridge',
    }),
    ['/bin/devc-bridge', 'run', '--tray'],
  );
});

Deno.test('relaunchArgv: a non-file main module cannot be relaunched', () => {
  const e = assertThrows(
    () =>
      relaunchArgv(['run'], {
        standalone: false,
        execPath: '/usr/local/bin/deno',
        mainModule: 'https://example.com/main.ts',
      }),
    Error,
  );
  assertStringIncludes(e.message, 'devc-bridge:');
});

Deno.test('relaunchArgv: defaults describe this process', () => {
  // Under `deno test` we are the from-source case; assert the shape rather than
  // the exact paths, which differ per machine.
  const argv = relaunchArgv(['run']);
  assertEquals(argv[0], Deno.execPath());
  assertEquals(argv[1], 'run');
  assertEquals(argv[argv.length - 1], 'run');
});

Deno.test({
  name: 'relaunchArgv: the argv it returns is actually runnable',
  // The point of the helper is that the child *starts*. Running it with an
  // unknown subcommand exercises the whole command line — permissions included —
  // without leaving a bridge behind: usage on stderr, exit 2.
  fn: async () => {
    const [command, ...args] = relaunchArgv(['no-such-command'], {
      standalone: false,
      execPath: Deno.execPath(),
      mainModule: new URL('../main.ts', import.meta.url).href,
    });
    const out = await new Deno.Command(command, {
      args,
      stdout: 'piped',
      stderr: 'piped',
    }).output();
    assertEquals(out.code, 2);
    const stderr = new TextDecoder().decode(out.stderr);
    assertStringIncludes(stderr, 'unknown command "no-such-command"');
    assertStringIncludes(stderr, 'usage: devc-bridge');
  },
});

Deno.test('relaunchArgv: the script it names is this main.ts', () => {
  const argv = relaunchArgv([], {
    standalone: false,
    execPath: '/usr/local/bin/deno',
    mainModule: new URL('../main.ts', import.meta.url).href,
  });
  assertEquals(argv[argv.length - 1], MAIN);
});
