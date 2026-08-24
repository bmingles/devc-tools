// `createNodeDevcontainerRunner` and the `exec.ts` chunk callbacks it is built on.
//
// The point of the factory is a consumer that must not let the devcontainer CLI write to the
// terminal, but still wants its progress — minutes of it, on a cold build. So the two things
// worth asserting are that stderr genuinely arrives as chunks when `onStderr` is given, and that
// giving no options still produces the exact runner (`stderr: 'inherit'`) that shipped before the
// factory existed.
//
// These spawn the real `devcontainer.js` out of `node_modules`, which is what makes them a test
// of the runner rather than of a mock. They deliberately drive it into an argument error, which
// happens long before anything needs a Docker daemon.

import { assert, assertEquals } from 'jsr:@std/assert@^1';
import process from 'node:process';
import {
  createNodeDevcontainerRunner,
  devcontainerJsPath,
  nodeDevcontainerRunner,
} from '../devcontainer.ts';
import { output } from '../exec.ts';

const decoder = new TextDecoder();

Deno.test('devcontainerJsPath resolves to a real devcontainer.js', async () => {
  const path = devcontainerJsPath();
  assert(path.endsWith('/devcontainer.js'), path);
  // Exported precisely so a consumer never has to re-derive this through core's internals.
  assertEquals((await Deno.stat(path)).isFile, true);
});

Deno.test('createNodeDevcontainerRunner with onStderr receives the CLI stderr as chunks', async () => {
  const chunks: Uint8Array[] = [];
  const runner = createNodeDevcontainerRunner({
    onStderr: (chunk) => void chunks.push(chunk),
  });

  // An unknown subcommand: yargs writes its complaint to stderr and exits non-zero, with no
  // Docker involved.
  const { code } = await runner.run(['no-such-subcommand']);

  assertEquals(code === 0, false);
  assert(chunks.length > 0, 'onStderr never fired');
  const text = chunks.map((c) => decoder.decode(c)).join('');
  assert(text.length > 0, 'onStderr fired but delivered nothing');
});

Deno.test('createNodeDevcontainerRunner with no options still returns the CLI stdout', async () => {
  // No `onStderr` → `stderr: 'inherit'`, so the CLI's own diagnostics go to this process's
  // stderr exactly as they always have; what the runner *returns* is stdout, unchanged.
  const runner = createNodeDevcontainerRunner();
  const { code, stdout } = await runner.run(['--version']);
  assertEquals(code, 0);
  assert(/^\d+\.\d+\.\d+/.test(stdout.trim()), stdout);
});

Deno.test('nodeDevcontainerRunner is the no-options instance', async () => {
  const { code, stdout } = await nodeDevcontainerRunner.run(['--version']);
  assertEquals(code, 0);
  assert(/^\d+\.\d+\.\d+/.test(stdout.trim()), stdout);
});

Deno.test('output() tees piped chunks to onStdout/onStderr without disturbing collection', async () => {
  const out: Uint8Array[] = [];
  const err: Uint8Array[] = [];
  const result = await output(process.execPath, {
    args: [
      '-e',
      'process.stdout.write("to-stdout");process.stderr.write("to-stderr")',
    ],
    stdout: 'piped',
    stderr: 'piped',
    onStdout: (chunk) => void out.push(chunk),
    onStderr: (chunk) => void err.push(chunk),
  });

  assertEquals(result.code, 0);
  // A tee, not a replacement: the collected buffers are exactly what they would be without the
  // callbacks, and the callbacks saw the same bytes.
  assertEquals(decoder.decode(result.stdout), 'to-stdout');
  assertEquals(decoder.decode(result.stderr), 'to-stderr');
  assertEquals(out.map((c) => decoder.decode(c)).join(''), 'to-stdout');
  assertEquals(err.map((c) => decoder.decode(c)).join(''), 'to-stderr');
});

Deno.test('output() callbacks are inert for a stream that is not piped', async () => {
  let fired = false;
  const result = await output(process.execPath, {
    args: ['-e', 'process.stderr.write("discarded")'],
    stdout: 'piped',
    // `'null'` means the OS discards it — there is nothing for a callback to see, and this must
    // not be mistaken for "the child wrote nothing".
    stderr: 'null',
    onStderr: () => void (fired = true),
  });

  assertEquals(result.code, 0);
  assertEquals(fired, false);
});
