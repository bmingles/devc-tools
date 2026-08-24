// The seam between core and its one genuinely host-specific dependency, the devcontainer CLI.
//
// `@devcontainers/cli` ships no programmatic API — importing it *runs* the CLI against
// `process.argv` and finishes with `process.exit()` (see `devc/devcontainer_selfexec.ts` for the
// full story). So every caller of the CLI needs a child process, and where that child comes from
// differs by host:
//
// - Under Node, it is an ordinary file in an ordinary interpreter: `process.execPath` plus the
//   `devcontainer.js` resolved out of `node_modules` (a `dependencies` entry of this package).
//   That is {@link nodeDevcontainerRunner}, the default here.
// - Under a `deno compile` binary there is no such file to resolve — the package lives in a VFS
//   with no path a separate process could open — so `devc` binds its own runner that self-execs
//   with a hidden subcommand instead. See `devc/devcontainer_selfexec.ts`.

import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { output } from './exec.ts';

/** What a caller needs from the devcontainer CLI: run it, get its stdout back. */
export interface DevcontainerRunner {
  /**
   * Runs the devcontainer CLI with `args` and resolves with its exit code and captured stdout —
   * stdout because the final line is the outcome JSON every caller parses. Where stderr goes is
   * each implementation's business (inherited by default; see
   * {@link createNodeDevcontainerRunner}).
   */
  run(args: string[]): Promise<{ code: number; stdout: string }>;
}

let cachedDevcontainerJsPath: string | undefined;

/**
 * Absolute path of the `devcontainer.js` entry point inside the `@devcontainers/cli` package.
 * Resolved via `import.meta.resolve`, which — for this one subpath — is mapped in
 * `devc-core/deno.json`'s `imports` for `deno test`/`deno check`, and needs no such mapping
 * under Node, whose native ESM resolver walks `node_modules` on its own.
 *
 * Exported because a consumer building its own runner needs the same path, and the only other
 * way to get it is to re-derive it through this package's internals
 * (`createRequire(import.meta.resolve('@devc-tools/core'))`) — a dependency on where core's
 * bundle happens to sit on disk, which is not a thing core should let anyone depend on.
 */
export function devcontainerJsPath(): string {
  if (cachedDevcontainerJsPath === undefined) {
    cachedDevcontainerJsPath = fileURLToPath(
      import.meta.resolve('@devcontainers/cli/devcontainer.js'),
    );
  }
  return cachedDevcontainerJsPath;
}

/**
 * Build a {@link DevcontainerRunner} that spawns `process.execPath` against the resolved
 * `devcontainer.js`, exactly as running `devcontainer <args>` from PATH used to.
 *
 * With no options, stdout is piped (the caller parses it) and stderr is **inherited** — the CLI's
 * progress and build output goes straight to the terminal, which is right for a CLI and is what
 * {@link nodeDevcontainerRunner} has always done.
 *
 * With `onStderr`, stderr is piped instead and each chunk is handed over as it arrives. That is
 * the only way a consumer holding the terminal — a TUI calling `startContainer` in-process — can
 * both keep its display intact and still show `devcontainer up`'s progress, which on a cold build
 * is minutes of the only feedback there is. A factory rather than a mutable field on the exported
 * runner, so two callers in one process cannot fight over it.
 */
export function createNodeDevcontainerRunner(
  opts: { onStderr?: (chunk: Uint8Array) => void } = {},
): DevcontainerRunner {
  const { onStderr } = opts;
  return {
    async run(args) {
      const { code, stdout } = await output(process.execPath, {
        args: [devcontainerJsPath(), ...args],
        stdout: 'piped',
        // Piping is what makes the chunks reachable at all; without a sink there is nothing to
        // hand them to, and inheriting keeps the stream out of this process entirely.
        stderr: onStderr ? 'piped' : 'inherit',
        onStderr,
      });
      return { code, stdout: new TextDecoder().decode(stdout) };
    },
  };
}

/**
 * The default {@link DevcontainerRunner} — {@link createNodeDevcontainerRunner} with no options,
 * i.e. stdout piped and stderr inherited. Unchanged binding: everything that imported this before
 * the factory existed gets exactly the same behavior.
 */
export const nodeDevcontainerRunner: DevcontainerRunner =
  createNodeDevcontainerRunner();
