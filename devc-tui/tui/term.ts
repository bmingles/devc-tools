// Terminal plumbing: raw mode, the alternate screen, the cursor, size + SIGWINCH, and one
// full-frame paint. Everything here is side effects, which is exactly why nothing else is.
//
// The contract that matters: **the terminal is always restored**. `close()` runs from a
// `finally`, and from SIGINT/SIGTERM handlers, so a thrown error prints its message to a
// normal screen with a visible cursor and echo back on. `close()` is idempotent.

export interface Size {
  columns: number;
  rows: number;
}

export interface TerminalOptions {
  output: WritableStream<Uint8Array>;
  /** Enter raw mode + the alternate screen. False for scripted tests (no TTY involved). */
  raw: boolean;
  /** Size source; defaults to `Deno.consoleSize()` with an 80x24 fallback. */
  size?: () => Size;
}

const ENTER = "\x1b[?1049h\x1b[?25l"; // alternate screen, hide cursor
const LEAVE = "\x1b[?25h\x1b[?1049l"; // show cursor, normal screen

const SIGNALS: Deno.Signal[] = ["SIGINT", "SIGTERM"];

export class Terminal {
  #writer: WritableStreamDefaultWriter<Uint8Array>;
  #encoder = new TextEncoder();
  #raw: boolean;
  #size: () => Size;
  #closed = false;
  #resize: (() => void) | null = null;
  #onWinch = () => this.#resize?.();
  #onSignal = () => {
    void this.close().finally(() => Deno.exit(130));
  };

  private constructor(opts: TerminalOptions) {
    this.#writer = opts.output.getWriter();
    this.#raw = opts.raw;
    this.#size = opts.size ?? defaultSize;
  }

  /** Take the terminal over. Always pair with `close()` in a `finally`. */
  static async open(opts: TerminalOptions): Promise<Terminal> {
    const term = new Terminal(opts);
    if (opts.raw) {
      Deno.stdin.setRaw(true);
      for (const signal of SIGNALS) {
        try {
          Deno.addSignalListener(signal, term.#onSignal);
        } catch {
          // Not every platform has every signal; losing one only costs us a tidy exit.
        }
      }
      await term.write(ENTER);
    }
    return term;
  }

  size(): Size {
    return this.#size();
  }

  /** Repaint on SIGWINCH. Only one callback: the app has one frame. */
  onResize(cb: () => void): void {
    this.#resize = cb;
    if (!this.#raw) return;
    try {
      Deno.addSignalListener("SIGWINCH", this.#onWinch);
    } catch {
      // No SIGWINCH here (Windows): the next keystroke repaints at the new size.
    }
  }

  async write(text: string): Promise<void> {
    if (this.#closed) return;
    await this.#writer.write(this.#encoder.encode(text));
  }

  /** Draw one whole frame: home, then every line, each cleared to the right. */
  async paint(lines: string[]): Promise<void> {
    await this.write(frame(lines));
  }

  /** Restore everything. Safe to call twice. */
  async close(): Promise<void> {
    if (this.#closed) return;
    if (this.#raw) {
      await this.write(LEAVE);
      try {
        Deno.stdin.setRaw(false);
      } catch {
        // stdin already gone; nothing left to restore.
      }
      for (const signal of SIGNALS) {
        try {
          Deno.removeSignalListener(signal, this.#onSignal);
        } catch { /* never added */ }
      }
      if (this.#resize !== null) {
        try {
          Deno.removeSignalListener("SIGWINCH", this.#onWinch);
        } catch { /* never added */ }
      }
    }
    this.#closed = true;
    try {
      await this.#writer.close();
    } catch {
      // A closed or detached stdout is not an error worth reporting on the way out.
    }
  }
}

/** The bytes of one frame. Exported for tests. */
export function frame(lines: string[]): string {
  return "\x1b[H" + lines.join("\x1b[K\r\n") + "\x1b[K";
}

function defaultSize(): Size {
  try {
    return Deno.consoleSize();
  } catch {
    return { columns: 80, rows: 24 };
  }
}
