// The devcontainer file: read, create-on-demand, and rewrite its two fences in `mounts`.
//
// devc owns `devc:projects` and `devc:skills` and nothing else in the file. A
// missing devcontainer.json is a hard error unless the caller asked for `--create`, because
// silently inventing an image for someone's project is not a favor.

import { basename } from "jsr:@std/path@^1";
import { RuntimeError } from "./config.ts";
import { UnterminatedFenceError, writeBlocks } from "./jsonc_edit.ts";

export const PROJECTS_FENCE = "projects";
export const SKILLS_FENCE = "skills";
const MOUNTS_KEY = "mounts";

/** Read the file, or null when it does not exist. */
export async function readFileOrNull(path: string): Promise<string | null> {
  try {
    return await Deno.readTextFile(path);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return null;
    throw e;
  }
}

/** Starter devcontainer.json, with both fences already in place. */
export function devcontainerTemplate(workspaceDir: string): string {
  return `{
  // Created by devc. Set the image/build and everything else to taste;
  // devc only ever rewrites the fenced blocks below.
  "name": ${JSON.stringify(basename(workspaceDir))},
  "image": "mcr.microsoft.com/devcontainers/base:ubuntu",
  "mounts": [
    // >>> devc:projects (managed - do not edit)
    // <<< devc:projects
    // >>> devc:skills (managed - do not edit)
    // <<< devc:skills
  ]
}
`;
}

/** Rewrite both `mounts` fences. Pure: returns the new source. */
export function applyDevcontainer(
  src: string,
  projectLines: string[],
  skillLines: string[],
  path: string,
): string {
  try {
    return writeBlocks(src, MOUNTS_KEY, [
      { id: PROJECTS_FENCE, lines: projectLines },
      { id: SKILLS_FENCE, lines: skillLines },
    ]);
  } catch (e) {
    throw wrapFenceError(e, path);
  }
}

/** Turn a fence error into the user-facing message naming the file. */
export function wrapFenceError(e: unknown, path: string): unknown {
  if (e instanceof UnterminatedFenceError) {
    return new RuntimeError(`devc: unterminated devc:${e.fenceId} fence in ${path}`);
  }
  return e;
}
