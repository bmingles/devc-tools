import { assert, assertEquals } from 'jsr:@std/assert@^1';
import { mergeConfigs, mountTarget, REPLACE_KEY } from '../merge.ts';

/** Run `fn` with `console.error` captured, returning the lines it emitted. */
function captureStderr(fn: () => void): string[] {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => lines.push(args.join(' '));
  try {
    fn();
  } finally {
    console.error = original;
  }
  return lines;
}

// ── the five rules ──────────────────────────────────────────────────────────────────────────

Deno.test('scalars: the higher layer wins', () => {
  assertEquals(
    mergeConfigs([{ name: 'base', remoteUser: 'vscode' }, { name: 'mine' }]),
    { name: 'mine', remoteUser: 'vscode' },
  );
});

Deno.test('objects merge recursively, per key', () => {
  assertEquals(
    mergeConfigs([
      {
        remoteEnv: { A: '1', B: '2' },
        customizations: { vscode: { settings: { a: 1 } } },
      },
      {
        remoteEnv: { B: 'two', C: '3' },
        customizations: { vscode: { settings: { b: 2 } } },
      },
    ]),
    {
      remoteEnv: { A: '1', B: 'two', C: '3' },
      customizations: { vscode: { settings: { a: 1, b: 2 } } },
    },
  );
});

Deno.test('arrays append, lower layer first', () => {
  assertEquals(
    mergeConfigs([
      { runArgs: ['--a'], forwardPorts: [3000] },
      { runArgs: ['--b'], forwardPorts: [4000] },
    ]),
    { runArgs: ['--a', '--b'], forwardPorts: [3000, 4000] },
  );
});

// The one exception, inherited from the flag-era overlay: half a project's options blended with
// half the user's is much harder to reason about than "the project's entry replaces the user's".
Deno.test("a Feature's options object is replaced whole, not deep-merged", () => {
  assertEquals(
    mergeConfigs([
      { features: { 'ghcr.io/x/node:1': { version: 'lts', pnpm: 'none' } } },
      { features: { 'ghcr.io/x/node:1': { version: '22' } } },
    ]),
    { features: { 'ghcr.io/x/node:1': { version: '22' } } },
  );
});

Deno.test('features merge per id, leaving other ids alone', () => {
  assertEquals(
    mergeConfigs([
      { features: { 'ghcr.io/x/node:1': {}, 'ghcr.io/x/go:1': {} } },
      { features: { 'ghcr.io/x/rust:1': { version: 'latest' } } },
    ]),
    {
      features: {
        'ghcr.io/x/node:1': {},
        'ghcr.io/x/go:1': {},
        'ghcr.io/x/rust:1': { version: 'latest' },
      },
    },
  );
});

// ── null deletes ────────────────────────────────────────────────────────────────────────────

Deno.test('null deletes a key the layer below set', () => {
  assertEquals(
    mergeConfigs([{ initializeCommand: 'setup.sh', name: 'x' }, {
      initializeCommand: null,
    }]),
    { name: 'x' },
  );
});

Deno.test('null deletes at any depth', () => {
  assertEquals(
    mergeConfigs([
      { remoteEnv: { KEEP: 'a', DROP: 'b' } },
      { remoteEnv: { DROP: null } },
    ]),
    { remoteEnv: { KEEP: 'a' } },
  );
});

Deno.test('null deletes through two layers, and a third can re-add', () => {
  assertEquals(
    mergeConfigs([
      { mounts: ['type=bind,source=/a,target=/b'] },
      { mounts: null },
      { mounts: ['type=bind,source=/c,target=/d'] },
    ]),
    { mounts: ['type=bind,source=/c,target=/d'] },
  );
});

Deno.test('a null for a key nothing set is simply nothing', () => {
  assertEquals(mergeConfigs([{ name: 'x' }, { image: null }]), { name: 'x' });
});

// ── $replace ────────────────────────────────────────────────────────────────────────────────

Deno.test('$replace makes one key replace instead of merging, and never reaches the output', () => {
  const merged = mergeConfigs([
    { mounts: ['type=bind,source=/a,target=/b'], name: 'base' },
    { [REPLACE_KEY]: ['mounts'], mounts: ['type=bind,source=/c,target=/d'] },
  ]);
  assertEquals(merged, {
    mounts: ['type=bind,source=/c,target=/d'],
    name: 'base',
  });
  assertEquals(REPLACE_KEY in merged, false);
});

Deno.test('$replace applies only to the keys it names', () => {
  assertEquals(
    mergeConfigs([
      { remoteEnv: { A: '1' }, runArgs: ['--a'] },
      { [REPLACE_KEY]: ['remoteEnv'], remoteEnv: { B: '2' }, runArgs: ['--b'] },
    ]),
    { remoteEnv: { B: '2' }, runArgs: ['--a', '--b'] },
  );
});

Deno.test('$replace applies to the layers below it, not just the one under it', () => {
  assertEquals(
    mergeConfigs([
      { forwardPorts: [1] },
      { forwardPorts: [2] },
      { [REPLACE_KEY]: ['forwardPorts'], forwardPorts: [3] },
    ]),
    { forwardPorts: [3] },
  );
});

Deno.test('a malformed $replace warns and merges as usual', () => {
  let merged: Record<string, unknown> = {};
  const warnings = captureStderr(() => {
    merged = mergeConfigs([
      { forwardPorts: [1] },
      { [REPLACE_KEY]: 'forwardPorts', forwardPorts: [2] },
    ]);
  });
  assertEquals(merged.forwardPorts, [1, 2]);
  assertEquals(warnings.length, 1);
});

// ── mount target dedupe ─────────────────────────────────────────────────────────────────────

Deno.test('mountTarget reads target=, dst= and the object form', () => {
  assertEquals(mountTarget('type=bind,source=/a,target=/b'), '/b');
  assertEquals(mountTarget('type=bind,src=/a,dst=/b'), '/b');
  assertEquals(mountTarget('target=/b,source=/a,type=bind'), '/b');
  assertEquals(
    mountTarget('type=bind,source=/a,target=/b,readonly'),
    '/b',
  );
  assertEquals(mountTarget({ type: 'bind', source: '/a', target: '/b' }), '/b');
  assertEquals(mountTarget('type=bind,source=/a'), null);
  assertEquals(mountTarget({ type: 'bind' }), null);
  assertEquals(mountTarget(42), null);
});

// The rule that turns "arrays append" into "override the bundled claude-seed mount".
Deno.test('a later mount on the same target replaces the earlier one, in place', () => {
  assertEquals(
    mergeConfigs([
      {
        mounts: [
          'type=bind,source=/first,target=/a',
          'type=bind,source=/x,target=/keep',
        ],
      },
      { mounts: ['type=bind,source=/second,target=/a,readonly'] },
    ]),
    {
      mounts: [
        'type=bind,source=/second,target=/a,readonly',
        'type=bind,source=/x,target=/keep',
      ],
    },
  );
});

Deno.test('dedupe matches a string mount against an object mount on the same target', () => {
  assertEquals(
    mergeConfigs([
      { mounts: ['type=bind,source=/first,target=/a'] },
      { mounts: [{ type: 'bind', source: '/second', target: '/a' }] },
    ]),
    { mounts: [{ type: 'bind', source: '/second', target: '/a' }] },
  );
});

// Collapsing two mounts because neither could be parsed would be much worse than letting Docker
// report a duplicate.
Deno.test('entries with no readable target are never deduped against each other', () => {
  assertEquals(
    mergeConfigs([
      { mounts: ['garbage', 'more garbage'] },
      { mounts: ['still garbage'] },
    ]),
    { mounts: ['garbage', 'more garbage', 'still garbage'] },
  );
});

Deno.test('extensions dedupe by id, first occurrence kept', () => {
  assertEquals(
    mergeConfigs([
      { customizations: { vscode: { extensions: ['a', 'b'] } } },
      { customizations: { vscode: { extensions: ['b', 'c'] } } },
    ]),
    { customizations: { vscode: { extensions: ['a', 'b', 'c'] } } },
  );
});

// ── warnings ────────────────────────────────────────────────────────────────────────────────

Deno.test('replacing a lifecycle command warns, naming the key', () => {
  const warnings = captureStderr(() => {
    mergeConfigs([
      { postCreateCommand: 'base.sh' },
      { postCreateCommand: 'mine.sh' },
    ]);
  });
  assertEquals(warnings.length, 1);
  assert(warnings[0].includes('postCreateCommand'));
  assert(warnings[0].includes('devc-post-create.sh'));
});

// A deletion is not a replacement: nothing is being discarded in favour of something else.
Deno.test('deleting a lifecycle command with null warns about nothing', () => {
  assertEquals(
    captureStderr(() => {
      mergeConfigs([{ postCreateCommand: 'base.sh' }, {
        postCreateCommand: null,
      }]);
    }),
    [],
  );
});

Deno.test('deleting a shape key with null neither warns nor drops the others', () => {
  let merged: Record<string, unknown> = {};
  const warnings = captureStderr(() => {
    merged = mergeConfigs([
      { build: { dockerfile: 'Dockerfile' }, name: 'x' },
      { image: null },
    ]);
  });
  assertEquals(merged, { build: { dockerfile: 'Dockerfile' }, name: 'x' });
  assertEquals(warnings, []);
});

Deno.test('a lifecycle command only the base sets warns about nothing', () => {
  assertEquals(
    captureStderr(() => {
      mergeConfigs([{ postCreateCommand: 'base.sh' }, { name: 'x' }]);
    }),
    [],
  );
});

// image / build / dockerComposeFile are mutually exclusive in the spec, so merging them would
// produce a config the CLI rejects.
Deno.test('an overlay image replaces the base build, with a warning', () => {
  let merged: Record<string, unknown> = {};
  const warnings = captureStderr(() => {
    merged = mergeConfigs([
      { build: { dockerfile: 'Dockerfile' }, name: 'x' },
      { image: 'ubuntu:24.04' },
    ]);
  });
  assertEquals(merged, { image: 'ubuntu:24.04', name: 'x' });
  assertEquals(warnings.length, 1);
  assert(warnings[0].includes('build'));
});

Deno.test('the base config declaring a shape on its own warns about nothing', () => {
  assertEquals(
    captureStderr(() => {
      mergeConfigs([{ build: { dockerfile: 'Dockerfile' } }, { name: 'x' }]);
    }),
    [],
  );
});

Deno.test('an overlay refining the base build merges it rather than replacing', () => {
  assertEquals(
    mergeConfigs([
      { build: { dockerfile: 'Dockerfile', context: '.' } },
      { build: { args: { X: '1' } } },
    ]),
    { build: { dockerfile: 'Dockerfile', context: '.', args: { X: '1' } } },
  );
});

// ── purity ──────────────────────────────────────────────────────────────────────────────────

Deno.test('mergeConfigs never mutates the layers it is given', () => {
  const base = {
    mounts: ['type=bind,source=/a,target=/b'],
    remoteEnv: { A: '1' },
  };
  const overlay = {
    mounts: ['type=bind,source=/c,target=/b'],
    remoteEnv: { A: '2' },
  };
  const snapshots = [JSON.stringify(base), JSON.stringify(overlay)];
  mergeConfigs([base, overlay]);
  assertEquals(
    [JSON.stringify(base), JSON.stringify(overlay)],
    snapshots,
  );
});

Deno.test('an empty layer list, and layers that contribute nothing', () => {
  assertEquals(mergeConfigs([]), {});
  assertEquals(mergeConfigs([{}, {}, {}]), {});
  assertEquals(mergeConfigs([{ name: 'x' }, {}]), { name: 'x' });
});
