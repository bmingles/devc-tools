// Bytes → keys. A terminal in raw mode hands us whatever it feels like: a single byte, a
// whole escape sequence, or half of one — so the decoder **buffers across chunks** and only
// emits a key once it has all of it.
//
// The one genuinely ambiguous byte is `\x1b`: it is both the Escape key and the first byte of
// every arrow/page sequence. Rule: a trailing lone `\x1b` at the end of a chunk resolves to
// Escape (nothing followed it), while `\x1b[` — a sequence that has started but not finished —
// stays in the buffer and waits for the rest.

export type KeyName =
  | "up"
  | "down"
  | "left"
  | "right"
  | "pageup"
  | "pagedown"
  | "home"
  | "end"
  | "enter"
  | "tab"
  | "backspace"
  | "escape"
  | "ctrl-c"
  | "char";

export interface Key {
  name: KeyName;
  /** Only for `name === "char"`: the printable ASCII character. */
  char?: string;
}

export function key(name: KeyName): Key {
  return { name };
}

export function charKey(char: string): Key {
  return { name: "char", char };
}

const ESC = 0x1b;
const CSI = 0x5b; // '['
const SS3 = 0x4f; // 'O'

/** Final letters shared by `\x1b[<L>` (CSI) and `\x1b O<L>` (application cursor mode). */
const LETTER_KEYS: Record<string, KeyName> = {
  A: "up",
  B: "down",
  C: "right",
  D: "left",
  H: "home",
  F: "end",
};

/** `\x1b[<n>~` forms. */
const TILDE_KEYS: Record<string, KeyName> = {
  "1": "home",
  "4": "end",
  "5": "pageup",
  "6": "pagedown",
  "7": "home",
  "8": "end",
};

interface Step {
  /** Undefined when the bytes were recognized but carry no key (unknown sequence). */
  key?: Key;
  /** Offset just past the consumed bytes. */
  next: number;
}

/** Stateful decoder: one per input stream. */
export class KeyDecoder {
  #pending = new Uint8Array(0);

  /** Decode everything decodable in `chunk`, keeping any partial sequence for next time. */
  push(chunk: Uint8Array): Key[] {
    const buf = concat(this.#pending, chunk);
    const keys: Key[] = [];
    let i = 0;
    while (i < buf.length) {
      const step = decodeAt(buf, i);
      if (step === null) break; // incomplete sequence — wait for more bytes
      if (step.key !== undefined) keys.push(step.key);
      i = step.next;
    }
    this.#pending = buf.slice(i);
    return keys;
  }

  /** Bytes held back waiting for the rest of a sequence (diagnostics/tests). */
  get pending(): number {
    return this.#pending.length;
  }
}

/** Decode one key at `i`, or `null` when the bytes so far are an unfinished sequence. */
function decodeAt(buf: Uint8Array, i: number): Step | null {
  const b = buf[i];
  if (b === ESC) return decodeEscape(buf, i);
  if (b === 0x0d || b === 0x0a) return { key: key("enter"), next: i + 1 };
  if (b === 0x09) return { key: key("tab"), next: i + 1 };
  if (b === 0x7f || b === 0x08) return { key: key("backspace"), next: i + 1 };
  if (b === 0x03) return { key: key("ctrl-c"), next: i + 1 };
  if (b >= 0x20 && b < 0x7f) return { key: charKey(String.fromCharCode(b)), next: i + 1 };
  return { next: i + 1 }; // other control bytes: ignored
}

function decodeEscape(buf: Uint8Array, i: number): Step | null {
  // Nothing followed it in this chunk: it really was the Escape key.
  if (i + 1 >= buf.length) return { key: key("escape"), next: i + 1 };

  const kind = buf[i + 1];
  if (kind === SS3) {
    if (i + 2 >= buf.length) return null;
    const name = LETTER_KEYS[String.fromCharCode(buf[i + 2])];
    return { key: name === undefined ? undefined : key(name), next: i + 3 };
  }
  if (kind !== CSI) {
    // Alt-<key> and friends: report the Escape and let the rest decode on its own.
    return { key: key("escape"), next: i + 1 };
  }

  // CSI: parameter bytes (digits and ';') then one final byte.
  let j = i + 2;
  let params = "";
  while (j < buf.length) {
    const c = buf[j];
    if ((c >= 0x30 && c <= 0x39) || c === 0x3b) {
      params += String.fromCharCode(c);
      j++;
      continue;
    }
    break;
  }
  if (j >= buf.length) return null; // final byte not here yet
  const final = String.fromCharCode(buf[j]);
  const next = j + 1;
  if (final === "~") {
    const name = TILDE_KEYS[params];
    return { key: name === undefined ? undefined : key(name), next };
  }
  const name = LETTER_KEYS[final];
  return { key: name === undefined ? undefined : key(name), next };
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b;
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** Convenience for tests and scripted input: decode a whole string in one chunk. */
export function decodeAll(text: string): Key[] {
  return new KeyDecoder().push(new TextEncoder().encode(text));
}
