// Inline yes/no confirm — a small pure state machine (`confirmReduce` + `confirmLine`) wrapped
// by a thin loop (`runConfirm`) that reads single keypresses. Unlike the folder picker this is
// *inline*: it stays on the normal screen (no alternate-screen takeover), the way a shell
// prompt does. It toggles raw mode itself (to read one key without Enter) but never enters the
// alternate screen. All IO is injected, so tests script a key stream with no TTY.

import { type Key, KeyDecoder } from './keys.ts';

export interface ConfirmState {
  question: string;
  defaultYes: boolean;
  /** null until answered. */
  answer: boolean | null;
  done: boolean;
}

export function confirmState(
  question: string,
  defaultYes: boolean,
): ConfirmState {
  return { question, defaultYes, answer: null, done: false };
}

/** The prompt line, e.g. `Apply? [Y/n]` (default upper-cased). Pure. */
export function confirmLine(state: ConfirmState): string {
  const hint = state.defaultYes ? '[Y/n]' : '[y/N]';
  return `${state.question} ${hint} `;
}

export function confirmReduce(state: ConfirmState, key: Key): ConfirmState {
  if (state.done) return state;
  switch (key.name) {
    case 'enter':
      return { ...state, answer: state.defaultYes, done: true };
    case 'escape':
    case 'ctrl-c':
      return { ...state, answer: false, done: true };
    case 'char': {
      const c = (key.char ?? '').toLowerCase();
      if (c === 'y') return { ...state, answer: true, done: true };
      if (c === 'n') return { ...state, answer: false, done: true };
      return state; // ignore any other character
    }
    default:
      return state;
  }
}

export interface ConfirmDeps {
  input: ReadableStream<Uint8Array>;
  output: WritableStream<Uint8Array>;
  /** Toggle raw mode to read a single keypress. Off in tests. */
  raw?: boolean;
}

/**
 * Ask `question` inline and resolve to the answer. Prints the prompt, reads one decision key,
 * echoes the choice, and leaves the cursor on a fresh line. Raw mode (when on) is always
 * restored via `finally`; the stdin reader lock is released (not cancelled) so the next step in
 * the flow can read from the same stream.
 */
export async function runConfirm(
  question: string,
  defaultYes: boolean,
  deps: ConfirmDeps,
): Promise<boolean> {
  const encoder = new TextEncoder();
  const writer = deps.output.getWriter();
  const write = (s: string) => writer.write(encoder.encode(s));

  let state = confirmState(question, defaultYes);
  await write(confirmLine(state));

  const raw = deps.raw ?? false;
  if (raw) {
    try {
      Deno.stdin.setRaw(true);
    } catch { /* not a TTY: fall through, keys still arrive on Enter */ }
  }

  const reader = deps.input.getReader();
  const decoder = new KeyDecoder();
  try {
    while (!state.done) {
      const { value, done } = await reader.read();
      if (done) break;
      for (const k of decoder.push(value)) {
        state = confirmReduce(state, k);
        if (state.done) break;
      }
    }
  } finally {
    reader.releaseLock();
    if (raw) {
      try {
        Deno.stdin.setRaw(false);
      } catch { /* already restored */ }
    }
    const choice = state.answer ? 'yes' : 'no';
    await write(`${choice}\n`);
    writer.releaseLock();
  }
  return state.answer ?? false;
}
