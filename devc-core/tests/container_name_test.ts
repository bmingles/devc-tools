import { assertEquals, assertMatch, assertNotEquals } from 'jsr:@std/assert@^1';
import { containerNameForLocalFolder } from '../container.ts';

Deno.test('containerNameForLocalFolder matches devc-<basename>-<hash>', async () => {
  const name = await containerNameForLocalFolder('/workspaces/some-tool');
  assertMatch(name, /^devc-some-tool-[0-9a-f]{8}$/);
});

Deno.test('containerNameForLocalFolder is deterministic', async () => {
  const a = await containerNameForLocalFolder('/workspaces/some-tool');
  const b = await containerNameForLocalFolder('/workspaces/some-tool');
  assertEquals(a, b);
});

Deno.test('containerNameForLocalFolder disambiguates folders with the same basename', async () => {
  const a = await containerNameForLocalFolder('/home/alice/some-tool');
  const b = await containerNameForLocalFolder('/home/bob/some-tool');
  assertNotEquals(a, b);
});

Deno.test('containerNameForLocalFolder falls back to workspace for an empty basename', async () => {
  const name = await containerNameForLocalFolder('/');
  assertMatch(name, /^devc-workspace-[0-9a-f]{8}$/);
});
