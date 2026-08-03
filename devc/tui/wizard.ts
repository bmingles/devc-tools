// The shell around the pure wizard core: own the terminal, feed bytes to the decoder, hand
// keys to `reduce`, and perform the effects (`save` / `quit` / `none`). All IO is injected,
// so `wizard_state_test.ts` scripts a key sequence and asserts effects with no TTY in sight,
// and this loop can drive a headless input stream in tests (`raw` off).

import {
  globalConfigExists,
  loadGlobalConfig,
  makeGlobalConfig,
  saveGlobalConfig,
} from "../config.ts";
import { KeyDecoder } from "./keys.ts";
import { type Size, Terminal } from "./term.ts";
import { colorEnabled, render } from "./wizard_render.ts";
import { initialGlobalState, reduce, type WizardState } from "./wizard_state.ts";

export const NOT_A_TERMINAL =
  "devc: not a terminal; the config wizard needs an interactive terminal";

/** Injected IO so the loop can run and be observed headlessly. */
export interface WizardIo {
  err: (msg: string) => void;
}

/** Injected runtime dependencies (all overridable for tests). */
export interface WizardDeps {
  input: ReadableStream<Uint8Array>;
  output: WritableStream<Uint8Array>;
  size: () => Size;
  /** Enter raw mode + the alternate screen. Off in tests. */
  raw?: boolean;
  /** Overridable so tests can prove the non-TTY refusal without a TTY. */
  isTerminal?: () => boolean;
  /** Persist the config on Apply. Defaults to `saveGlobalConfig` at the standard path. */
  save?: (codeRoots: string[], skillsRoots: string[]) => Promise<void>;
}

export interface WizardOptions {
  /** Initial code roots (raw). */
  codeRoots: string[];
  /** Initial skills roots (raw). */
  skillsRoots: string[];
  noColor?: boolean;
}

/** Outcome of a wizard run: whether the user applied (saved) or cancelled. */
export interface WizardResult {
  applied: boolean;
}

/**
 * Run the global-config wizard to completion. The terminal is always restored (via
 * `term.close()` in a `finally`); no exit path bypasses it. Refuses to enter raw mode
 * against a non-TTY with a clear message.
 */
export async function startWizard(
  opts: WizardOptions,
  io: WizardIo,
  deps: WizardDeps,
): Promise<WizardResult> {
  const raw = deps.raw ?? false;
  if (raw) {
    const isTerminal = deps.isTerminal ??
      (() => Deno.stdin.isTerminal() && Deno.stdout.isTerminal());
    if (!isTerminal()) {
      io.err(NOT_A_TERMINAL);
      return { applied: false };
    }
  }

  const save = deps.save ??
    (async (codeRoots: string[], skillsRoots: string[]) => {
      await saveGlobalConfig(makeGlobalConfig(codeRoots, skillsRoots));
    });

  let state: WizardState = initialGlobalState(
    opts.codeRoots,
    opts.skillsRoots,
    colorEnabled(opts.noColor),
  );

  const term = await Terminal.open({ output: deps.output, raw, size: deps.size });
  const paint = async () => {
    await term.paint(render(state, term.size()));
  };

  let applied = false;
  try {
    term.onResize(() => void paint());
    await paint();

    const decoder = new KeyDecoder();
    loop: for await (const chunk of deps.input) {
      for (const k of decoder.push(chunk)) {
        const step = reduce(state, k);
        state = step.state;
        switch (step.effect.type) {
          case "none":
            break;
          case "save":
            await save(step.effect.codeRoots, step.effect.skillsRoots);
            applied = true;
            break loop;
          case "quit":
            break loop;
        }
        await paint();
      }
    }
  } finally {
    await term.close();
  }
  return { applied };
}

/**
 * Open the global-config editor for `devc config` (and the first-run flow), seeded from the
 * current on-disk config. Enters raw mode against the real TTY.
 */
export async function runGlobalConfigWizard(io: WizardIo): Promise<WizardResult> {
  const cfg = await loadGlobalConfig();
  return await startWizard(
    { codeRoots: cfg.codeRoots, skillsRoots: cfg.skillsRoots },
    io,
    {
      input: Deno.stdin.readable,
      output: Deno.stdout.writable,
      size: () => Deno.consoleSize(),
      raw: true,
    },
  );
}

/** Re-export so callers do not reach past this module to the config layer. */
export { globalConfigExists };
