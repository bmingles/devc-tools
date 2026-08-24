// Where core's user-facing notices go.
//
// A handful of sites in `container.ts`, `default_config.ts` and `overlay.ts` have something to
// say to a human — an ignored template file, a mount that could not be injected, the build output
// of a failed `devcontainer up`. Under the `devc` CLI the right destination is the terminal, and
// that is what they used to do directly (`console.log` / `console.error`). In-process inside
// another program's TUI it is the wrong destination twice over: the text lands in *that* program's
// stdout and stderr, corrupting its display, and the consumer has no way to show it where it
// belongs.
//
// A module-level sink rather than a field on `StartOptions`: the call sites sit at varying depths
// across three modules, several inside otherwise-pure helpers (`injectBridgeMount`,
// `overlayDirFrom`, `loadResolvedRemoteEnv`) that no `StartOptions` reaches. Threading a parameter
// to all of them would put a logging argument on functions that have no other reason to know a
// caller exists. There is exactly one core instance per process and exactly one consumer driving
// it, so one sink per process is the honest shape.

/**
 * Severity of a core message, and — for the default sink — which stream it goes to.
 *
 * Two levels, because two is what the CLI's stdout/stderr split needs and no call site wants a
 * third. This is core's own vocabulary, not a general logging framework: no `debug`, no `error`
 * (a failure core cannot continue past is a thrown `Error`, not a log line).
 */
export type LogLevel = 'notice' | 'warning';

/** A sink for core's user-facing output. Receives every message as a value. */
export type Logger = (level: LogLevel, message: string) => void;

/**
 * The default sink, reproducing what every call site did before this module existed: `notice` on
 * stdout, `warning` on stderr. `console.*` is looked up per call rather than captured once, so a
 * test that swaps `console.error` still sees the message (`tests/overlay_test.ts` does exactly
 * that).
 */
const consoleLogger: Logger = (level, message) => {
  if (level === 'warning') console.error(message);
  else console.log(message);
};

let current: Logger = consoleLogger;

/**
 * Route core's user-facing output to `logger`; `null` restores the console default.
 *
 * Process-global and meant to be called once, at load, by a library consumer that owns the
 * terminal. The `devc` CLI never calls this — the default *is* its behavior, which is what keeps
 * its output byte-identical.
 */
export function setLogger(logger: Logger | null): void {
  current = logger ?? consoleLogger;
}

/** Emit a `notice` — informational, stdout under the default sink. */
export function logNotice(message: string): void {
  current('notice', message);
}

/** Emit a `warning` — something was skipped or degraded, stderr under the default sink. */
export function logWarning(message: string): void {
  current('warning', message);
}
