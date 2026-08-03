import { assertEquals } from "jsr:@std/assert@^1";
import {
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

Deno.test("materializeDefaultConfig copies the embedded tree to cacheDir and returns the config path", async () => {
  await withTempDir(async (cacheDir) => {
    const path = await materializeDefaultConfig(cacheDir);
    // Config lands inside a `.devcontainer/` folder so the CLI accepts the
    // relative-path `./features/devc` Feature (it must be a child of it).
    assertEquals(path, `${cacheDir}/.devcontainer/devcontainer.json`);

    for (
      const file of [
        "devcontainer.json",
        "Dockerfile",
        "features/devc/devcontainer-feature.json",
        "features/devc/install.sh",
        "features/devc/post-create.sh",
        "features/devc/bashrc-additions.sh",
        "features/devc/tmux.conf",
      ]
    ) {
      assertEquals(
        (await Deno.stat(`${cacheDir}/.devcontainer/${file}`)).isFile,
        true,
      );
    }
  });
});

Deno.test("materializeDefaultConfig materializes the devc Feature subtree", async () => {
  await withTempDir(async (cacheDir) => {
    await materializeDefaultConfig(cacheDir);
    for (
      const file of [
        "features/devc/devcontainer-feature.json",
        "features/devc/install.sh",
        "features/devc/post-create.sh",
      ]
    ) {
      assertEquals(
        (await Deno.stat(`${cacheDir}/.devcontainer/${file}`)).isFile,
        true,
      );
    }
  });
});

Deno.test("materialized devcontainer.json and devcontainer-feature.json parse as valid JSON/JSONC", async () => {
  await withTempDir(async (cacheDir) => {
    await materializeDefaultConfig(cacheDir);

    // devcontainer.json is JSONC (has // comments); strip them before parsing.
    const dcText = await Deno.readTextFile(
      `${cacheDir}/.devcontainer/devcontainer.json`,
    );
    const dcNoComments = dcText
      .split("\n")
      .filter((line) => !/^\s*\/\//.test(line))
      .join("\n");
    const dc = JSON.parse(dcNoComments);
    // The devc Feature is referenced by relative path; the top-level
    // postCreateCommand is left free for the developer.
    assertEquals(Object.hasOwn(dc.features, "./features/devc"), true);
    assertEquals(Object.hasOwn(dc, "postCreateCommand"), false);

    // devcontainer-feature.json is plain JSON.
    const featText = await Deno.readTextFile(
      `${cacheDir}/.devcontainer/features/devc/devcontainer-feature.json`,
    );
    const feat = JSON.parse(featText);
    assertEquals(feat.id, "devc");
  });
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
    const contents = await Deno.readTextFile(
      `${cacheDir}/.devcontainer/devcontainer.json`,
    );
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
