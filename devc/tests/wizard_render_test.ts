import { assert, assertEquals } from "jsr:@std/assert@^1";
import {
  colorEnabled,
  MIN_COLUMNS,
  MIN_ROWS,
  render,
  type Size,
  stripAnsi,
  TOO_SMALL,
} from "../tui/wizard_render.ts";
import { initialGlobalState, reduce } from "../tui/wizard_state.ts";

const SIZE: Size = { columns: 60, rows: 16 };

function state(color: boolean) {
  return initialGlobalState(["~/code"], ["~/.agents/skills"], color);
}

Deno.test("render: exactly size.rows lines, none wider than size.columns", () => {
  const lines = render(state(true), SIZE);
  assertEquals(lines.length, SIZE.rows);
  for (const line of lines) {
    assert(stripAnsi(line).length <= SIZE.columns, `line too wide: ${JSON.stringify(line)}`);
  }
});

Deno.test("render: colour off has no escapes and equals colour-on stripped", () => {
  const colored = render(state(true), SIZE);
  const plain = render(state(false), SIZE);
  for (const line of plain) {
    // deno-lint-ignore no-control-regex
    assert(!/\x1b/.test(line), `plain frame has an escape: ${JSON.stringify(line)}`);
  }
  assertEquals(plain, colored.map(stripAnsi));
});

Deno.test("render: shows both control labels and their entries", () => {
  const text = render(state(false), SIZE).join("\n");
  assert(text.includes("Global config"));
  assert(text.includes("Code roots"));
  assert(text.includes("Skills roots"));
  assert(text.includes("~/code"));
  assert(text.includes("~/.agents/skills"));
});

Deno.test("render: empty control shows (none)", () => {
  const text = render(initialGlobalState([], [], false), SIZE).join("\n");
  assert(text.includes("(none)"));
});

Deno.test("render: too small shows the notice, padded to rows", () => {
  const small: Size = { columns: MIN_COLUMNS - 1, rows: MIN_ROWS - 1 };
  const lines = render(state(false), small);
  assertEquals(lines.length, small.rows);
  assert(lines[0].startsWith(TOO_SMALL.slice(0, small.columns)));
});

Deno.test("render: Add input mode shows the prompt", () => {
  let s = initialGlobalState([], [], false);
  s = reduce(s, { name: "enter" }).state; // open Add on Code roots
  s = reduce(s, { name: "char", char: "~" }).state;
  const text = render(s, SIZE).join("\n");
  assert(text.includes("add: ~"));
});

Deno.test("colorEnabled respects NO_COLOR", () => {
  const prev = Deno.env.get("NO_COLOR");
  try {
    Deno.env.set("NO_COLOR", "1");
    assertEquals(colorEnabled(false), false);
    Deno.env.delete("NO_COLOR");
    assertEquals(colorEnabled(false), true);
    assertEquals(colorEnabled(true), false);
  } finally {
    if (prev === undefined) Deno.env.delete("NO_COLOR");
    else Deno.env.set("NO_COLOR", prev);
  }
});
