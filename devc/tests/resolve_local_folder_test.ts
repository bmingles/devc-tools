import { assertEquals } from "jsr:@std/assert@^1";
import { resolveLocalFolder } from "../container.ts";

const CWD = "/Users/brian/code/tools/some-tool";

Deno.test("resolveLocalFolder resolves `.` to the cwd (no trailing /.)", () => {
  assertEquals(resolveLocalFolder(".", CWD), CWD);
});

Deno.test("resolveLocalFolder defaults an absent path arg to the cwd", () => {
  assertEquals(resolveLocalFolder(undefined, CWD), CWD);
});

Deno.test("resolveLocalFolder leaves an absolute path unchanged", () => {
  assertEquals(resolveLocalFolder("/some/other/dir", CWD), "/some/other/dir");
});

Deno.test("resolveLocalFolder joins a relative subpath onto the cwd", () => {
  assertEquals(resolveLocalFolder("sub/dir", CWD), `${CWD}/sub/dir`);
});

Deno.test("resolveLocalFolder normalizes `..` segments", () => {
  assertEquals(
    resolveLocalFolder("../sibling", CWD),
    "/Users/brian/code/tools/sibling",
  );
});

Deno.test("resolveLocalFolder strips a trailing slash from an absolute arg", () => {
  assertEquals(resolveLocalFolder("/some/dir/", CWD), "/some/dir");
});

Deno.test("resolveLocalFolder converts backslashes to forward slashes", () => {
  assertEquals(
    resolveLocalFolder("sub\\dir", CWD),
    `${CWD}/sub/dir`,
  );
});
