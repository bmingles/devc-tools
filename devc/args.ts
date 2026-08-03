export interface AttachArgs {
  /** The path argument, if given. Callers should default to `Deno.cwd()` when absent. */
  target?: string;
  rebuild: boolean;
  /** When true, keep attach/build output on screen (skip the first-prompt clear). */
  noClear: boolean;
}

/** Parses `devc attach` / `devc claude` arguments. */
export function parseAttachArgs(args: string[]): AttachArgs {
  const rebuild = args.includes("--build");
  const noClear = args.includes("--no-clear");
  const target = args.find((a) => !a.startsWith("--"));
  return { target, rebuild, noClear };
}
