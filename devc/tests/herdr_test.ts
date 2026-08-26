import { assert, assertEquals } from 'jsr:@std/assert@^1';
import { fromFileUrl } from 'jsr:@std/path';
import {
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
