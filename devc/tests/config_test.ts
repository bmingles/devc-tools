// Config loading: `~` / `$VAR` expansion, which keys get it, and which deliberately do not.
//
// These tests mutate the process environment, so every one of them restores what it found —
// `deno test` shares one process across a file.

import { assert, assertEquals, assertThrows } from "jsr:@std/assert@^1";
import { join } from "jsr:@std/path@^1";
import { expandPath, loadConfig, UsageError } from "../config.ts";
import { withTemp, writeConfig } from "./helpers.ts";

/** Run `fn` with `vars` applied to the environment, restoring it afterwards. */
async function withEnv(
  vars: Record<string, string | null>,
  fn: () => Promise<void> | void,
): Promise<void> {
  const previous = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(vars)) {
    previous.set(k, Deno.env.get(k));
    if (v === null) Deno.env.delete(k);
    else Deno.env.set(k, v);
  }
  try {
    await fn();
  } finally {
    for (const [k, v] of previous) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
}

Deno.test("config: ~ and $VAR expand in host paths", async () => {
  await withEnv({ HOME: "/home/x", SRC: "/data/src" }, () => {
    const e = (v: string) => expandPath(v, "root", "/cfg.json");
    assertEquals(e("~/src"), "/home/x/src");
    assertEquals(e("~"), "/home/x");
    assertEquals(e("$HOME/src"), "/home/x/src");
    assertEquals(e("${HOME}/src"), "/home/x/src");
    assertEquals(e("$SRC/repos"), "/data/src/repos");
    assertEquals(e("${SRC}/a/$HOME"), "/data/src/a//home/x");

    // Only a *leading* `~` is special — mid-path it is an ordinary character, as in a shell.
    assertEquals(e("/a/~/b"), "/a/~/b");
    assertEquals(e("~x/y"), "~x/y");

    // Nothing to expand, including the default empty value.
    assertEquals(e(""), "");
    assertEquals(e("/abs/path"), "/abs/path");
  });
});

Deno.test("config: an unset variable is a usage error naming the key and the variable", async () => {
  await withEnv({ HOME: "/home/x", SRC: null, EMPTY: "" }, () => {
    const err = assertThrows(
      () => expandPath("$SRC/repos", "root", "/home/x/.config/devc-tui/config.json"),
      UsageError,
    );
    assert(err.message.includes('"root"'), err.message);
    assert(err.message.includes("$SRC"), err.message);
    assert(err.message.includes("is not set"), err.message);
    // The config path is reported the way the user would type it.
    assert(err.message.includes("~/.config/devc-tui/config.json"), err.message);

    // Set-but-empty counts as unset, matching how DEVC_TUI_CONFIG is already treated.
    assertThrows(() => expandPath("$EMPTY/repos", "root", "/cfg.json"), UsageError);
    assertThrows(() => expandPath("${EMPTY}", "root", "/cfg.json"), UsageError);
  });

  // `~` with no HOME reports as $HOME.
  await withEnv({ HOME: null }, () => {
    const err = assertThrows(() => expandPath("~/src", "root", "/cfg.json"), UsageError);
    assert(err.message.includes("$HOME"), err.message);
  });
});

Deno.test("config: host keys expand, container keys are left literal", async () => {
  await withTemp(async (tmp) => {
    await withEnv({ HOME: tmp, SRC: join(tmp, "src") }, async () => {
      const path = await writeConfig(tmp, {
        root: "~/src",
        skillsRoot: "$HOME/.claude/skills",
        devcontainerPath: "$HOME/dc.json",
        workspaceFile: "${HOME}/ws.code-workspace",
        // Container-side: the container's HOME is not this process's, so these stay as typed.
        containerRoot: "$HOME/workspaces",
        skillsContainerRoot: "~/skills",
      });
      const { cfg } = await loadConfig(path);
      assertEquals(cfg.root, join(tmp, "src"));
      assertEquals(cfg.skillsRoot, join(tmp, ".claude", "skills"));
      assertEquals(cfg.devcontainerPath, join(tmp, "dc.json"));
      assertEquals(cfg.workspaceFile, join(tmp, "ws.code-workspace"));
      assertEquals(cfg.containerRoot, "$HOME/workspaces");
      assertEquals(cfg.skillsContainerRoot, "~/skills");
    });
  });
});

Deno.test("config: loading a config with an unset variable throws, not scans", async () => {
  await withTemp(async (tmp) => {
    await withEnv({ NOPE_NOT_SET: null }, async () => {
      const path = await writeConfig(tmp, { root: "$NOPE_NOT_SET/repos" });
      const err = await loadConfig(path).then(() => null, (e) => e);
      assert(err instanceof UsageError, `expected UsageError, got ${err}`);
      assert(err.message.includes("$NOPE_NOT_SET"), err.message);
    });
  });
});

Deno.test("config: workspaceFile null is left null rather than expanded", async () => {
  await withTemp(async (tmp) => {
    await withEnv({ HOME: tmp }, async () => {
      const path = await writeConfig(tmp, { root: "~/src", workspaceFile: null });
      assertEquals((await loadConfig(path)).cfg.workspaceFile, null);
    });
  });
});
