// `devc init` — scaffold the bundled default `.devcontainer/` into a project, non-interactively.
// The same files `devc config` writes on first creation, minus the wizard and minus the two
// managed mount fences; a later `devc config` inserts those into a fence-less config.

import { readdir } from 'node:fs/promises';
import {
  findOwnDevcontainerConfig,
  installBundledAssets,
} from './default_config.ts';
import { isNotFound } from './errors.ts';

export interface InitResult {
  /** Path of the written `devcontainer.json`. */
  configPath: string;
  /** Every top-level path written, in write order (config first). */
  written: string[];
}

/** Sorted names of everything in `dir` (files, directories, dotfiles); `[]` when it is absent. */
async function entryNames(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir);
    return entries.sort();
  } catch (err) {
    if (isNotFound(err)) return [];
    throw err;
  }
}

/** `a, b, c, +2 more` — keeps the error line readable for a crowded directory. */
function summarize(names: string[], limit = 4): string {
  const shown = names.slice(0, limit).join(', ');
  return names.length > limit
    ? `${shown}, +${names.length - limit} more`
    : shown;
}

/**
 * Write the bundled default `.devcontainer/` into `projectDir` via {@link installBundledAssets}:
 * `devcontainer.json` verbatim (comments preserved, no `devc:source`/`devc:skills` fences) plus
 * every other bundled asset.
 *
 * The user template layer applies: any file in `templatesDir` overrides the same-named bundled
 * one. It defaults to the real `~/.config/devc/templates` and only needs overriding in tests.
 *
 * Throws without writing anything unless `.devcontainer/` is missing or completely empty:
 *
 * - An existing devcontainer config gets its own message pointing at `devc config`. Both config
 *   locations count — creating `.devcontainer/devcontainer.json` next to an existing root
 *   `.devcontainer.json` would leave two configs and make which one applies ambiguous.
 * - *Any* other content — a file, a subdirectory, a dotfile — also refuses. `installBundledAssets`
 *   overwrites only the paths the bundle contains, so scaffolding into an occupied directory would
 *   silently replace a hand-written `Dockerfile` or `scripts/*.sh` while leaving unrelated files
 *   behind as stale debris. Requiring an empty directory means what `init` produces is exactly the
 *   bundle, with nothing carried over. A lone `devc.json` overlay is no exception: `init` is a
 *   clean-slate operation, and the error already advises moving the contents aside — the overlay
 *   goes back afterwards untouched.
 */
export async function initProject(
  projectDir: string,
  templatesDir?: string,
): Promise<InitResult> {
  const devcontainerDir = `${projectDir}/.devcontainer`;

  const existing = await findOwnDevcontainerConfig(projectDir);
  if (existing !== null) {
    // Which remedy actually works depends on where the config lives. Removing just the
    // devcontainer.json from a scaffolded .devcontainer/ is not enough — the rest of the bundle
    // would still be there and trip the not-empty guard below — whereas the root form is a lone
    // file with nothing else to clear.
    const remedy = existing === `${projectDir}/.devcontainer.json`
      ? 'delete it'
      : 'delete the .devcontainer/ folder contents';
    throw new Error(
      `${existing} already exists — use \`devc config\` to change mounts, or ${remedy} and run \`devc init\` again.`,
    );
  }

  const occupants = await entryNames(devcontainerDir);
  if (occupants.length > 0) {
    throw new Error(
      `${devcontainerDir} is not empty (${
        summarize(
          occupants,
        )
      }) — devc init only writes into a missing or empty .devcontainer/. ` +
        'Move its contents aside and re-run, or hand-edit what is already there.',
    );
  }

  return {
    configPath: `${devcontainerDir}/devcontainer.json`,
    written: await installBundledAssets(devcontainerDir, templatesDir),
  };
}
