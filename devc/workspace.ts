// The `.code-workspace` file: read, create-on-demand, and rewrite the `devc:folders`
// fence in `folders`.
//
// Unlike the devcontainer file this one is auto-created when missing — it holds nothing but
// a folder list, so there is nothing to get wrong. The `{ "path": "." }` entry deliberately
// sits *outside* the fence: the current workspace dir is already the workspace root, so
// devc must never emit it as a folder.

import { writeBlocks } from "./jsonc_edit.ts";
import { wrapFenceError } from "./devcontainer.ts";

export const FOLDERS_FENCE = "folders";
const FOLDERS_KEY = "folders";

export const WORKSPACE_TEMPLATE = `{
  "folders": [
    { "path": "." }
    // >>> devc:folders (managed - do not edit)
    // <<< devc:folders
  ]
}
`;

/** Rewrite the `folders` fence. Pure: returns the new source. */
export function applyWorkspace(src: string, folderLines: string[], path: string): string {
  try {
    return writeBlocks(src, FOLDERS_KEY, [{ id: FOLDERS_FENCE, lines: folderLines }]);
  } catch (e) {
    throw wrapFenceError(e, path);
  }
}
