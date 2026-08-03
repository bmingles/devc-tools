import { assertEquals } from "jsr:@std/assert@^1";
import { parseAttachArgs } from "../args.ts";

Deno.test("parseAttachArgs leaves target undefined when no path is given", () => {
  assertEquals(parseAttachArgs([]), {
    target: undefined,
    rebuild: false,
    noClear: false,
  });
  assertEquals(parseAttachArgs(["--build"]), {
    target: undefined,
    rebuild: true,
    noClear: false,
  });
});

Deno.test("parseAttachArgs parses a bare path", () => {
  assertEquals(parseAttachArgs(["/some/path"]), {
    target: "/some/path",
    rebuild: false,
    noClear: false,
  });
});

Deno.test("parseAttachArgs parses flags alongside a path in any order", () => {
  assertEquals(parseAttachArgs(["--build", "/some/path"]), {
    target: "/some/path",
    rebuild: true,
    noClear: false,
  });
  assertEquals(parseAttachArgs(["/some/path", "--build"]), {
    target: "/some/path",
    rebuild: true,
    noClear: false,
  });
});

Deno.test("parseAttachArgs parses --no-clear flag", () => {
  assertEquals(parseAttachArgs(["--no-clear"]), {
    target: undefined,
    rebuild: false,
    noClear: true,
  });
  assertEquals(parseAttachArgs(["--no-clear", "--build", "/some/path"]), {
    target: "/some/path",
    rebuild: true,
    noClear: true,
  });
});
