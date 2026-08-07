import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@^1";
import {
  emptyOverlay,
  findProjectOverlayPath,
  findUserOverlayPath,
  isEmptyOverlay,
  loadMergedOverlay,
  loadOverlayFile,
  mergeOverlays,
  overlayArgs,
  resolveOverlayRemoteEnv,
} from "../overlay.ts";
import { loadResolvedRemoteEnv } from "../default_config.ts";
import { fixture, withTemp } from "./helpers.ts";

/** Write `text` to `path`, creating parent directories. */
async function write(path: string, text: string): Promise<void> {
  await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  await Deno.writeTextFile(path, text);
}

/** Run `fn` with `console.error` captured, returning the lines it emitted. */
async function captureStderr(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => lines.push(args.join(" "));
  try {
    await fn();
  } finally {
    console.error = original;
  }
  return lines;
}

const HOME = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? ".";

// ── discovery ───────────────────────────────────────────────────────────────────────────────

Deno.test("findProjectOverlayPath is null when the project has no overlay", async () => {
  await withTemp(async (dir) => {
    assertEquals(await findProjectOverlayPath(dir), null);
  });
});

// All four locations are first-class; only the first hit is read, and the losers are never
// merged — so a key unique to a losing file must not show up in the result.
Deno.test("project overlay precedence: .devc/devc.jsonc wins over the other three", async () => {
  await withTemp(async (dir) => {
    await write(`${dir}/.devc/devc.jsonc`, '{"remoteEnv":{"WINNER":"a"}}');
    await write(`${dir}/.devc/devc.json`, '{"remoteEnv":{"ONLY_B":"b"}}');
    await write(
      `${dir}/.devcontainer/devc.jsonc`,
      '{"remoteEnv":{"ONLY_C":"c"}}',
    );
    await write(
      `${dir}/.devcontainer/devc.json`,
      '{"remoteEnv":{"ONLY_D":"d"}}',
    );
    assertEquals(await findProjectOverlayPath(dir), `${dir}/.devc/devc.jsonc`);
    assertEquals((await loadMergedOverlay(dir, `${dir}/nouser`)).remoteEnv, {
      WINNER: "a",
    });
  });
});

Deno.test("project overlay precedence: .devc/devc.json wins over both .devcontainer/ forms", async () => {
  await withTemp(async (dir) => {
    await write(`${dir}/.devc/devc.json`, '{"remoteEnv":{"WINNER":"b"}}');
    await write(
      `${dir}/.devcontainer/devc.jsonc`,
      '{"remoteEnv":{"ONLY_C":"c"}}',
    );
    await write(
      `${dir}/.devcontainer/devc.json`,
      '{"remoteEnv":{"ONLY_D":"d"}}',
    );
    assertEquals(await findProjectOverlayPath(dir), `${dir}/.devc/devc.json`);
    assertEquals((await loadMergedOverlay(dir, `${dir}/nouser`)).remoteEnv, {
      WINNER: "b",
    });
  });
});

Deno.test("project overlay precedence: .devcontainer/devc.jsonc wins over .devcontainer/devc.json", async () => {
  await withTemp(async (dir) => {
    await write(
      `${dir}/.devcontainer/devc.jsonc`,
      '{"remoteEnv":{"WINNER":"c"}}',
    );
    await write(
      `${dir}/.devcontainer/devc.json`,
      '{"remoteEnv":{"ONLY_D":"d"}}',
    );
    assertEquals(
      await findProjectOverlayPath(dir),
      `${dir}/.devcontainer/devc.jsonc`,
    );
    assertEquals((await loadMergedOverlay(dir, `${dir}/nouser`)).remoteEnv, {
      WINNER: "c",
    });
  });
});

Deno.test("user overlay precedence: devc.jsonc wins over devc.json", async () => {
  await withTemp(async (dir) => {
    await write(`${dir}/config/devc.jsonc`, '{"remoteEnv":{"WINNER":"jsonc"}}');
    await write(
      `${dir}/config/devc.json`,
      '{"remoteEnv":{"ONLY_JSON":"json"}}',
    );
    assertEquals(
      await findUserOverlayPath(`${dir}/config`),
      `${dir}/config/devc.jsonc`,
    );
    assertEquals(
      (await loadMergedOverlay(`${dir}/project`, `${dir}/config`)).remoteEnv,
      { WINNER: "jsonc" },
    );
  });
});

Deno.test("findUserOverlayPath is null when the config dir has neither file", async () => {
  await withTemp(async (dir) => {
    assertEquals(await findUserOverlayPath(dir), null);
  });
});

// The bug this feature exists to fix: the reference only consulted `devc.json` when the project
// had *no* `devcontainer.json`, so a project with its own config silently ignored it.
Deno.test("the overlay is read even when the project has its own devcontainer.json", async () => {
  await withTemp(async (dir) => {
    await write(`${dir}/.devcontainer/devcontainer.json`, '{"image":"x"}');
    await write(
      `${dir}/.devc/devc.json`,
      '{"mounts":["type=bind,source=/a,target=/b"]}',
    );
    const overlay = await loadMergedOverlay(dir, `${dir}/nouser`);
    assertEquals(
      overlayArgs(overlay, "/workspaces/p", dir),
      ["--mount", "type=bind,source=/a,target=/b"],
    );
  });
});

// ── parsing ─────────────────────────────────────────────────────────────────────────────────

Deno.test("loadMergedOverlay returns an empty overlay when nothing exists anywhere", async () => {
  await withTemp(async (dir) => {
    const overlay = await loadMergedOverlay(`${dir}/project`, `${dir}/config`);
    assertEquals(overlay, emptyOverlay());
    assertEquals(isEmptyOverlay(overlay), true);
    assertEquals(overlayArgs(overlay, "/workspaces/p", dir), []);
  });
});

Deno.test("loadOverlayFile parses real JSONC: comments and trailing commas", async () => {
  await withTemp(async (dir) => {
    await write(
      `${dir}/devc.json`,
      `{
  /* block
     comment */
  "mounts": [
    "type=bind,source=/a,target=/b", // an end-of-line note
  ],
  "remoteEnv": { "FOO": "bar", },
}`,
    );
    assertEquals(await loadOverlayFile(`${dir}/devc.json`), {
      mounts: ["type=bind,source=/a,target=/b"],
      additionalFeatures: {},
      remoteEnv: { FOO: "bar" },
    });
  });
});

// The overlay exists only for devc and is small and hand-written: silently starting a container
// missing the user's mounts is worse than a hard error.
Deno.test("loadOverlayFile throws naming the file path when it cannot be parsed", async () => {
  await withTemp(async (dir) => {
    const path = `${dir}/.devc/devc.json`;
    await write(path, '{ "mounts": [ oops');
    const err = await assertRejects(() => loadOverlayFile(path), Error);
    assertStringIncludes(err.message, path);
  });
});

Deno.test("loadMergedOverlay propagates the parse failure with the path", async () => {
  await withTemp(async (dir) => {
    await write(`${dir}/.devcontainer/devc.jsonc`, "not json");
    const err = await assertRejects(
      () => loadMergedOverlay(dir, `${dir}/nouser`),
      Error,
    );
    assertStringIncludes(err.message, `${dir}/.devcontainer/devc.jsonc`);
  });
});

// `parseJsonc` yields `null` for an empty file, not `{}` — a naive property access would throw.
Deno.test("an empty overlay file is no overlay, not an error", async () => {
  await withTemp(async (dir) => {
    await write(`${dir}/.devc/devc.json`, "");
    assertEquals(
      await loadMergedOverlay(dir, `${dir}/nouser`),
      emptyOverlay(),
    );
  });
});

Deno.test("a comment-only overlay file is no overlay, not an error", async () => {
  await withTemp(async (dir) => {
    await write(`${dir}/.devc/devc.json`, "// nothing here yet\n");
    assertEquals(
      await loadMergedOverlay(dir, `${dir}/nouser`),
      emptyOverlay(),
    );
  });
});

// A typo like `"mount"` must not silently do nothing — but it must not fail the command either.
Deno.test("an unknown top-level key warns naming the key and is otherwise ignored", async () => {
  await withTemp(async (dir) => {
    const path = `${dir}/.devc/devc.json`;
    await write(
      path,
      '{"mount":["type=bind,source=/a,target=/b"],"remoteEnv":{"FOO":"bar"}}',
    );
    let overlay = emptyOverlay();
    const warnings = await captureStderr(async () => {
      overlay = await loadOverlayFile(path);
    });
    assertEquals(warnings.length, 1);
    assertStringIncludes(warnings[0], '"mount"');
    assertStringIncludes(warnings[0], path);
    // The recognized key still applied, and the unknown one contributed nothing.
    assertEquals(overlay.mounts, []);
    assertEquals(overlay.remoteEnv, { FOO: "bar" });
  });
});

Deno.test("loadOverlayFile rejects a wrongly-typed known key, naming the file and key", async () => {
  await withTemp(async (dir) => {
    const path = `${dir}/devc.json`;
    await write(path, '{"mounts":"type=bind,source=/a,target=/b"}');
    const err = await assertRejects(() => loadOverlayFile(path), Error);
    assertStringIncludes(err.message, path);
    assertStringIncludes(err.message, '"mounts"');
  });
});

// ── merge ───────────────────────────────────────────────────────────────────────────────────

Deno.test("user + project: mounts concatenate user-first, remoteEnv resolves to the project's", async () => {
  await withTemp(async (dir) => {
    await write(
      `${dir}/config/devc.json`,
      JSON.stringify({
        mounts: ["type=bind,source=/user,target=/u"],
        remoteEnv: { SHARED: "from-user", USER_ONLY: "kept" },
      }),
    );
    await write(
      `${dir}/project/.devc/devc.json`,
      JSON.stringify({
        mounts: ["type=bind,source=/project,target=/p"],
        remoteEnv: { SHARED: "from-project" },
      }),
    );

    const overlay = await loadMergedOverlay(`${dir}/project`, `${dir}/config`);
    assertEquals(overlay.mounts, [
      "type=bind,source=/user,target=/u",
      "type=bind,source=/project,target=/p",
    ]);
    assertEquals(overlay.remoteEnv, {
      SHARED: "from-project",
      USER_ONLY: "kept",
    });
  });
});

Deno.test("additionalFeatures merge per feature id, whole-value replace (no deep merge)", async () => {
  await withTemp(async (dir) => {
    await write(
      `${dir}/config/devc.json`,
      JSON.stringify({
        additionalFeatures: {
          "ghcr.io/x/rust:1": { version: "1.70", profile: "minimal" },
          "ghcr.io/x/go:1": { version: "1.22" },
        },
      }),
    );
    await write(
      `${dir}/project/.devc/devc.json`,
      JSON.stringify({
        additionalFeatures: { "ghcr.io/x/rust:1": { version: "latest" } },
      }),
    );

    const overlay = await loadMergedOverlay(`${dir}/project`, `${dir}/config`);
    assertEquals(overlay.additionalFeatures, {
      // The project's whole value replaced the user's — `profile` is gone, not blended.
      "ghcr.io/x/rust:1": { version: "latest" },
      "ghcr.io/x/go:1": { version: "1.22" },
    });
  });
});

Deno.test("mergeOverlays leaves both inputs untouched", () => {
  const user = {
    mounts: ["u"],
    additionalFeatures: { f: 1 },
    remoteEnv: { A: "u" },
  };
  const project = {
    mounts: ["p"],
    additionalFeatures: { f: 2 },
    remoteEnv: { A: "p" },
  };
  mergeOverlays(user, project);
  assertEquals(user.mounts, ["u"]);
  assertEquals(project.remoteEnv, { A: "p" });
});

// ── emitted args ────────────────────────────────────────────────────────────────────────────

Deno.test("overlayArgs emits --mount, --additional-features, --remote-env in that order", () => {
  const args = overlayArgs(
    {
      mounts: ["m1", "m2"],
      additionalFeatures: { "ghcr.io/x/rust:1": { version: "latest" } },
      remoteEnv: { A: "1", B: "2" },
    },
    "/workspaces/p",
    "/home/me/p",
  );
  assertEquals(args, [
    "--mount",
    "m1",
    "--mount",
    "m2",
    "--additional-features",
    '{"ghcr.io/x/rust:1":{"version":"latest"}}',
    "--remote-env",
    "A=1",
    "--remote-env",
    "B=2",
  ]);
});

Deno.test("an empty merged additionalFeatures emits no --additional-features arg", () => {
  const args = overlayArgs(
    { mounts: ["m1"], additionalFeatures: {}, remoteEnv: {} },
    "/workspaces/p",
    "/home/me/p",
  );
  assertEquals(args, ["--mount", "m1"]);
});

// `--mount` values reach Docker without passing through the devcontainer CLI's substitution, so
// devc has to resolve every form it can itself. The reference resolved only the first two.
Deno.test("a mount spec resolves all four substitutable variable forms", async () => {
  await withTemp(async (dir) => {
    const path = `${dir}/.devc/devc.jsonc`;
    await write(path, await fixture("devc_overlay.jsonc"));
    const overlay = await loadOverlayFile(path);
    const args = overlayArgs(
      overlay,
      "/workspaces/p",
      "/home/me/src/myproject",
    );
    assertEquals(args.slice(0, 4), [
      "--mount",
      `type=bind,source=${HOME}/notes,target=/workspaces/p/../notes`,
      "--mount",
      "type=bind,source=/home/me/src/myproject/.cache,target=/cache/myproject",
    ]);
    // ...and the fixture's remoteEnv value is substituted too, while its feature options are not.
    assertEquals(args.slice(4), [
      "--additional-features",
      '{"ghcr.io/devcontainers/features/rust:1":{"version":"latest"}}',
      "--remote-env",
      "NOTES_DIR=/workspaces/p/../notes",
    ]);
  });
});

// The reference passed `--remote-env` values through unsubstituted while its own exec path
// substituted them, so the same variable resolved in `devc exec` and stayed literal in the
// container.
Deno.test("a ${containerWorkspaceFolder} in overlay remoteEnv is substituted in --remote-env", () => {
  assertEquals(
    overlayArgs(
      {
        mounts: [],
        additionalFeatures: {},
        remoteEnv: { NOTES: "${containerWorkspaceFolder}/../notes" },
      },
      "/workspaces/p",
      "/home/me/p",
    ),
    ["--remote-env", "NOTES=/workspaces/p/../notes"],
  );
});

// That JSON is merged into the config by the CLI and goes through *its* substitution pipeline;
// pre-resolving here would double-resolve.
Deno.test("additionalFeatures values are not substituted", () => {
  const args = overlayArgs(
    {
      mounts: [],
      additionalFeatures: {
        "ghcr.io/x/f:1": { dir: "${containerWorkspaceFolder}/x" },
      },
      remoteEnv: {},
    },
    "/workspaces/p",
    "/home/me/p",
  );
  assertEquals(args, [
    "--additional-features",
    '{"ghcr.io/x/f:1":{"dir":"${containerWorkspaceFolder}/x"}}',
  ]);
});

// ── remoteEnv for exec/attach ───────────────────────────────────────────────────────────────

// `docker exec` never sees `remoteEnv`, so devc re-derives it. Same composition startContainer
// does after the `up`, with the authoritative remoteWorkspaceFolder.
Deno.test("effective exec remoteEnv orders base config < user overlay < project overlay", async () => {
  await withTemp(async (dir) => {
    await write(
      `${dir}/project/.devcontainer/devcontainer.json`,
      JSON.stringify({
        remoteEnv: {
          FROM_BASE: "base",
          BEATEN_BY_USER: "base",
          BEATEN_BY_PROJECT: "base",
        },
      }),
    );
    await write(
      `${dir}/config/devc.json`,
      JSON.stringify({
        remoteEnv: {
          BEATEN_BY_USER: "user",
          BEATEN_BY_PROJECT: "user",
          FROM_USER: "user",
        },
      }),
    );
    await write(
      `${dir}/project/.devc/devc.json`,
      JSON.stringify({
        remoteEnv: {
          BEATEN_BY_PROJECT: "project",
          FROM_PROJECT: "${containerWorkspaceFolder}/p",
        },
      }),
    );

    const base = await loadResolvedRemoteEnv(
      `${dir}/project/.devcontainer/devcontainer.json`,
      "/workspaces/p",
      `${dir}/project`,
    );
    const overlay = await loadMergedOverlay(`${dir}/project`, `${dir}/config`);
    const effective = {
      ...base,
      ...resolveOverlayRemoteEnv(overlay, "/workspaces/p", `${dir}/project`),
    };

    assertEquals(effective, {
      FROM_BASE: "base",
      BEATEN_BY_USER: "user",
      BEATEN_BY_PROJECT: "project",
      FROM_USER: "user",
      FROM_PROJECT: "/workspaces/p/p",
    });
  });
});

// ── the standalone invariant ────────────────────────────────────────────────────────────────

// Whatever lands in `.devcontainer/` must run without devc installed at all, which is only
// structurally true if no code path in this feature writes to the project's config. The overlay
// reads it; it never writes it.
Deno.test("the overlay read path leaves the project devcontainer.json byte-identical", async () => {
  await withTemp(async (dir) => {
    const configPath = `${dir}/.devcontainer/devcontainer.json`;
    const original = '{\n  // hand-written\n  "image": "x",\n}\n';
    await write(configPath, original);
    await write(
      `${dir}/.devcontainer/devc.json`,
      JSON.stringify({
        mounts: ["type=bind,source=${localEnv:HOME}/notes,target=/notes"],
        additionalFeatures: { "ghcr.io/x/rust:1": {} },
        remoteEnv: { A: "${containerWorkspaceFolder}" },
      }),
    );
    const before = await Deno.stat(configPath);

    const overlay = await loadMergedOverlay(dir, `${dir}/nouser`);
    overlayArgs(overlay, "/workspaces/p", dir);
    await loadResolvedRemoteEnv(configPath, "/workspaces/p", dir);
    resolveOverlayRemoteEnv(overlay, "/workspaces/p", dir);

    assertEquals(await Deno.readTextFile(configPath), original);
    // Not even the mtime moved — the file was never opened for writing.
    assertEquals((await Deno.stat(configPath)).mtime, before.mtime);
  });
});
