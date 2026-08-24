// The pure posix-path helpers in `posix.ts`. `commonAncestorPosix`/`relativeUnderPosix` back the
// worktree mount base, where a wrong answer becomes a silently misplaced bind mount — including the
// `/` base, which a naive `base + "/"` prefix would never match.

import { assertEquals } from 'jsr:@std/assert@^1';
import { commonAncestorPosix, relativeUnderPosix } from '../posix.ts';

Deno.test('commonAncestorPosix returns the deepest shared directory', () => {
  assertEquals(
    commonAncestorPosix(
      '/home/me/code/iris.worktrees/f1',
      '/home/me/code/iris',
    ),
    '/home/me/code',
  );
  // Sibling-name prefixes must not fool it: "iris" is not an ancestor of "iris.worktrees".
  assertEquals(
    commonAncestorPosix('/a/iris.worktrees/f1', '/a/iris'),
    '/a',
  );
});

Deno.test('commonAncestorPosix: one path containing the other returns that path', () => {
  assertEquals(
    commonAncestorPosix('/srv/iris/wt/f1', '/srv/iris'),
    '/srv/iris',
  );
  assertEquals(commonAncestorPosix('/srv/iris', '/srv/iris'), '/srv/iris');
});

Deno.test('commonAncestorPosix: disjoint absolute paths share only the root', () => {
  assertEquals(commonAncestorPosix('/srv/wt/f1', '/home/me/iris'), '/');
});

Deno.test('relativeUnderPosix returns the sub-path, or null when not under', () => {
  assertEquals(relativeUnderPosix('/home/me', '/home/me/code/a'), 'code/a');
  assertEquals(
    relativeUnderPosix('/home/me', '/home/me'),
    null,
    'equal is not under',
  );
  assertEquals(
    relativeUnderPosix('/home/me', '/home/meta'),
    null,
    'prefix is not ancestry',
  );
  assertEquals(relativeUnderPosix('/home/me', '/srv/x'), null);
  assertEquals(
    relativeUnderPosix('', '/home/me'),
    null,
    'no base ⇒ nothing to mirror',
  );
});

Deno.test('relativeUnderPosix handles a base of /', () => {
  assertEquals(relativeUnderPosix('/', '/srv/proj'), 'srv/proj');
  assertEquals(relativeUnderPosix('/', '/'), null);
});
