import { assertEquals } from "jsr:@std/assert@^1";
import { sessionNameForWorkspaceFolder } from "../container.ts";

Deno.test("sessionNameForWorkspaceFolder uses the basename of the workspace folder", () => {
  assertEquals(
    sessionNameForWorkspaceFolder("/workspaces/some-tool"),
    "some-tool",
  );
});

Deno.test("sessionNameForWorkspaceFolder strips a trailing slash", () => {
  assertEquals(
    sessionNameForWorkspaceFolder("/workspaces/some-tool/"),
    "some-tool",
  );
});

Deno.test("sessionNameForWorkspaceFolder replaces tmux separator characters", () => {
  assertEquals(
    sessionNameForWorkspaceFolder("/workspaces/my.project:v2"),
    "my_project_v2",
  );
});

Deno.test("sessionNameForWorkspaceFolder falls back to main for an empty path", () => {
  assertEquals(sessionNameForWorkspaceFolder("/"), "main");
});
