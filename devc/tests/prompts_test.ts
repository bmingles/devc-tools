// The confirm primitive, driven headlessly: pure reducer transitions plus end-to-end runs over
// a scripted key stream (raw off, no TTY).

import { assert, assertEquals } from 'jsr:@std/assert@^1';
import {
  confirmLine,
  confirmReduce,
  confirmState,
  runConfirm,
} from '../tui/prompts.ts';
import { charKey, key } from '../tui/keys.ts';

Deno.test('confirmLine reflects the default', () => {
  assertEquals(confirmLine(confirmState('Apply?', true)), 'Apply? [Y/n] ');
  assertEquals(confirmLine(confirmState('Apply?', false)), 'Apply? [y/N] ');
});

Deno.test('reducer: y/n/enter/esc', () => {
  const s = confirmState('Apply?', true);
  assertEquals(confirmReduce(s, charKey('y')).answer, true);
  assertEquals(confirmReduce(s, charKey('N')).answer, false);
  assertEquals(confirmReduce(s, key('enter')).answer, true); // default
  assertEquals(
    confirmReduce(confirmState('Apply?', false), key('enter')).answer,
    false,
  );
  assertEquals(confirmReduce(s, key('escape')).answer, false);
  // unrelated characters are ignored (not done)
  assert(!confirmReduce(s, charKey('x')).done);
});

function streamOf(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(c) {
      c.enqueue(bytes);
      c.close();
    },
  });
}

function sink(): { stream: WritableStream<Uint8Array>; text: () => string } {
  const chunks: Uint8Array[] = [];
  const stream = new WritableStream<Uint8Array>({
    write(chunk) {
      chunks.push(chunk);
    },
  });
  return {
    stream,
    text: () => new TextDecoder().decode(concat(chunks)),
  };
}
function concat(chunks: Uint8Array[]): Uint8Array {
  const len = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

Deno.test("runConfirm: 'y' resolves true and echoes the prompt", async () => {
  const out = sink();
  const answer = await runConfirm('Apply?', false, {
    input: streamOf('y'),
    output: out.stream,
  });
  assertEquals(answer, true);
  assert(out.text().startsWith('Apply? [y/N] '));
  assert(out.text().includes('yes'));
});

Deno.test('runConfirm: Enter takes the default', async () => {
  const out = sink();
  assertEquals(
    await runConfirm('Apply?', true, {
      input: streamOf('\r'),
      output: out.stream,
    }),
    true,
  );
  const out2 = sink();
  assertEquals(
    await runConfirm('Apply?', false, {
      input: streamOf('\r'),
      output: out2.stream,
    }),
    false,
  );
});

Deno.test('runConfirm: Esc resolves false (cancel)', async () => {
  const out = sink();
  assertEquals(
    await runConfirm('Apply?', true, {
      input: streamOf('\x1b'),
      output: out.stream,
    }),
    false,
  );
});
