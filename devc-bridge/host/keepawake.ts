// Keepalive state machine: a ping resets an idle timer; the allowlisted keepawake
// command (e.g. `caffeinate`) runs while the timer is unexpired. This is the whole
// feature — see .plans/archived/devc-bridge-keepawake.md for the design rationale
// and the alternatives that were deliberately not built (status file, sweep loop,
// marker reconciliation, tray countdown).
//
// The timer is the only reaper: each ping() clears and re-arms one setTimeout(idleMs).
// There is no polling loop, so expiry is exact rather than "within one sweep."

export interface KeepawakeOptions {
  /** Allowlisted script to drive, e.g. "caffeinate". */
  command: string;
  /** Stop after this much ping silence. */
  idleMs: number;
  /** Dispatch seam — core's script dispatch (runs the allowlisted script). */
  run: (command: string, args: string[]) => Promise<unknown>;
  log?: (msg: string) => void;
}

export interface KeepawakeStatus {
  /** Keepalive currently holding the command started. */
  active: boolean;
  /** Epoch ms of last ping; 0 = never pinged. */
  lastPingAt: number;
  /** Last ping's event label, if any. */
  lastEvent: string | null;
  idleMs: number;
  /** ms until auto-stop; 0 when inactive. */
  remainingMs: number;
}

export class Keepawake {
  #command: string;
  #idleMs: number;
  #run: (command: string, args: string[]) => Promise<unknown>;
  #log: (msg: string) => void;

  #armed = false;
  #lastPingAt = 0;
  #lastEvent: string | null = null;
  #timer: ReturnType<typeof setTimeout> | undefined;
  /** Promise tail — start/stop dispatches run in issue order and never overlap. */
  #queue: Promise<void> = Promise.resolve();

  constructor(opts: KeepawakeOptions) {
    this.#command = opts.command;
    this.#idleMs = opts.idleMs;
    this.#run = opts.run;
    this.#log = opts.log ?? (() => {});
  }

  /** Record activity. Never blocks the caller and never throws. */
  ping(event?: string): void {
    this.#lastPingAt = Date.now();
    this.#lastEvent = event ?? null;
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.#expire(), this.#idleMs);
    if (!this.#armed) {
      this.#armed = true;
      this.#enqueue(['start']);
    }
  }

  status(): KeepawakeStatus {
    const remainingMs = this.#armed
      ? Math.max(0, this.#lastPingAt + this.#idleMs - Date.now())
      : 0;
    return {
      active: this.#armed,
      lastPingAt: this.#lastPingAt,
      lastEvent: this.#lastEvent,
      idleMs: this.#idleMs,
      remainingMs,
    };
  }

  /** Clear the timer; if active, stop the command (awaited). */
  async close(): Promise<void> {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    if (this.#armed) {
      this.#armed = false;
      this.#enqueue(['stop']);
    }
    await this.#queue;
  }

  #expire(): void {
    this.#armed = false;
    this.#enqueue(['stop']);
  }

  #enqueue(args: string[]): void {
    this.#queue = this.#queue
      .then(() => this.#run(this.#command, args))
      .then(() => {})
      .catch((e) => {
        this.#log(
          `keepawake: ${this.#command} ${args.join(' ')} failed: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      });
  }
}
