import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import {
  ensureClaudeSeedDir,
  hasOwnDevcontainerConfig,
  loadResolvedRemoteEnv,
  materializeDefaultConfig,
  substituteVars,
} from "../default_config.ts";

async function mkdir(path: string) {
  await Deno.mkdir(path, { recursive: true });
}

async function withTempDir(fn: (tmp: string) => Promise<void>) {
  const tmp = await Deno.makeTempDir();
  try {
    await fn(tmp);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
}

Deno.test("hasOwnDevcontainerConfig is false for a plain directory", async () => {
  await withTempDir(async (tmp) => {
    assertEquals(await hasOwnDevcontainerConfig(tmp), false);
  });
});

Deno.test("hasOwnDevcontainerConfig is true for .devcontainer/devcontainer.json", async () => {
  await withTempDir(async (tmp) => {
    await mkdir(`${tmp}/.devcontainer`);
    await Deno.writeTextFile(`${tmp}/.devcontainer/devcontainer.json`, "{}");
    assertEquals(await hasOwnDevcontainerConfig(tmp), true);
  });
});

Deno.test("hasOwnDevcontainerConfig is true for .devcontainer.json", async () => {
  await withTempDir(async (tmp) => {
    await Deno.writeTextFile(`${tmp}/.devcontainer.json`, "{}");
    assertEquals(await hasOwnDevcontainerConfig(tmp), true);
  });
});

Deno.test("substituteVars resolves ${containerWorkspaceFolder}", () => {
  assertEquals(
    substituteVars("${containerWorkspaceFolder}/sub", "/workspaces/x"),
    "/workspaces/x/sub",
  );
});

Deno.test("substituteVars resolves ${localEnv:HOME}", () => {
  const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? ".";
  assertEquals(
    substituteVars("${localEnv:HOME}/foo", "/workspaces/x"),
    `${home}/foo`,
  );
});

Deno.test("substituteVars resolves an arbitrary ${localEnv:VAR}", () => {
  const prev = Deno.env.get("SOME_VAR");
  Deno.env.set("SOME_VAR", "/custom/path");
  Deno.env.delete("UNSET_VAR");
  try {
    assertEquals(
      substituteVars("${localEnv:SOME_VAR}/foo", "/workspaces/x"),
      "/custom/path/foo",
    );
    assertEquals(
      substituteVars("${localEnv:UNSET_VAR}/foo", "/workspaces/x"),
      "/foo",
    );
  } finally {
    if (prev === undefined) Deno.env.delete("SOME_VAR");
    else Deno.env.set("SOME_VAR", prev);
  }
});

Deno.test("substituteVars resolves both variables in one value", () => {
  const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? ".";
  assertEquals(
    substituteVars(
      "${localEnv:HOME}/data:${containerWorkspaceFolder}/data",
      "/workspaces/x",
    ),
    `${home}/data:/workspaces/x/data`,
  );
});

Deno.test("loadResolvedRemoteEnv returns remoteEnv from config with ${containerWorkspaceFolder} resolved", async () => {
  await withTempDir(async (tmp) => {
    await Deno.writeTextFile(
      `${tmp}/devcontainer.json`,
      JSON.stringify({
        remoteEnv: {
          PROJECT_PATH: "${containerWorkspaceFolder}",
          TZ: "America/Chicago",
        },
      }),
    );
    assertEquals(
      await loadResolvedRemoteEnv(
        `${tmp}/devcontainer.json`,
        "/workspaces/myproject",
      ),
      { PROJECT_PATH: "/workspaces/myproject", TZ: "America/Chicago" },
    );
  });
});

Deno.test("loadResolvedRemoteEnv returns {} when config has no remoteEnv", async () => {
  await withTempDir(async (tmp) => {
    await Deno.writeTextFile(`${tmp}/devcontainer.json`, "{}");
    assertEquals(
      await loadResolvedRemoteEnv(
        `${tmp}/devcontainer.json`,
        "/workspaces/x",
      ),
      {},
    );
  });
});

Deno.test("loadResolvedRemoteEnv strips // line comments from config before parsing", async () => {
  await withTempDir(async (tmp) => {
    await Deno.writeTextFile(
      `${tmp}/devcontainer.json`,
      `{
  // a comment
  "remoteEnv": { "FOO": "bar" }
}`,
    );
    assertEquals(
      await loadResolvedRemoteEnv(
        `${tmp}/devcontainer.json`,
        "/workspaces/x",
      ),
      { FOO: "bar" },
    );
  });
});

Deno.test("materializeDefaultConfig copies the embedded tree flat to cacheDir and returns the config path", async () => {
  await withTempDir(async (cacheDir) => {
    const path = await materializeDefaultConfig(cacheDir);
    // Flat layout: zero-config references no local Feature, so no `.devcontainer/`
    // nesting is needed (and it would not help — the CLI validates local Features
    // against the workspace root, not the config dir).
    assertEquals(path, `${cacheDir}/devcontainer.json`);

    for (
      const file of [
        "devcontainer.json",
        "Dockerfile",
        "features/devc/devcontainer-feature.json",
        "features/devc/install.sh",
        "features/devc/post-create.sh",
        "features/devc/bashrc-additions.sh",
      ]
    ) {
      assertEquals((await Deno.stat(`${cacheDir}/${file}`)).isFile, true);
    }
  });
});

Deno.test("materializeDefaultConfig materializes the devc Feature subtree (for the Dockerfile COPY)", async () => {
  await withTempDir(async (cacheDir) => {
    await materializeDefaultConfig(cacheDir);
    // The subtree is still copied even though the transformed config no longer
    // references it — the bundled Dockerfile COPYs the scripts from it.
    for (
      const file of [
        "features/devc/devcontainer-feature.json",
        "features/devc/install.sh",
        "features/devc/post-create.sh",
        "features/devc/bashrc-additions.sh",
      ]
    ) {
      assertEquals((await Deno.stat(`${cacheDir}/${file}`)).isFile, true);
    }
  });
});

Deno.test("materialized (zero-config) devcontainer.json strips the local Feature and adds a top-level postCreateCommand", async () => {
  await withTempDir(async (cacheDir) => {
    await materializeDefaultConfig(cacheDir);

    // The transform rewrites the cache config as plain (comment-free) JSON.
    const dc = JSON.parse(
      await Deno.readTextFile(`${cacheDir}/devcontainer.json`),
    );
    // Local Feature reference removed (it cannot resolve out-of-tree)...
    assertEquals(Object.hasOwn(dc.features, "./features/devc"), false);
    // ...ghcr features kept...
    assertEquals(Object.hasOwn(dc.features, "ghcr.io/devcontainers/features/node:1"), true);
    // ...and the baseline runtime runs via a top-level postCreateCommand instead.
    assertEquals(dc.postCreateCommand, "/usr/local/share/devc/post-create.sh");

    // devcontainer-feature.json still parses as plain JSON.
    const feat = JSON.parse(
      await Deno.readTextFile(
        `${cacheDir}/features/devc/devcontainer-feature.json`,
      ),
    );
    assertEquals(feat.id, "devc");
  });
});

Deno.test("canonical default devcontainer.json keeps the Feature and no top-level postCreateCommand", async () => {
  // The embedded source (used verbatim by `devc config` for a project) is the
  // Feature-based, composable form — the transform above is applied only to the
  // out-of-tree cache copy.
  const text = await Deno.readTextFile(
    new URL("../default/devcontainer.json", import.meta.url),
  );
  const noComments = text
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
  const dc = JSON.parse(noComments);
  assertEquals(Object.hasOwn(dc.features, "./features/devc"), true);
  assertEquals(Object.hasOwn(dc, "postCreateCommand"), false);
});

Deno.test("materializeDefaultConfig overwrites an existing copy without erroring", async () => {
  await withTempDir(async (cacheDir) => {
    await Deno.mkdir(cacheDir, { recursive: true });
    await Deno.writeTextFile(
      `${cacheDir}/devcontainer.json`,
      '{"marker":"STALE"}',
    );
    const first = await materializeDefaultConfig(cacheDir);
    const second = await materializeDefaultConfig(cacheDir);
    assertEquals(first, second);
    const contents = await Deno.readTextFile(`${cacheDir}/devcontainer.json`);
    assertEquals(contents.includes("STALE"), false);
  });
});

Deno.test("materializeDefaultConfig writes the embedded tree to real disk (default cache dir)", async () => {
  const path = await materializeDefaultConfig();
  assertEquals(path.endsWith("/devcontainer.json"), true);

  const stat = await Deno.stat(path);
  assertEquals(stat.isFile, true);

  const dir = path.slice(0, -"/devcontainer.json".length);
  for (
    const sibling of [
      "Dockerfile",
      "features/devc/install.sh",
      "features/devc/post-create.sh",
      "features/devc/bashrc-additions.sh",
    ]
  ) {
    const siblingStat = await Deno.stat(`${dir}/${sibling}`);
    assertEquals(siblingStat.isFile, true);
  }
});

Deno.test("materializeDefaultConfig preserves initializeCommand for the zero-config path", async () => {
  await withTempDir(async (tmp) => {
    const configPath = await materializeDefaultConfig(`${tmp}/cache`);
    const config = JSON.parse(await Deno.readTextFile(configPath));
    // Host-side hook that creates the ~/.claude seed mount source; a Feature cannot carry it,
    // so the zero-config transform must not drop it.
    assertEquals(
      config.initializeCommand,
      'mkdir -p "$HOME/.config/devc-tui/.claude"',
    );
  });
});

Deno.test("ensureClaudeSeedDir creates the directory and reports it", async () => {
  await withTempDir(async (tmp) => {
    const seed = `${tmp}/seed`;
    const result = await ensureClaudeSeedDir(seed, `${tmp}/claude`);
    assertEquals(result.created, true);
    assertEquals(result.migrated, []);
    assertEquals((await Deno.stat(seed)).isDirectory, true);
  });
});

Deno.test("ensureClaudeSeedDir is idempotent on an existing directory", async () => {
  await withTempDir(async (tmp) => {
    const seed = `${tmp}/seed`;
    await ensureClaudeSeedDir(seed, `${tmp}/claude`);
    const second = await ensureClaudeSeedDir(seed, `${tmp}/claude`);
    assertEquals(second.created, false);
    assertEquals(second.migrated, []);
  });
});

Deno.test("ensureClaudeSeedDir migrates the three ~/.claude files on first creation", async () => {
  await withTempDir(async (tmp) => {
    const claude = `${tmp}/claude`;
    await mkdir(claude);
    await Deno.writeTextFile(`${claude}/CLAUDE.md`, "# instructions\n");
    await Deno.writeTextFile(`${claude}/settings.devc.json`, '{"a":1}\n');
    await Deno.writeTextFile(`${claude}/statusline.sh`, "#!/bin/sh\necho hi\n");
    await Deno.chmod(`${claude}/statusline.sh`, 0o755);
    // Not in the migration list — a directory must not come along.
    await mkdir(`${claude}/skills`);

    const seed = `${tmp}/seed`;
    const result = await ensureClaudeSeedDir(seed, claude);

    assertEquals(result.created, true);
    assertEquals(result.migrated, [
      "CLAUDE.md",
      "settings.json",
      "statusline.sh",
    ]);
    // settings.devc.json is renamed; the .devc suffix is no longer needed.
    assertEquals(await Deno.readTextFile(`${seed}/settings.json`), '{"a":1}\n');
    assertEquals(
      await Deno.readTextFile(`${seed}/CLAUDE.md`),
      "# instructions\n",
    );
    assertEquals(
      await Deno.stat(`${seed}/settings.devc.json`).then(() => true).catch(
        () => false,
      ),
      false,
    );
    assertEquals(
      await Deno.stat(`${seed}/skills`).then(() => true).catch(() => false),
      false,
    );
    // copyFile carries permissions on Unix, so the statusline stays executable.
    assertEquals(
      (await Deno.stat(`${seed}/statusline.sh`)).mode! & 0o111,
      0o111,
    );
    // The host originals are copied, not moved.
    assertEquals((await Deno.stat(`${claude}/CLAUDE.md`)).isFile, true);
  });
});

Deno.test("ensureClaudeSeedDir skips migration when the seed directory already exists", async () => {
  await withTempDir(async (tmp) => {
    const claude = `${tmp}/claude`;
    await mkdir(claude);
    await Deno.writeTextFile(`${claude}/CLAUDE.md`, "# instructions\n");
    const seed = `${tmp}/seed`;
    await mkdir(seed);

    const result = await ensureClaudeSeedDir(seed, claude);

    assertEquals(result.created, false);
    assertEquals(result.migrated, []);
    // A file the user deleted from the seed is not resurrected.
    assertEquals(
      await Deno.stat(`${seed}/CLAUDE.md`).then(() => true).catch(() => false),
      false,
    );
  });
});

Deno.test("ensureClaudeSeedDir rejects a seed path that is not a directory", async () => {
  await withTempDir(async (tmp) => {
    const seed = `${tmp}/seed`;
    await Deno.writeTextFile(seed, "oops\n");
    await assertRejects(
      () => ensureClaudeSeedDir(seed, `${tmp}/claude`),
      Error,
      "is not a directory",
    );
  });
});

Deno.test("ensureClaudeSeedDir rejects a dangling symlink at the seed path", async () => {
  await withTempDir(async (tmp) => {
    const seed = `${tmp}/seed`;
    // Recursive mkdir reports AlreadyExists here rather than following through, so the
    // not-a-directory guard is what turns this into a readable error.
    await Deno.symlink(`${tmp}/nonexistent`, seed);
    await assertRejects(
      () => ensureClaudeSeedDir(seed, `${tmp}/claude`),
      Error,
      "is not a directory",
    );
  });
});
