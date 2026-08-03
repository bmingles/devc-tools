import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@^1";
import {
  applyFences,
  applySelection,
  type WizardSelection,
} from "../wizard_apply.ts";
import { findArraySpan, parseFenceEntries, parseJsonc } from "../jsonc_edit.ts";
import { parseEntries } from "../mounts.ts";
import {
  loadGlobalConfig,
  makeGlobalConfig,
  saveGlobalConfig,
} from "../config.ts";
import { withTemp } from "./helpers.ts";

const SEL: WizardSelection = {
  source: [{
    source: "${localEnv:HOME}/code/p",
    target: "/workspaces/p",
    readonly: false,
  }],
  skills: [{
    source: "/srv/skills/agent",
    target: "/home/vscode/.claude/skills/agent",
    readonly: true,
  }],
};

/** Read the source/skills fence rows back out of a written config. */
function fenceRows(text: string) {
  const span = findArraySpan(text, "mounts")!;
  return {
    source: parseEntries(parseFenceEntries(text, span, "source")),
    skills: parseEntries(parseFenceEntries(text, span, "skills")),
  };
}

Deno.test("first creation: populated fences, infra intact, Dockerfile + features copied", async () => {
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
    assertStringIncludes(text, "devc:source");
    assertStringIncludes(text, "devc:skills");
    const rows = fenceRows(text);
    assertEquals(rows.source, SEL.source);
    assertEquals(rows.skills, SEL.skills);

    // Infra mounts from the bundled default survive untouched.
    const parsed = parseJsonc(text) as { mounts: string[] };
    assert(
      parsed.mounts.some((m) => m.includes("claude-code-config-")),
      "claude-config volume mount missing",
    );
    assert(
      parsed.mounts.some((m) => m.includes("/home/vscode/.claude/CLAUDE.md")),
      "CLAUDE.md bind missing",
    );

    // Dockerfile + features subtree copied.
    assert((await Deno.stat(`${dir}/.devcontainer/Dockerfile`)).isFile);
    assert((await Deno.stat(`${dir}/.devcontainer/features/devc`)).isDirectory);
    assert(
      (await Deno.stat(`${dir}/.devcontainer/features/devc/install.sh`)).isFile,
    );

    // recentSkills persisted (raw host paths).
    const cfg = await loadGlobalConfig(cfgPath);
    assertEquals(cfg.recentSkills, ["/srv/skills/agent"]);
  });
});

Deno.test("idempotence: applying the same selection twice is byte-identical", async () => {
  await withTemp(async (dir) => {
    const cfgPath = `${dir}/config.json`;
    await applySelection(dir, SEL, { globalConfigPath: cfgPath });
    const first = await Deno.readTextFile(
      `${dir}/.devcontainer/devcontainer.json`,
    );
    const result2 = await applySelection(dir, SEL, {
      globalConfigPath: cfgPath,
    });
    assert(!result2.created, "second apply must be an update");
    const second = await Deno.readTextFile(
      `${dir}/.devcontainer/devcontainer.json`,
    );
    assertEquals(second, first);
  });
});

Deno.test("update preserves a hand-added mount + comment; infra removed by hand stays gone", async () => {
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
    text = text.split("\n").filter((l) => !l.includes("go-cache-")).join("\n");
    await Deno.writeTextFile(path, text);
    const handEdited = await Deno.readTextFile(path);

    // Reconfigure: recover the selection from the fences, apply again.
    const recovered = fenceRows(handEdited);
    await applySelection(dir, recovered, { globalConfigPath: cfgPath });
    const after = await Deno.readTextFile(path);

    // The hand comment and mount survive byte-for-byte.
    assertStringIncludes(after, "    // my own mount\n");
    assertStringIncludes(
      after,
      '"type=bind,source=/host/mine,target=/mnt/mine"',
    );
    // The removed infra mount is NOT re-asserted.
    assert(!after.includes("go-cache-"), "infra mount was wrongly re-asserted");
    // Fence contents are unchanged from what we recovered.
    assertEquals(fenceRows(after), recovered);
  });
});

Deno.test("applyFences inserts fences into a config that lacks them (no Dockerfile/features)", () => {
  const src =
    '{\n  "name": "x",\n  "mounts": [\n    "type=bind,source=/a,target=/b"\n  ]\n}\n';
  const out = applyFences(src, SEL);
  assertStringIncludes(out, "devc:source");
  assertStringIncludes(out, "devc:skills");
  const parsed = parseJsonc(out) as { mounts: string[]; name: string };
  assertEquals(parsed.name, "x");
  assert(parsed.mounts.includes("type=bind,source=/a,target=/b"));
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
          target: "/home/vscode/.claude/skills/skillA",
          readonly: true,
        },
        {
          source: b,
          target: "/home/vscode/.claude/skills/skillB",
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

Deno.test("saveGlobalConfig round-trips recentSkills and preserves unknown keys", async () => {
  await withTemp(async (dir) => {
    const path = `${dir}/config.json`;
    const cfg = makeGlobalConfig(["~/code"], ["~/skills"], path, { misc: 1 }, [
      "~/skills/x",
    ]);
    await saveGlobalConfig(cfg);
    const loaded = await loadGlobalConfig(path);
    assertEquals(loaded.recentSkills, ["~/skills/x"]);
    assertEquals(loaded.codeRoots, ["~/code"]);
    assertEquals(loaded.extra, { misc: 1 });
  });
});
