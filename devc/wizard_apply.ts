// Applying a project wizard selection to `PATH/.devcontainer/`.
//
// The wizard owns exactly two regions of the project `devcontainer.json`'s `mounts` array:
// the `devc:source` and `devc:skills` fences. Everything else — infra mounts, the Dockerfile,
// `features/` — is written once, at first creation, from the bundled default and never
// re-asserted. On reconfigure only the two fences are rewritten (`writeBlocks`), so anything
// the user hand-edited outside them survives byte-for-byte.

import { copyBundledFeatures, loadBundledDefault } from "./default_config.ts";
import {
  loadGlobalConfig,
  makeGlobalConfig,
  saveGlobalConfig,
} from "./config.ts";
import {
  findArraySpan,
  UnterminatedFenceError,
  writeBlocks,
} from "./jsonc_edit.ts";
import { type MountRow, rowToEntry } from "./mounts.ts";

/** The wizard's selected mounts for the two managed fences. */
export interface WizardSelection {
  source: MountRow[];
  skills: MountRow[];
}

/** Where the two managed fences live in the file (`findArraySpan(src, "mounts")`). */
const MOUNTS_KEY = "mounts";

/** Rewrite (or insert) the two managed fences in `src`, preserving everything else. */
export function applyFences(src: string, selection: WizardSelection): string {
  return writeBlocks(src, MOUNTS_KEY, [
    { id: "source", lines: selection.source.map(rowToEntry) },
    { id: "skills", lines: selection.skills.map(rowToEntry) },
  ]);
}

/** Files written by an apply, for the success message. */
export interface ApplyResult {
  /** True when the project had no existing config (first creation). */
  created: boolean;
  /** Absolute path of the written `devcontainer.json`. */
  configPath: string;
  /** Paths of every file/dir written (for the success message). */
  written: string[];
}

/** True when `path` exists. */
async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return false;
    throw e;
  }
}

/** Optional overrides for `applySelection` (tests inject a scratch config path). */
export interface ApplyDeps {
  /** Global config file path for the `recentSkills` persistence. Defaults to the standard path. */
  globalConfigPath?: string;
}

/**
 * Apply `selection` to `projectDir/.devcontainer/`.
 *
 * First creation (no existing `devcontainer.json`): the bundled default text is the base; its
 * two fences are inserted + populated; the `Dockerfile` and the `features/` subtree are copied
 * verbatim (the local Feature reference `"./features/devc"` needs the subtree present).
 *
 * Update in place: only the two fences are rewritten on the existing file text; `Dockerfile`
 * and `features/` are left untouched.
 *
 * Then the applied skills host paths are persisted to `recentSkills` in the global config.
 */
export async function applySelection(
  projectDir: string,
  selection: WizardSelection,
  deps: ApplyDeps = {},
): Promise<ApplyResult> {
  const devcontainerDir = `${projectDir}/.devcontainer`;
  const configPath = `${devcontainerDir}/devcontainer.json`;
  await Deno.mkdir(devcontainerDir, { recursive: true }).catch((e) => {
    if (!(e instanceof Deno.errors.AlreadyExists)) throw e;
  });

  const created = !(await exists(configPath));
  const written: string[] = [configPath];

  let baseText: string;
  if (created) {
    const bundled = await loadBundledDefault();
    baseText = bundled.devcontainerJson;
  } else {
    baseText = await Deno.readTextFile(configPath);
  }

  let out: string;
  try {
    out = applyFences(baseText, selection);
  } catch (e) {
    if (e instanceof UnterminatedFenceError) {
      throw new Error(
        `${configPath}: ${e.message} (fix or remove the half-written fence)`,
      );
    }
    throw e;
  }
  await Deno.writeTextFile(configPath, out);

  if (created) {
    const bundled = await loadBundledDefault();
    const dockerfilePath = `${devcontainerDir}/Dockerfile`;
    await Deno.writeFile(dockerfilePath, bundled.dockerfile);
    written.push(dockerfilePath);
    const featuresDir = `${devcontainerDir}/features`;
    await copyBundledFeatures(featuresDir);
    written.push(featuresDir);
  }

  await persistRecentSkills(selection.skills, deps.globalConfigPath);

  return { created, configPath, written };
}

/** Store the applied skills host paths (raw) as the remembered list for the next project. */
async function persistRecentSkills(
  skills: MountRow[],
  globalConfigPath?: string,
): Promise<void> {
  const cfg = await loadGlobalConfig(globalConfigPath);
  const recent = skills.map((r) => r.source);
  await saveGlobalConfig(
    makeGlobalConfig(
      cfg.codeRoots,
      cfg.skillsRoots,
      cfg.path,
      cfg.extra,
      recent,
    ),
  );
}

/** Re-export so the wizard loop need not reach past this module. */
export { findArraySpan };
