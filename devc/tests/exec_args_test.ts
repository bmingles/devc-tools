import { assertEquals } from 'jsr:@std/assert@^1';
import { buildExecArgs } from '../container.ts';

Deno.test('buildExecArgs includes -i and never -t', () => {
  const args = buildExecArgs({
    containerId: 'abc123',
    remoteUser: 'vscode',
    cwd: '/workspaces/some-tool',
    remoteEnv: {},
    env: {},
    cmd: ['echo', 'hi'],
  });
  assertEquals(args.includes('-i'), true);
  assertEquals(args.includes('-t'), false);
  assertEquals(args.includes('-it'), false);
});

Deno.test('buildExecArgs sets -u and -w', () => {
  const args = buildExecArgs({
    containerId: 'abc123',
    remoteUser: 'vscode',
    cwd: '/some/dir',
    remoteEnv: {},
    env: {},
    cmd: ['true'],
  });
  assertEquals(args[args.indexOf('-u') + 1], 'vscode');
  assertEquals(args[args.indexOf('-w') + 1], '/some/dir');
});

Deno.test('buildExecArgs emits one -e K=V per env entry', () => {
  const args = buildExecArgs({
    containerId: 'abc123',
    remoteUser: 'vscode',
    cwd: '/w',
    remoteEnv: { FOO: '1' },
    env: { BAR: '2' },
    cmd: ['true'],
  });
  const eFlags = args.reduce((acc, a, i) => {
    if (a === '-e') acc.push(args[i + 1]);
    return acc;
  }, [] as string[]);
  assertEquals(eFlags, ['FOO=1', 'BAR=2']);
});

Deno.test('buildExecArgs lets env override remoteEnv on key collision', () => {
  const args = buildExecArgs({
    containerId: 'abc123',
    remoteUser: 'vscode',
    cwd: '/w',
    remoteEnv: { PATH: '/usr/bin', KEEP: 'yes' },
    env: { PATH: '/override/bin' },
    cmd: ['true'],
  });
  const eFlags = args.reduce((acc, a, i) => {
    if (a === '-e') acc.push(args[i + 1]);
    return acc;
  }, [] as string[]);
  // One entry per key; PATH takes env's value, position unchanged.
  assertEquals(eFlags, ['PATH=/override/bin', 'KEEP=yes']);
});

Deno.test('buildExecArgs passes cmd verbatim after the container id', () => {
  const cmd = ['bash', '-lc', "echo 'a b' && exit 3"];
  const args = buildExecArgs({
    containerId: 'cid',
    remoteUser: 'vscode',
    cwd: '/w',
    remoteEnv: {},
    env: {},
    cmd,
  });
  const idIndex = args.indexOf('cid');
  assertEquals(idIndex >= 0, true);
  assertEquals(args.slice(idIndex + 1), cmd);
});

Deno.test('buildExecArgs starts with exec', () => {
  const args = buildExecArgs({
    containerId: 'cid',
    remoteUser: 'vscode',
    cwd: '/w',
    remoteEnv: {},
    env: {},
    cmd: ['true'],
  });
  assertEquals(args[0], 'exec');
});
