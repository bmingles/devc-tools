// `selectContainer` — which container wins when more than one carries the same
// `devcontainer.local_folder`. That state is reachable whenever a workspace's config
// path changes (see the function's own doc comment), so the tie-break is a contract,
// not an accident of `docker ps` row order.

import { assertEquals } from 'jsr:@std/assert';
import { type ContainerRow, selectContainer } from '../container.ts';

const row = (
  id: string,
  labelPath: string,
  state = 'running',
): ContainerRow => ({ id, labelPath, state });

Deno.test('selectContainer returns null when nothing matches', () => {
  assertEquals(selectContainer([], '/w/proj'), null);
  assertEquals(
    selectContainer([row('a', '/w/other')], '/w/proj'),
    null,
  );
});

Deno.test('selectContainer ignores rows for other workspaces', () => {
  assertEquals(
    selectContainer(
      [row('a', '/w/other'), row('b', '/w/proj'), row('c', '/w/third')],
      '/w/proj',
    ),
    { id: 'b', state: 'running' },
  );
});

Deno.test('selectContainer matches through normalizePath', () => {
  // normalizePath folds backslashes to forward slashes and the comparison is
  // case-insensitive. It does *not* strip a trailing slash — asserted here so the
  // limit is written down rather than assumed.
  assertEquals(
    selectContainer([row('a', '\\w\\proj')], '/w/proj'),
    { id: 'a', state: 'running' },
  );
  assertEquals(
    selectContainer([row('a', '/W/Proj')], '/w/proj'),
    { id: 'a', state: 'running' },
  );
  assertEquals(selectContainer([row('a', '/w/proj/')], '/w/proj'), null);
});

Deno.test('selectContainer takes the newest of two running duplicates', () => {
  // `docker ps` lists newest-created first, so the head of the list is the container
  // the most recent `up` produced.
  assertEquals(
    selectContainer(
      [row('new', '/w/proj'), row('stale', '/w/proj')],
      '/w/proj',
    ),
    { id: 'new', state: 'running' },
  );
});

Deno.test('selectContainer prefers a running duplicate over a newer stopped one', () => {
  assertEquals(
    selectContainer(
      [row('newer', '/w/proj', 'exited'), row('older', '/w/proj', 'running')],
      '/w/proj',
    ),
    { id: 'older', state: 'running' },
  );
});

Deno.test('selectContainer falls back to the newest when none is running', () => {
  assertEquals(
    selectContainer(
      [row('newer', '/w/proj', 'exited'), row('older', '/w/proj', 'created')],
      '/w/proj',
    ),
    { id: 'newer', state: 'exited' },
  );
});

Deno.test('selectContainer keeps the single-match behaviour unchanged', () => {
  assertEquals(
    selectContainer([row('only', '/w/proj', 'exited')], '/w/proj'),
    { id: 'only', state: 'exited' },
  );
});

// `renameConflictWarning` — the two shapes of the name-conflict warning. The
// same-workspace shape exists because the cross-workspace wording ("re-run once it's
// gone") is actively wrong for a stale duplicate that nothing will ever remove.

import { renameConflictWarning } from '../container.ts';

const conflict = {
  containerId: 'c0ffee',
  conflictId: 'deadbe',
  desiredName: 'devc-proj-1234abcd',
  localFolder: '/w/proj',
};

Deno.test('renameConflictWarning: a different workspace is a transient collision', () => {
  const msg = renameConflictWarning({
    ...conflict,
    otherLocalFolder: '/w/other',
  });
  assertEquals(msg.includes('could not rename'), true);
  assertEquals(msg.includes('/w/other'), true);
  assertEquals(msg.includes('this is transient'), true);
  // The removal command belongs only to the same-workspace shape: telling someone to
  // `docker rm -f` a container that belongs to a *different* workspace is bad advice.
  assertEquals(msg.includes('docker rm -f'), false);
});

Deno.test('renameConflictWarning: the same workspace names the removal command', () => {
  const msg = renameConflictWarning({
    ...conflict,
    otherLocalFolder: '/w/proj',
  });
  assertEquals(msg.includes('two containers exist'), true);
  assertEquals(msg.includes('docker rm -f deadbe'), true);
  // The wording that would send the user to wait for something that never happens.
  assertEquals(msg.includes('transient'), false);
  assertEquals(msg.includes('devc attach'), false);
});

Deno.test('renameConflictWarning: same workspace is matched through normalizePath', () => {
  const msg = renameConflictWarning({
    ...conflict,
    otherLocalFolder: '\\w\\PROJ',
  });
  assertEquals(msg.includes('two containers exist'), true);
});

Deno.test('renameConflictWarning: an unknown workspace takes the transient shape', () => {
  // `docker inspect` returning null must not be mistaken for "same workspace".
  const msg = renameConflictWarning({ ...conflict, otherLocalFolder: null });
  assertEquals(msg.includes('workspace: unknown'), true);
  assertEquals(msg.includes('docker rm -f'), false);
});
