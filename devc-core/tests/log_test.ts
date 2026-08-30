// The logger seam. Two things have to hold and they pull in opposite directions:
//
// - with no logger set, core writes exactly what it always wrote, to exactly the stream it always
//   wrote to — `notice` on stdout, `warning` on stderr. That split is `devc`'s CLI behavior, and
//   collapsing it would be a silent regression in a shell pipeline;
// - with a logger set, every line arrives as a value and **nothing** reaches the console, because
//   a consumer holding the terminal cannot survive a stray `console.log`.

import { assert, assertEquals } from 'jsr:@std/assert@^1';
import { logNotice, logWarning, setLogger } from '../log.ts';
import { loadOverlayFile } from '../overlay.ts';
import { materializeDefaultConfig } from '../default_config.ts';

/** Everything `console.log` / `console.error` received while `fn` ran, tagged by stream. */
async function withConsoleCaptured(
  fn: () => void | Promise<void>,
): Promise<Array<[stream: 'log' | 'error', text: string]>> {
  const seen: Array<['log' | 'error', string]> = [];
  const realLog = console.log;
  const realError = console.error;
  console.log = (...args: unknown[]) => void seen.push(['log', args.join(' ')]);
  console.error = (...args: unknown[]) =>
    void seen.push(['error', args.join(' ')]);
  try {
    await fn();
  } finally {
    console.log = realLog;
    console.error = realError;
  }
  return seen;
}

async function withTempDir(fn: (tmp: string) => Promise<void>) {
  const tmp = await Deno.makeTempDir({ prefix: 'devc-log-test-' });
  try {
    await fn(await Deno.realPath(tmp));
  } finally {
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
  }
}

Deno.test('the default sink puts notices on stdout and warnings on stderr', async () => {
  const seen = await withConsoleCaptured(() => {
    logNotice('a notice');
    logWarning('a warning');
  });
  assertEquals(seen, [['log', 'a notice'], ['error', 'a warning']]);
});

Deno.test('setLogger captures every level and lets nothing reach the console', async () => {
  const lines: Array<[string, string]> = [];
  const seen = await withConsoleCaptured(() => {
    setLogger((level, message) => void lines.push([level, message]));
    try {
      logNotice('a notice');
      logWarning('a warning');
    } finally {
      setLogger(null);
    }
  });

  assertEquals(lines, [['notice', 'a notice'], ['warning', 'a warning']]);
  assertEquals(seen, []);
});

Deno.test('setLogger(null) restores the console default', async () => {
  const seen = await withConsoleCaptured(() => {
    setLogger(() => {});
    setLogger(null);
    logWarning('back on stderr');
  });
  assertEquals(seen, [['error', 'back on stderr']]);
});

Deno.test('a real call site — an unknown overlay key — reaches the logger, not the console', async () => {
  await withTempDir(async (tmp) => {
    const path = `${tmp}/devc.json`;
    await Deno.writeTextFile(path, '{ "mounts": [], "nonsense": 1 }');

    const lines: Array<[string, string]> = [];
    const seen = await withConsoleCaptured(async () => {
      setLogger((level, message) => void lines.push([level, message]));
      try {
        await loadOverlayFile(path);
      } finally {
        setLogger(null);
      }
    });

    assertEquals(seen, []);
    assertEquals(lines.length, 1);
    assertEquals(lines[0][0], 'warning');
    assert(lines[0][1].includes('unknown key "nonsense"'), lines[0][1]);
  });
});

Deno.test('a real call site — a templates devc.json — reaches the logger, not the console', async () => {
  await withTempDir(async (tmp) => {
    // The other module's warning site, so this is not just `overlay.ts` being wired up.
    const templates = `${tmp}/templates`;
    await Deno.mkdir(templates, { recursive: true });
    await Deno.writeTextFile(`${templates}/devc.json`, '{}');

    const lines: Array<[string, string]> = [];
    const seen = await withConsoleCaptured(async () => {
      setLogger((level, message) => void lines.push([level, message]));
      try {
        await materializeDefaultConfig(`${tmp}/cache`, templates);
      } finally {
        setLogger(null);
      }
    });

    assertEquals(seen, []);
    assertEquals(lines.length, 1);
    assertEquals(lines[0][0], 'warning');
    assert(lines[0][1].includes('ignoring'), lines[0][1]);
    assert(lines[0][1].includes('devc.json'), lines[0][1]);
  });
});
