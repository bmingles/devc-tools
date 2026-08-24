// The `child_process` adapter `container.ts` needs — a drop-in for the two subprocess shapes it
// used to reach for directly through the Deno runtime's own `Command` API: run to completion
// capturing output (`.output()`), and run with every stream inherited (`.spawn().status`).
// Nothing more; this is not a general subprocess library.

import { spawn } from 'node:child_process';

/** Per-stream disposition, matching the vocabulary that old `Command` API used. */
export type Stdio = 'piped' | 'inherit' | 'null';

export interface CommandOptions {
  args?: string[];
  stdin?: Stdio;
  stdout?: Stdio;
  stderr?: Stdio;
}

export interface CommandOutput {
  code: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
}

function toNodeStdio(mode: Stdio | undefined): 'pipe' | 'inherit' | 'ignore' {
  switch (mode) {
    case 'piped':
      return 'pipe';
    case 'inherit':
      return 'inherit';
    case 'null':
    case undefined:
      return 'ignore';
  }
}

/**
 * Runs `cmd` to completion, mirroring the old `Command(cmd, opts).output()`: resolves with the
 * exit code and whichever of stdout/stderr were `'piped'` (empty otherwise).
 */
export function output(
  cmd: string,
  opts: CommandOptions = {},
): Promise<CommandOutput> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, opts.args ?? [], {
      stdio: [
        toNodeStdio(opts.stdin),
        toNodeStdio(opts.stdout),
        toNodeStdio(opts.stderr),
      ],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout?.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({
        code: code ?? -1,
        stdout: new Uint8Array(Buffer.concat(stdoutChunks)),
        stderr: new Uint8Array(Buffer.concat(stderrChunks)),
      });
    });
  });
}

/**
 * Runs `cmd` and resolves with just its exit code, mirroring the old
 * `Command(cmd, opts).spawn().status`. Used for the interactive case (`execInContainer`), where
 * every stream is inherited and nothing is captured.
 */
export function status(
  cmd: string,
  opts: CommandOptions = {},
): Promise<{ code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, opts.args ?? [], {
      stdio: [
        toNodeStdio(opts.stdin),
        toNodeStdio(opts.stdout),
        toNodeStdio(opts.stderr),
      ],
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1 }));
  });
}
