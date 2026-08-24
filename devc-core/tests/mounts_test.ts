import { assertEquals } from 'jsr:@std/assert@^1';
import { parseMounts } from '../container.ts';

Deno.test('parseMounts maps a bind mount to the ContainerMount shape', () => {
  const json = JSON.stringify([
    {
      Type: 'bind',
      Source: '/host/workspaces/some-tool',
      Destination: '/workspaces/some-tool',
      Mode: '',
      RW: true,
      Propagation: 'rprivate',
    },
  ]);
  assertEquals(parseMounts(json), [
    {
      type: 'bind',
      source: '/host/workspaces/some-tool',
      destination: '/workspaces/some-tool',
      rw: true,
    },
  ]);
});

Deno.test('parseMounts maps a volume mount and preserves rw=false', () => {
  const json = JSON.stringify([
    {
      Type: 'volume',
      Name: 'my-vol',
      Source: '/var/lib/docker/volumes/my-vol/_data',
      Destination: '/data',
      Driver: 'local',
      Mode: 'z',
      RW: false,
      Propagation: '',
    },
  ]);
  assertEquals(parseMounts(json), [
    {
      type: 'volume',
      source: '/var/lib/docker/volumes/my-vol/_data',
      destination: '/data',
      rw: false,
    },
  ]);
});

Deno.test('parseMounts handles a mix of bind and volume mounts', () => {
  const json = JSON.stringify([
    { Type: 'bind', Source: '/a', Destination: '/x', RW: true },
    {
      Type: 'volume',
      Source: '/var/lib/docker/volumes/v/_data',
      Destination: '/y',
      RW: true,
    },
  ]);
  assertEquals(parseMounts(json), [
    { type: 'bind', source: '/a', destination: '/x', rw: true },
    {
      type: 'volume',
      source: '/var/lib/docker/volumes/v/_data',
      destination: '/y',
      rw: true,
    },
  ]);
});

Deno.test('parseMounts returns [] for null input', () => {
  assertEquals(parseMounts(null), []);
});

Deno.test('parseMounts returns [] for empty-string input', () => {
  assertEquals(parseMounts(''), []);
});

Deno.test('parseMounts returns [] for the JSON literal null', () => {
  assertEquals(parseMounts('null'), []);
});

Deno.test('parseMounts returns [] for unparseable input', () => {
  assertEquals(parseMounts('not json'), []);
});
