import { assert, assertEquals } from 'jsr:@std/assert@^1';
import { fromFileUrl } from 'jsr:@std/path';
import {
  createSidecarRotator,
  debugLog,
  DEVC_HERDR_WATCH_ENV,
  HERDR_SIDECAR_SUBCOMMAND,
  herdrAgentKindFor,
  herdrMode,
  herdrWatcherScript,
  sidecarArgv,
} from '../herdr.ts';

// ---------------------------------------------------------------------------------------------
// herdrMode — the gate
// ---------------------------------------------------------------------------------------------

function env(
  vars: Record<string, string>,
): (key: string) => string | undefined {
  return (key) => vars[key];
}

Deno.test('herdrMode: off outside a Herdr pane', () => {
  assertEquals(herdrMode(env({})), { mode: 'off' });
  assertEquals(herdrMode(env({ HERDR_ENV: '0' })), { mode: 'off' });
});

Deno.test('herdrMode: off when HERDR_AGENT is already set — the undefined double-assertion case', () => {
  assertEquals(
    herdrMode(env({ HERDR_ENV: '1', HERDR_AGENT: 'claude' })),
    { mode: 'off' },
  );
});

Deno.test('herdrMode: off on the explicit opt-out', () => {
  assertEquals(
    herdrMode(env({ HERDR_ENV: '1', DEVC_HERDR_AGENT: 'off' })),
    { mode: 'off' },
  );
});

Deno.test('herdrMode: watch is the normal case', () => {
  assertEquals(herdrMode(env({ HERDR_ENV: '1' })), { mode: 'watch' });
});

Deno.test('herdrMode: pinned when DEVC_HERDR_AGENT names a kind', () => {
  assertEquals(
    herdrMode(env({ HERDR_ENV: '1', DEVC_HERDR_AGENT: 'codex' })),
    { mode: 'pinned', kind: 'codex' },
  );
});

// ---------------------------------------------------------------------------------------------
// herdrAgentKindFor — the mapping
// ---------------------------------------------------------------------------------------------

Deno.test('herdrAgentKindFor: a bare command matches its own basename', () => {
  assertEquals(herdrAgentKindFor('claude'), 'claude');
  assertEquals(herdrAgentKindFor('claude --resume'), 'claude');
});

Deno.test('herdrAgentKindFor: an interpreter re-takes the basename of its script', () => {
  assertEquals(
    herdrAgentKindFor('node /home/vscode/.local/bin/claude'),
    'claude',
  );
  assertEquals(herdrAgentKindFor('python3 -c import time'), null);
});

Deno.test('herdrAgentKindFor: gh copilot is a special case', () => {
  assertEquals(herdrAgentKindFor('gh copilot'), 'copilot');
});

Deno.test('herdrAgentKindFor: cursor-agent maps to the cursor kind', () => {
  assertEquals(herdrAgentKindFor('cursor-agent'), 'cursor');
});

Deno.test('herdrAgentKindFor: a kind whose manifest id differs from its command name', () => {
  assertEquals(herdrAgentKindFor('qoder'), 'qodercli');
  assertEquals(herdrAgentKindFor('antigravity'), 'agy');
});

Deno.test('herdrAgentKindFor: null for a shell, empty input, and an unlisted command', () => {
  assertEquals(herdrAgentKindFor('bash -l'), null);
  assertEquals(herdrAgentKindFor(''), null);
  assertEquals(herdrAgentKindFor('sleep 40'), null);
});

// ---------------------------------------------------------------------------------------------
// sidecarArgv — mirrors devcontainer_selfexec_test.ts's coverage of devcontainerArgv
// ---------------------------------------------------------------------------------------------

Deno.test('compiled: sidecarArgv is just the hidden subcommand', () => {
  assertEquals(
    sidecarArgv({
      execPath: '/home/me/.local/bin/devc',
      standalone: true,
      mainModule: 'file:///home/me/.local/bin/devc',
    }),
    [HERDR_SIDECAR_SUBCOMMAND],
  );
});

Deno.test('from source: sidecarArgv is a full `deno run` of main.ts', () => {
  const argv = sidecarArgv({
    execPath: '/usr/local/bin/deno',
    standalone: false,
    mainModule: 'file:///home/me/src/devc-tools/devc/main.ts',
  });
  assertEquals(argv, [
    'run',
    '--allow-env',
    '/home/me/src/devc-tools/devc/main.ts',
    HERDR_SIDECAR_SUBCOMMAND,
  ]);
});

// The one flag whose absence turns the sidecar into an instant crash nothing else would notice,
// since the child's own output is discarded — see `sidecarArgv`'s doc comment.
Deno.test('from source: dropping --allow-env is caught here', () => {
  const argv = sidecarArgv({
    execPath: '/usr/local/bin/deno',
    standalone: false,
    mainModule: 'file:///home/me/src/devc-tools/devc/main.ts',
  });
  assert(argv.includes('--allow-env'), 'sidecarArgv must include --allow-env');
});

// ---------------------------------------------------------------------------------------------
// herdrWatcherScript — the id is interpolated, nothing else
// ---------------------------------------------------------------------------------------------

Deno.test('herdrWatcherScript: the marker and both self-termination arms are present', () => {
  const id = crypto.randomUUID();
  const script = herdrWatcherScript(id);
  assert(
    script.includes(`${DEVC_HERDR_WATCH_ENV}=${id}`),
    'script must contain the marker key=id pattern',
  );
  assertEquals(
    script.split('exit 0').length - 1,
    2,
    'both exit 0 arms must be present',
  );
});

Deno.test('herdrWatcherScript: two different ids produce two different scripts', () => {
  const a = herdrWatcherScript('aaaa');
  const b = herdrWatcherScript('bbbb');
  assert(a !== b);
  assert(a.includes('aaaa') && !a.includes('bbbb'));
});

// ---------------------------------------------------------------------------------------------
// createSidecarRotator — kill-before-spawn, never overlapping
// ---------------------------------------------------------------------------------------------

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Regression test for the actual bug: an earlier version spawned the new sidecar immediately and
// killed the old one in the background, so for a window both processes asserted a different
// HERDR_AGENT in the same process group — the "undefined, resolves unpredictably" case the plan
// measured. A slow `kill` here (deliberately, via the delay) would let a spawn slip in front of
// it if the rotator raced them; it must not.
Deno.test('createSidecarRotator: the previous child is fully killed before the next spawns', async () => {
  const events: string[] = [];
  const rotator = createSidecarRotator<string>(
    (kind) => {
      events.push(`spawn ${kind}`);
      return kind;
    },
    async (child) => {
      events.push(`kill:start ${child}`);
      await delay(10);
      events.push(`kill:done ${child}`);
    },
  );

  rotator.setKind('claude');
  rotator.setKind('copilot');
  await delay(50);

  assertEquals(events, [
    'spawn claude',
    'kill:start claude',
    'kill:done claude',
    'spawn copilot',
  ]);
});

Deno.test('createSidecarRotator: null kills the current child and spawns nothing', async () => {
  const events: string[] = [];
  const rotator = createSidecarRotator<string>(
    (kind) => {
      events.push(`spawn ${kind}`);
      return kind;
    },
    async (child) => {
      events.push(`kill ${child}`);
    },
  );

  rotator.setKind('claude');
  rotator.setKind(null);
  await delay(20);

  assertEquals(events, ['spawn claude', 'kill claude']);
  assertEquals(rotator.current(), null);
});

Deno.test('createSidecarRotator: repeating the current kind is a no-op', async () => {
  const events: string[] = [];
  const rotator = createSidecarRotator<string>(
    (kind) => {
      events.push(`spawn ${kind}`);
      return kind;
    },
    async () => {
      events.push('kill');
    },
  );

  rotator.setKind('claude');
  rotator.setKind('claude');
  await delay(20);

  assertEquals(events, ['spawn claude']);
});

Deno.test('createSidecarRotator: stop() kills the current live child', async () => {
  const events: string[] = [];
  const rotator = createSidecarRotator<string>(
    (kind) => {
      events.push(`spawn ${kind}`);
      return kind;
    },
    async (child) => {
      events.push(`kill ${child}`);
    },
  );

  rotator.setKind('claude');
  await delay(10); // let the spawn actually happen before tearing down
  await rotator.stop();

  assertEquals(events, ['spawn claude', 'kill claude']);
  assertEquals(rotator.current(), null);
});

// stop() sets its internal `stopped` flag before awaiting any in-flight transition, so a spawn
// still queued behind a kill at that exact moment is suppressed rather than raced — no pointless
// spawn-immediately-followed-by-kill right at teardown, and nothing left running either.
Deno.test('createSidecarRotator: stop() called immediately after setKind suppresses the spawn, not just races it', async () => {
  const events: string[] = [];
  const rotator = createSidecarRotator<string>(
    (kind) => {
      events.push(`spawn ${kind}`);
      return kind;
    },
    async (child) => {
      events.push(`kill ${child}`);
    },
  );

  rotator.setKind('claude');
  await rotator.stop(); // no delay — stop() races the very first transition

  assertEquals(events, []);
  assertEquals(rotator.current(), null);
});

// ---------------------------------------------------------------------------------------------
// The sidecar body — provable without Docker
// ---------------------------------------------------------------------------------------------

Deno.test('the sidecar body exits 0 immediately on EOF', async () => {
  const { code, stderr } = await new Deno.Command(Deno.execPath(), {
    args: [
      'run',
      '--no-prompt',
      '--allow-env',
      fromFileUrl(import.meta.resolve('../main.ts')),
      HERDR_SIDECAR_SUBCOMMAND,
    ],
    stdin: 'null', // closed stdin is EOF from the first read
    stdout: 'null',
    stderr: 'piped',
  }).output();

  assertEquals(code, 0, `exited ${code}: ${new TextDecoder().decode(stderr)}`);
});

// ---------------------------------------------------------------------------------------------
// debugLog — opt-in diagnostics, a file only, never touched when unset
// ---------------------------------------------------------------------------------------------

Deno.test('debugLog: a no-op when DEVC_HERDR_WATCH_DEBUG is unset', () => {
  const before = Deno.env.get('DEVC_HERDR_WATCH_DEBUG');
  Deno.env.delete('DEVC_HERDR_WATCH_DEBUG');
  try {
    // Must not throw, and there is nothing to assert on disk — no path was even named.
    debugLog('should go nowhere');
  } finally {
    if (before !== undefined) Deno.env.set('DEVC_HERDR_WATCH_DEBUG', before);
  }
});

Deno.test('debugLog: appends a timestamped line to the named file when set', async () => {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/herdr-debug.log`;
  const before = Deno.env.get('DEVC_HERDR_WATCH_DEBUG');
  Deno.env.set('DEVC_HERDR_WATCH_DEBUG', path);
  try {
    debugLog('first');
    debugLog('second');
    const contents = await Deno.readTextFile(path);
    const lines = contents.trim().split('\n');
    assertEquals(lines.length, 2, 'both calls must append, not overwrite');
    assert(lines[0].endsWith('first'));
    assert(lines[1].endsWith('second'));
    // ISO timestamp prefix on each line
    assert(/^\d{4}-\d{2}-\d{2}T/.test(lines[0]));
  } finally {
    if (before === undefined) {
      Deno.env.delete('DEVC_HERDR_WATCH_DEBUG');
    } else {
      Deno.env.set('DEVC_HERDR_WATCH_DEBUG', before);
    }
    await Deno.remove(dir, { recursive: true });
  }
});
