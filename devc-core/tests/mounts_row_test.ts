import { assertEquals, assertThrows } from 'jsr:@std/assert@^1';
import {
  assertNoDuplicateTarget,
  basename,
  defaultTarget,
  DuplicateTargetError,
  foldHome,
  type MountRow,
  parseEntry,
  rowForHostPath,
  rowToEntry,
  serializeMount,
  SKILLS_CONTAINER_ROOT,
  SOURCE_CONTAINER_ROOT,
} from '../mounts.ts';
import { MOUNT_SPEC_RE } from '../overlay.ts';

Deno.test('serializeMount: one form for both steps, no readonly/consistency', () => {
  assertEquals(
    serializeMount({ source: '/host/p', target: '/workspaces/p' }),
    'type=bind,source=/host/p,target=/workspaces/p',
  );
  assertEquals(
    serializeMount({
      source: '/host/s',
      target: '/home/vscode/.claude/skills/s',
    }),
    'type=bind,source=/host/s,target=/home/vscode/.claude/skills/s',
  );
});

// The whole point of the format change: what the wizard writes has to survive the
// devcontainer CLI's own `--mount` arg validation, which rejects anything else outright.
Deno.test('serializeMount output is accepted by the CLI mount regex', () => {
  const rows: MountRow[] = [
    { source: '/host/p', target: '/workspaces/p' },
    {
      source: '${localEnv:HOME}/code/team/proj',
      target: '/workspaces/team/proj',
    },
    {
      source: '${localEnv:HOME}/skills/agent',
      target: '/home/vscode/.claude/skills/agent',
    },
    { source: '/abs/wt/.git', target: '${containerWorkspaceFolder}/../wt.git' },
  ];
  for (const row of rows) {
    const spec = serializeMount(row);
    assertEquals(MOUNT_SPEC_RE.test(spec), true, `rejected: ${spec}`);
  }
});

Deno.test('serialize/parse round-trip through a fence entry', () => {
  const rows: MountRow[] = [
    { source: '${localEnv:HOME}/code/p', target: '/workspaces/p' },
    { source: '/abs/skills/s', target: '/home/vscode/.claude/skills/s' },
  ];
  for (const row of rows) {
    const entry = rowToEntry(row);
    // A fence entry is a JSON-quoted spec string.
    assertEquals(entry, JSON.stringify(serializeMount(row)));
    assertEquals(parseEntry(entry), row);
  }
});

Deno.test('parseEntry: accepts a bare spec and rejects non-bind entries', () => {
  assertEquals(
    parseEntry('type=bind,source=/a,target=/b'),
    { source: '/a', target: '/b' },
  );
  assertEquals(parseEntry('"type=volume,source=vol,target=/x"'), null);
  assertEquals(parseEntry('"not a mount"'), null);
});

// Specs an older devc wrote into a `devcontainer.json` fence still parse — the retired fields
// are ignored, so re-serializing normalizes them away instead of failing the read.
Deno.test('parseEntry: ignores retired consistency/readonly fields', () => {
  assertEquals(
    parseEntry('type=bind,source=/a,target=/b,consistency=cached'),
    { source: '/a', target: '/b' },
  );
  assertEquals(
    parseEntry(
      '"type=bind,source=/s,target=/home/vscode/.claude/skills/s,consistency=cached,readonly"',
    ),
    { source: '/s', target: '/home/vscode/.claude/skills/s' },
  );
});

Deno.test('foldHome: paths under $HOME fold; others stay absolute', () => {
  assertEquals(
    foldHome('/home/me/code/p', '/home/me'),
    '${localEnv:HOME}/code/p',
  );
  assertEquals(foldHome('/home/me', '/home/me'), '${localEnv:HOME}');
  assertEquals(foldHome('/srv/repos/p', '/home/me'), '/srv/repos/p');
  // Already folded / ~ paths are left as-is.
  assertEquals(
    foldHome('${localEnv:HOME}/x', '/home/me'),
    '${localEnv:HOME}/x',
  );
  assertEquals(foldHome('~/x', '/home/me'), '~/x');
});

Deno.test('basename + default targets for each step', () => {
  assertEquals(basename('/home/me/code/my-repo/'), 'my-repo');
  assertEquals(
    defaultTarget('source', '/home/me/code/my-repo'),
    `${SOURCE_CONTAINER_ROOT}/my-repo`,
  );
  assertEquals(
    defaultTarget('skills', '/home/me/skills/agent'),
    `${SKILLS_CONTAINER_ROOT}/agent`,
  );
});

Deno.test('defaultTarget: source keeps the sub-path under a matching root', () => {
  // nested folder under the root → the sub-path is preserved
  assertEquals(
    defaultTarget('source', '/home/me/code/team/proj', '/home/me/code'),
    `${SOURCE_CONTAINER_ROOT}/team/proj`,
  );
  // worktree layout under the root
  assertEquals(
    defaultTarget(
      'source',
      '/home/me/code/myproject.worktrees/feature1',
      '/home/me/code',
    ),
    `${SOURCE_CONTAINER_ROOT}/myproject.worktrees/feature1`,
  );
  // top-level folder under the root → same as basename
  assertEquals(
    defaultTarget('source', '/home/me/code/proj', '/home/me/code'),
    `${SOURCE_CONTAINER_ROOT}/proj`,
  );
  // no matching root → basename fallback
  assertEquals(
    defaultTarget('source', '/srv/repos/team/proj', '/home/me/code'),
    `${SOURCE_CONTAINER_ROOT}/proj`,
  );
  // skills ignore the root and always use the basename
  assertEquals(
    defaultTarget('skills', '/home/me/code/team/agent', '/home/me/code'),
    `${SKILLS_CONTAINER_ROOT}/agent`,
  );
});

Deno.test('rowForHostPath threads the root into a relative source target', () => {
  const home = Deno.env.get('HOME')!;
  const row = rowForHostPath(
    'source',
    `${home}/code/team/proj`,
    `${home}/code`,
  );
  assertEquals(row, {
    source: '${localEnv:HOME}/code/team/proj',
    target: `${SOURCE_CONTAINER_ROOT}/team/proj`,
  });
});

Deno.test('rowForHostPath folds home and applies step defaults', () => {
  const home = Deno.env.get('HOME')!;
  const src = rowForHostPath('source', `${home}/code/p`);
  assertEquals(src, {
    source: '${localEnv:HOME}/code/p',
    target: `${SOURCE_CONTAINER_ROOT}/p`,
  });
  const sk = rowForHostPath('skills', '/srv/skills/agent');
  assertEquals(sk, {
    source: '/srv/skills/agent',
    target: `${SKILLS_CONTAINER_ROOT}/agent`,
  });
});

Deno.test('duplicate target within a step is rejected', () => {
  const rows: MountRow[] = [{ source: '/a', target: '/workspaces/p' }];
  assertThrows(
    () =>
      assertNoDuplicateTarget(rows, { source: '/b', target: '/workspaces/p' }),
    DuplicateTargetError,
    '/workspaces/p',
  );
  // A different target is fine.
  assertNoDuplicateTarget(rows, { source: '/b', target: '/workspaces/q' });
  // Editing a row against itself (same index) is allowed.
  assertNoDuplicateTarget(rows, { source: '/a', target: '/workspaces/p' }, 0);
});
