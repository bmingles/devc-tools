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
  /** Runs the devcontainer CLI with `args`; stdout captured, stderr inherited. */
  run(args: string[]): Promise<{ code: number; stdout: string }>;
}

let cachedDevcontainerJsPath: string | undefined;

/**
 * Absolute path of the `devcontainer.js` entry point inside the `@devcontainers/cli` package.
 * Resolved via `import.meta.resolve`, which — for this one subpath — is mapped in
 * `devc-core/deno.json`'s `imports` for `deno test`/`deno check`, and needs no such mapping
 * under Node, whose native ESM resolver walks `node_modules` on its own.
 */
function devcontainerJsPath(): string {
  if (cachedDevcontainerJsPath === undefined) {
    cachedDevcontainerJsPath = fileURLToPath(
      import.meta.resolve('@devcontainers/cli/devcontainer.js'),
    );
  }
  return cachedDevcontainerJsPath;
}

/**
 * The default {@link DevcontainerRunner}: spawns `process.execPath` against the resolved
 * `devcontainer.js`, exactly as running `devcontainer <args>` from PATH used to, piping stdout
 * and inheriting stderr.
 */
export const nodeDevcontainerRunner: DevcontainerRunner = {
  async run(args) {
    const { code, stdout } = await output(process.execPath, {
      args: [devcontainerJsPath(), ...args],
      stdout: 'piped',
      stderr: 'inherit',
    });
    return { code, stdout: new TextDecoder().decode(stdout) };
  },
};
