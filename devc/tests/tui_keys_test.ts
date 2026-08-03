// Byte→key decoding. The interesting cases are the ones a real terminal actually produces:
// sequences split across reads, and the `\x1b` that is both Escape and the start of every
// arrow key.

import { assertEquals } from "jsr:@std/assert@^1";
import { decodeAll, KeyDecoder, type Key } from "../tui/keys.ts";

function names(keys: Key[]): string[] {
  return keys.map((k) => (k.name === "char" ? `char:${k.char}` : k.name));
}

function push(decoder: KeyDecoder, text: string): string[] {
  return names(decoder.push(new TextEncoder().encode(text)));
}

Deno.test("keys: arrows, paging, home/end and the CSI ~ forms", () => {
  assertEquals(names(decodeAll("\x1b[A\x1b[B\x1b[C\x1b[D")), ["up", "down", "right", "left"]);
  assertEquals(names(decodeAll("\x1b[5~\x1b[6~")), ["pageup", "pagedown"]);
  assertEquals(names(decodeAll("\x1b[H\x1b[F\x1b[1~\x1b[4~")), ["home", "end", "home", "end"]);
  // Application cursor mode (what many terminals send once the alt screen is up).
  assertEquals(names(decodeAll("\x1bOA\x1bOD\x1bOH")), ["up", "left", "home"]);
});

Deno.test("keys: enter, tab, backspace, Ctrl-C and printable characters", () => {
  assertEquals(names(decodeAll("\r")), ["enter"]);
  assertEquals(names(decodeAll("\n")), ["enter"]);
  assertEquals(names(decodeAll("\t")), ["tab"]);
  assertEquals(names(decodeAll("\x7f")), ["backspace"]);
  assertEquals(names(decodeAll("\x08")), ["backspace"]);
  assertEquals(names(decodeAll("\x03")), ["ctrl-c"]);
  assertEquals(names(decodeAll("aq /?")), [
    "char:a",
    "char:q",
    "char: ",
    "char:/",
    "char:?",
  ]);
  // Unhandled control bytes are dropped rather than mistaken for characters.
  assertEquals(names(decodeAll("\x01a")), ["char:a"]);
});

Deno.test("keys: an escape sequence split across two chunks decodes as one key", () => {
  const decoder = new KeyDecoder();
  assertEquals(push(decoder, "\x1b["), []);
  assertEquals(decoder.pending, 2);
  assertEquals(push(decoder, "A"), ["up"]);
  assertEquals(decoder.pending, 0);

  // Split inside the parameters of a `~` form, too.
  assertEquals(push(decoder, "\x1b[6"), []);
  assertEquals(push(decoder, "~"), ["pagedown"]);
});

Deno.test("keys: a lone escape with no continuation is the Escape key", () => {
  const decoder = new KeyDecoder();
  assertEquals(push(decoder, "\x1b"), ["escape"]);
  assertEquals(decoder.pending, 0);
  // Escape followed by a plain character in the same chunk: Escape, then the character.
  assertEquals(names(decodeAll("\x1bq")), ["escape", "char:q"]);
});

Deno.test("keys: unknown sequences are consumed without emitting a key", () => {
  assertEquals(names(decodeAll("\x1b[200~a")), ["char:a"]);
  assertEquals(names(decodeAll("\x1b[Z")), []);
});
