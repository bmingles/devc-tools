import { assertThrows } from 'jsr:@std/assert@^1';
import { assertLocalFolderExists } from '../container.ts';

Deno.test('assertLocalFolderExists throws for a nonexistent path', () => {
  assertThrows(
    () => assertLocalFolderExists('/no/such/dir/xyzzy'),
    Error,
    'no such directory',
  );
});

Deno.test('assertLocalFolderExists throws for a path that is a file, not a dir', () => {
  const file = Deno.makeTempFileSync();
  try {
    assertThrows(
      () => assertLocalFolderExists(file),
      Error,
      'not a directory',
    );
  } finally {
    Deno.removeSync(file);
  }
});

Deno.test('assertLocalFolderExists accepts an existing directory', () => {
  // Does not throw for a real directory.
  assertLocalFolderExists(Deno.cwd());
});
