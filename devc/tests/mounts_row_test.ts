import { assertEquals, assertThrows } from "jsr:@std/assert@^1";
import {
  assertNoDuplicateTarget,
  basename,
  defaultReadonly,
  defaultTarget,
  DuplicateTargetError,
  foldHome,
  type MountRow,
  parseEntry,
  rowForHostPath,
  rowToEntry,
  serializeMount,
  SKILLS_CONTAINER_ROOT,
  SOURCE_CONTAINER_ROOT,
} from "../mounts.ts";

Deno.test("serializeMount: source (rw) and skills (ro) forms", () => {
  assertEquals(
    serializeMount({
      source: "/host/p",
      target: "/workspaces/p",
      readonly: false,
    }),
    "type=bind,source=/host/p,target=/workspaces/p,consistency=cached",
  );
  assertEquals(
    serializeMount({
      source: "/host/s",
      target: "/home/vscode/.claude/skills/s",
      readonly: true,
    }),
    "type=bind,source=/host/s,target=/home/vscode/.claude/skills/s,consistency=cached,readonly",
  );
});

Deno.test("serialize/parse round-trip through a fence entry", () => {
  const rows: MountRow[] = [
    {
      source: "${localEnv:HOME}/code/p",
      target: "/workspaces/p",
      readonly: false,
    },
    {
      source: "/abs/skills/s",
      target: "/home/vscode/.claude/skills/s",
      readonly: true,
    },
  ];
  for (const row of rows) {
    const entry = rowToEntry(row);
    // A fence entry is a JSON-quoted spec string.
    assertEquals(entry, JSON.stringify(serializeMount(row)));
    assertEquals(parseEntry(entry), row);
  }
});

Deno.test("parseEntry: accepts a bare spec and rejects non-bind entries", () => {
  assertEquals(
    parseEntry("type=bind,source=/a,target=/b,consistency=cached"),
    { source: "/a", target: "/b", readonly: false },
  );
  assertEquals(parseEntry('"type=volume,source=vol,target=/x"'), null);
  assertEquals(parseEntry('"not a mount"'), null);
});

Deno.test("foldHome: paths under $HOME fold; others stay absolute", () => {
  assertEquals(
    foldHome("/home/me/code/p", "/home/me"),
    "${localEnv:HOME}/code/p",
  );
  assertEquals(foldHome("/home/me", "/home/me"), "${localEnv:HOME}");
  assertEquals(foldHome("/srv/repos/p", "/home/me"), "/srv/repos/p");
  // Already folded / ~ paths are left as-is.
  assertEquals(
    foldHome("${localEnv:HOME}/x", "/home/me"),
    "${localEnv:HOME}/x",
  );
  assertEquals(foldHome("~/x", "/home/me"), "~/x");
});

Deno.test("basename + default targets and readonly for each step", () => {
  assertEquals(basename("/home/me/code/my-repo/"), "my-repo");
  assertEquals(
    defaultTarget("source", "/home/me/code/my-repo"),
    `${SOURCE_CONTAINER_ROOT}/my-repo`,
  );
  assertEquals(
    defaultTarget("skills", "/home/me/skills/agent"),
    `${SKILLS_CONTAINER_ROOT}/agent`,
  );
  assertEquals(defaultReadonly("source"), false);
  assertEquals(defaultReadonly("skills"), true);
});

Deno.test("rowForHostPath folds home and applies step defaults", () => {
  const home = Deno.env.get("HOME")!;
  const src = rowForHostPath("source", `${home}/code/p`);
  assertEquals(src, {
    source: "${localEnv:HOME}/code/p",
    target: `${SOURCE_CONTAINER_ROOT}/p`,
    readonly: false,
  });
  const sk = rowForHostPath("skills", "/srv/skills/agent");
  assertEquals(sk, {
    source: "/srv/skills/agent",
    target: `${SKILLS_CONTAINER_ROOT}/agent`,
    readonly: true,
  });
});

Deno.test("duplicate target within a step is rejected", () => {
  const rows: MountRow[] = [{
    source: "/a",
    target: "/workspaces/p",
    readonly: false,
  }];
  assertThrows(
    () =>
      assertNoDuplicateTarget(rows, {
        source: "/b",
        target: "/workspaces/p",
        readonly: false,
      }),
    DuplicateTargetError,
    "/workspaces/p",
  );
  // A different target is fine.
  assertNoDuplicateTarget(rows, {
    source: "/b",
    target: "/workspaces/q",
    readonly: false,
  });
  // Editing a row against itself (same index) is allowed.
  assertNoDuplicateTarget(rows, {
    source: "/a",
    target: "/workspaces/p",
    readonly: true,
  }, 0);
});
