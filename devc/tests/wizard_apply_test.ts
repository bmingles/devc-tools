import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert@^1';
import {
  applyFences,
  applySelection,
  type WizardSelection,
} from '../wizard_apply.ts';
import { findArraySpan, parseFenceEntries, parseJsonc } from '../jsonc_edit.ts';
import { parseEntries } from '../mounts.ts';
import {
  loadGlobalConfig,
  makeGlobalConfig,
  saveGlobalConfig,
} from '../config.ts';
import { withTemp } from './helpers.ts';

const SEL: WizardSelection = {
  source: [{
    source: '${localEnv:HOME}/code/p',
    target: '/workspaces/p',
    readonly: false,
  }],
  skills: [{
    source: '/srv/skills/agent',
    target: '/home/vscode/.claude/skills/agent',
    readonly: true,
  }],
};

/** Read the source/skills fence rows back out of a written config. */
function fenceRows(text: string) {
  const span = findArraySpan(text, 'mounts')!;
  return {
    source: parseEntries(parseFenceEntries(text, span, 'source')),
    skills: parseEntries(parseFenceEntries(text, span, 'skills')),
  };
}

Deno.test('first creation: populated fences, infra intact, Dockerfile + entry scripts + scripts/ copied', async () => {
  await withTemp(async (dir) => {
    const cfgPath = `${dir}/config.json`;
    const result = await applySelection(dir, SEL, {
      globalConfigPath: cfgPath,
    });
    assert(result.created);

    const text = await Deno.readTextFile(
      `${dir}/.devcontainer/devcontainer.json`,
    );
    // Both fences present and populated.
    assertStringIncludes(text, 'devc:source');
    assertStringIncludes(text, 'devc:skills');
    const rows = fenceRows(text);
    assertEquals(rows.source, SEL.source);
    assertEquals(rows.skills, SEL.skills);

    // Infra mounts from the bundled default survive untouched.
    const parsed = parseJsonc(text) as { mounts: string[] };
    assert(
      parsed.mounts.some((m) => m.includes('claude-code-config-')),
      'claude-config volume mount missing',
    );
    assert(
      parsed.mounts.some((m) =>
        m.includes('target=/usr/local/share/devc/claude-seed')
      ),
      '~/.claude seed bind missing',
    );

    // No local Feature; the baseline runs via a top-level postCreateCommand.
    const dc = parseJsonc(text) as {
      features?: Record<string, unknown>;
      postCreateCommand?: unknown;
      initializeCommand?: unknown;
    };
    assertEquals(
      Object.hasOwn(dc.features ?? {}, './features/devc'),
      false,
    );
    // Project mode references the copies in the project's own .devcontainer/, so edits
    // apply on recreate (the zero-config cache rewrites these to baked/cache paths).
    assertEquals(
      dc.postCreateCommand,
      'bash "${containerWorkspaceFolder}/.devcontainer/post-create.sh"',
    );
    assertEquals(
      dc.initializeCommand,
      'bash "${localWorkspaceFolder}/.devcontainer/initialize-command.sh"',
    );

    // Bundled assets copied and made executable: Dockerfile + the two root entry scripts +
    // the factored scripts/ delegates; no features/ dir and no post-create.user.sh.
    assert((await Deno.stat(`${dir}/.devcontainer/Dockerfile`)).isFile);
    for (
      const rel of [
        'post-create.sh',
        'initialize-command.sh',
        'scripts/agents-setup.sh',
        'scripts/node-setup.sh',
        'scripts/bashrc-additions.sh',
      ]
    ) {
      const st = await Deno.stat(`${dir}/.devcontainer/${rel}`);
      assert(st.isFile, `${rel} missing`);
      assertEquals(st.mode! & 0o111, 0o111, `${rel} not executable`);
    }
    for (const gone of ['features', 'post-create.user.sh']) {
      assertEquals(
        await Deno.stat(`${dir}/.devcontainer/${gone}`).then(() => true).catch(
          () => false,
        ),
        false,
        `${gone} should not exist`,
      );
    }

    // recentSkills persisted (raw host paths).
    const cfg = await loadGlobalConfig(cfgPath);
    assertEquals(cfg.recentSkills, ['/srv/skills/agent']);
  });
});

Deno.test('idempotence: applying the same selection twice is byte-identical', async () => {
  await withTemp(async (dir) => {
    const cfgPath = `${dir}/config.json`;
    await applySelection(dir, SEL, { globalConfigPath: cfgPath });
    const first = await Deno.readTextFile(
      `${dir}/.devcontainer/devcontainer.json`,
    );
    const result2 = await applySelection(dir, SEL, {
      globalConfigPath: cfgPath,
    });
    assert(!result2.created, 'second apply must be an update');
    const second = await Deno.readTextFile(
      `${dir}/.devcontainer/devcontainer.json`,
    );
    assertEquals(second, first);
  });
});

Deno.test('update preserves a hand-added mount + comment; infra removed by hand stays gone', async () => {
  await withTemp(async (dir) => {
    const cfgPath = `${dir}/config.json`;
    await applySelection(dir, SEL, { globalConfigPath: cfgPath });
    const path = `${dir}/.devcontainer/devcontainer.json`;

    // Hand-edit outside the fences: add a comment + mount, and delete an infra mount.
    let text = await Deno.readTextFile(path);
    text = text.replace(
      /"mounts": \[/,
      '"mounts": [\n    // my own mount\n    "type=bind,source=/host/mine,target=/mnt/mine",',
    );
    // Remove the go-cache infra mount line entirely.
    text = text.split('\n').filter((l) => !l.includes('go-cache-')).join('\n');
    await Deno.writeTextFile(path, text);
    const handEdited = await Deno.readTextFile(path);

    // Reconfigure: recover the selection from the fences, apply again.
    const recovered = fenceRows(handEdited);
    await applySelection(dir, recovered, { globalConfigPath: cfgPath });
    const after = await Deno.readTextFile(path);

    // The hand comment and mount survive byte-for-byte.
    assertStringIncludes(after, '    // my own mount\n');
    assertStringIncludes(
      after,
      '"type=bind,source=/host/mine,target=/mnt/mine"',
    );
    // The removed infra mount is NOT re-asserted.
    assert(!after.includes('go-cache-'), 'infra mount was wrongly re-asserted');
    // Fence contents are unchanged from what we recovered.
    assertEquals(fenceRows(after), recovered);
  });
});

Deno.test('applyFences inserts fences into a config that lacks them (no Dockerfile/features)', () => {
  const src =
    '{\n  "name": "x",\n  "mounts": [\n    "type=bind,source=/a,target=/b"\n  ]\n}\n';
  const out = applyFences(src, SEL);
  assertStringIncludes(out, 'devc:source');
  assertStringIncludes(out, 'devc:skills');
  const parsed = parseJsonc(out) as { mounts: string[]; name: string };
  assertEquals(parsed.name, 'x');
  assert(parsed.mounts.includes('type=bind,source=/a,target=/b'));
});

Deno.test("remembered list seeds a fresh project's skills (existing host paths only)", async () => {
  await withTemp(async (dir) => {
    const cfgPath = `${dir}/config.json`;
    // Project 1 applies skills A and B, persisting them to recentSkills.
    const a = `${dir}/skillA`;
    const b = `${dir}/skillB`;
    await Deno.mkdir(a);
    await Deno.mkdir(b);
    const sel: WizardSelection = {
      source: [],
      skills: [
        {
          source: a,
          target: '/home/vscode/.claude/skills/skillA',
          readonly: true,
        },
        {
          source: b,
          target: '/home/vscode/.claude/skills/skillB',
          readonly: true,
        },
      ],
    };
    await applySelection(`${dir}/proj1`, sel, { globalConfigPath: cfgPath });
    const cfg = await loadGlobalConfig(cfgPath);
    assertEquals(cfg.recentSkills, [a, b]);

    // Now remove skillB's host dir; only A should still exist for the seed filter.
    await Deno.remove(b, { recursive: true });
    const existing = [];
    for (const p of cfg.recentSkills) {
      try {
        await Deno.stat(p);
        existing.push(p);
      } catch {
        // dropped
      }
    }
    assertEquals(existing, [a]);
  });
});

Deno.test('saveGlobalConfig round-trips recentSkills and preserves unknown keys', async () => {
  await withTemp(async (dir) => {
    const path = `${dir}/config.json`;
    const cfg = makeGlobalConfig(['~/code'], ['~/skills'], path, { misc: 1 }, [
      '~/skills/x',
    ]);
    await saveGlobalConfig(cfg);
    const loaded = await loadGlobalConfig(path);
    assertEquals(loaded.recentSkills, ['~/skills/x']);
    assertEquals(loaded.codeRoots, ['~/code']);
    assertEquals(loaded.extra, { misc: 1 });
  });
});

Deno.test('changed: true on creation, false when the selection round-trips identically', async () => {
  await withTemp(async (dir) => {
    const cfgPath = `${dir}/config.json`;
    const first = await applySelection(dir, SEL, { globalConfigPath: cfgPath });
    assert(first.created);
    assert(first.changed, 'first creation must count as a change');

    const path = `${dir}/.devcontainer/devcontainer.json`;
    const before = await Deno.readTextFile(path);
    const beforeMtime = (await Deno.stat(path)).mtime;

    // Re-applying the same rows produces the same bytes: no change, and no write at all.
    const again = await applySelection(dir, SEL, { globalConfigPath: cfgPath });
    assert(!again.created);
    assertEquals(again.changed, false);
    assertEquals(await Deno.readTextFile(path), before);
    assertEquals(
      (await Deno.stat(path)).mtime?.getTime(),
      beforeMtime?.getTime(),
    );
  });
});

Deno.test('changed: true when the selection differs from what is on disk', async () => {
  await withTemp(async (dir) => {
    const cfgPath = `${dir}/config.json`;
    await applySelection(dir, SEL, { globalConfigPath: cfgPath });

    const edited: WizardSelection = {
      source: SEL.source,
      skills: [], // drop the skills mount
    };
    const result = await applySelection(dir, edited, {
      globalConfigPath: cfgPath,
    });
    assert(result.changed, 'dropping a mount must count as a change');
    const rows = fenceRows(
      await Deno.readTextFile(`${dir}/.devcontainer/devcontainer.json`),
    );
    assertEquals(rows.skills, []);
  });
});

Deno.test('changed: false leaves the fences and a toggled-and-restored row intact', async () => {
  await withTemp(async (dir) => {
    const cfgPath = `${dir}/config.json`;
    await applySelection(dir, SEL, { globalConfigPath: cfgPath });
    const path = `${dir}/.devcontainer/devcontainer.json`;

    // Toggle the skills mount off, then back on — the end state matches the start state, so
    // the second apply reports no change even though the user did touch the selection.
    await applySelection(dir, { source: SEL.source, skills: [] }, {
      globalConfigPath: cfgPath,
    });
    const restored = await applySelection(dir, SEL, {
      globalConfigPath: cfgPath,
    });
    assert(restored.changed, 'restoring the row is itself a change from disk');

    const noop = await applySelection(dir, SEL, { globalConfigPath: cfgPath });
    assertEquals(noop.changed, false);
    assertEquals(fenceRows(await Deno.readTextFile(path)).skills, SEL.skills);
  });
});

// ── user template layer ─────────────────────────────────────────────────────────────────────

// A user template `devcontainer.json` becomes the base text the fences are inserted into. It need
// not have a `mounts` array at all — `writeBlocks` calls `ensureArray` — so a minimal template
// must still get both fences.
Deno.test('first creation from a template devcontainer.json with no mounts array', async () => {
  await withTemp(async (dir) => {
    const templates = `${dir}/templates`;
    await Deno.mkdir(templates, { recursive: true });
    await Deno.writeTextFile(
      `${templates}/devcontainer.json`,
      '{\n  "name": "mine",\n  "image": "mcr.microsoft.com/devcontainers/base:bookworm"\n}\n',
    );

    const project = `${dir}/project`;
    await Deno.mkdir(project);
    const result = await applySelection(project, SEL, {
      globalConfigPath: `${dir}/config.json`,
      templatesDir: templates,
    });
    assert(result.created);

    const text = await Deno.readTextFile(result.configPath);
    // The template's own keys survived...
    const parsed = parseJsonc(text) as { name: string; mounts: string[] };
    assertEquals(parsed.name, 'mine');
    // ...the mounts array was created, and holds only what the wizard put there.
    const rows = fenceRows(text);
    assertEquals(rows.source, SEL.source);
    assertEquals(rows.skills, SEL.skills);
    assertEquals(parsed.mounts.length, 2);
  });
});

Deno.test('first creation overlays a template Dockerfile onto the copied assets', async () => {
  await withTemp(async (dir) => {
    const templates = `${dir}/templates`;
    await Deno.mkdir(templates, { recursive: true });
    await Deno.writeTextFile(`${templates}/Dockerfile`, 'FROM scratch\n');

    const project = `${dir}/project`;
    await Deno.mkdir(project);
    await applySelection(project, SEL, {
      globalConfigPath: `${dir}/config.json`,
      templatesDir: templates,
    });

    assertEquals(
      await Deno.readTextFile(`${project}/.devcontainer/Dockerfile`),
      'FROM scratch\n',
    );
  });
});
