export interface AttachArgs {
  /** The path argument, if given. Callers should default to `Deno.cwd()` when absent. */
  target?: string;
  rebuild: boolean;
  /** When true, keep attach/build output on screen (skip the first-prompt clear). */
  noClear: boolean;
}

/** Parses `devc attach` / `devc claude` / `devc copilot` / `devc pi` arguments. */
export function parseAttachArgs(args: string[]): AttachArgs {
  const rebuild = args.includes('--build');
  const noClear = args.includes('--no-clear');
  const target = args.find((a) => !a.startsWith('--'));
  return { target, rebuild, noClear };
}

export interface UpArgs {
  /** The path argument, if given. Callers should default to `Deno.cwd()` when absent. */
  target?: string;
  /**
   * Print the merged effective config and exit, starting nothing.
   *
   * The effective config is generated into `~/.cache/devc/projects/<key>/`, not the project, so
   * this is how you read what devc will actually run — before the first `up`, and without
   * hunting for a cache path.
   */
  printConfig: boolean;
  json: boolean;
}

/** Parses `devc up` arguments. */
export function parseUpArgs(args: string[]): UpArgs {
  const printConfig = args.includes('--print-config');
  const json = args.includes('--json');
  const target = args.find((a) => !a.startsWith('--'));
  return { target, printConfig, json };
}

export interface BuildArgs {
  /** The path argument, if given. Callers should default to `Deno.cwd()` when absent. */
  target?: string;
  /** Drop the Docker layer cache for the image build (`--build-no-cache`). */
  noCache: boolean;
  json: boolean;
}

/** Parses `devc build` arguments. */
export function parseBuildArgs(args: string[]): BuildArgs {
  const noCache = args.includes('--no-cache');
  const json = args.includes('--json');
  const target = args.find((a) => !a.startsWith('--'));
  return { target, noCache, json };
}
