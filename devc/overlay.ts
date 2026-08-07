// The `devc.json` overlay: an optional, devc-only file contributing `mounts`,
// `additionalFeatures` and `remoteEnv` on top of whichever `devcontainer.json` is in play.
//
// The governing invariant: **whatever lands in `.devcontainer/` must run without `devc`
// installed at all.** That is why the overlay is applied as `devcontainer up` CLI args and never
// as a file rewrite — nothing in this module writes to a project's `devcontainer.json`. A
// checkout without `devc` still builds and runs from the standard config; it just does not get
// the overlay's extra mounts, features and env. Un-augmented, not broken.
//
// The overlay serves two equally valid shapes, and neither is canonical:
//
// - **Committed** — the repo has adopted `devc` as a tool it depends on.
// - **Gitignored** — an individual dev adds bind mounts for their own machine, in a repo that
//   need not know `devc` exists. Because the overlay is invisible to the repo, the
//   `.devcontainer/` everyone else checks out is untouched by definition.

import { parse as parseJsonc } from "jsr:@std/jsonc";
import { CONFIG_DIR, substituteVars } from "./default_config.ts";

/** The merged, validated contents of the overlay layer. Every field is always present. */
export interface DevcOverlay {
  /** Docker `--mount` specs, in merged order (user entries first). */
  mounts: string[];
  /** Feature id → options, merged per feature id (whole-value replace, no deep merge). */
  additionalFeatures: Record<string, unknown>;
  /** Container env, merged per key. */
  remoteEnv: Record<string, string>;
}

/** The only three keys the overlay understands. Anything else warns and is ignored. */
const OVERLAY_KEYS = ["mounts", "additionalFeatures", "remoteEnv"] as const;

/**
 * Project-level overlay locations, relative to the project folder, in first-hit-wins order.
 *
 * Both directories are first-class and behave identically. `.devcontainer/devc.json` often suits
 * a gitignored local override — one file to ignore, sitting beside the config it overlays —
 * while `.devc/` suits a repo that wants `devc`'s files grouped in one place.
 */
const PROJECT_CANDIDATES = [
  ".devc/devc.jsonc",
  ".devc/devc.json",
  ".devcontainer/devc.jsonc",
  ".devcontainer/devc.json",
] as const;

/** User-level overlay filenames, relative to the global config dir, in first-hit-wins order. */
const USER_CANDIDATES = ["devc.jsonc", "devc.json"] as const;

/** An overlay contributing nothing. */
export function emptyOverlay(): DevcOverlay {
  return { mounts: [], additionalFeatures: {}, remoteEnv: {} };
}

/** True when `overlay` would emit no `devcontainer up` args at all. */
export function isEmptyOverlay(overlay: DevcOverlay): boolean {
  return overlay.mounts.length === 0 &&
    Object.keys(overlay.additionalFeatures).length === 0 &&
    Object.keys(overlay.remoteEnv).length === 0;
}

async function firstExisting(paths: readonly string[]): Promise<string | null> {
  for (const path of paths) {
    try {
      await Deno.stat(path);
      return path;
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) throw err;
    }
  }
  return null;
}

/**
 * Path of `localFolder`'s project overlay — `.devc/devc.jsonc`, `.devc/devc.json`,
 * `.devcontainer/devc.jsonc`, `.devcontainer/devc.json`, first hit wins — or `null` when it has
 * none. Only the winner is ever read; the losers are *not* merged.
 */
export function findProjectOverlayPath(
  localFolder: string,
): Promise<string | null> {
  return firstExisting(
    PROJECT_CANDIDATES.map((rel) => `${localFolder}/${rel}`),
  );
}

/**
 * Path of the user-level overlay — `~/.config/devc/devc.jsonc` then
 * `~/.config/devc/devc.json` — or `null` when neither exists. `configDir` defaults to the real
 * global config dir and only needs overriding in tests.
 */
export function findUserOverlayPath(
  configDir: string = CONFIG_DIR,
): Promise<string | null> {
  return firstExisting(USER_CANDIDATES.map((name) => `${configDir}/${name}`));
}

function typeError(path: string, detail: string): Error {
  return new Error(`${path}: ${detail}`);
}

/**
 * True when `text` contains nothing but whitespace and comments — a stub file the user created
 * and has not filled in yet, which is "no overlay" rather than a syntax error.
 *
 * The comment stripping is naive (it does not respect string literals), which is fine for this
 * question alone: any file with a real token keeps at least one character — a string literal's
 * own quote survives the `//`-to-end-of-line cut — so a file with content never reads as blank.
 */
function isTokenFree(text: string): boolean {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")
    .trim() === "";
}

function readMounts(path: string, value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw typeError(path, '"mounts" must be an array of mount-spec strings');
  }
  return value.map((entry, i) => {
    if (typeof entry !== "string") {
      throw typeError(path, `"mounts"[${i}] must be a string`);
    }
    return entry;
  });
}

function readObject(
  path: string,
  key: string,
  value: unknown,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw typeError(path, `"${key}" must be an object`);
  }
  return value as Record<string, unknown>;
}

function readRemoteEnv(
  path: string,
  value: unknown,
): Record<string, string> {
  const obj = readObject(path, "remoteEnv", value);
  return Object.fromEntries(
    Object.entries(obj).map(([k, v]) => {
      if (typeof v !== "string") {
        throw typeError(path, `"remoteEnv"."${k}" must be a string`);
      }
      return [k, v];
    }),
  );
}

/**
 * Parse one overlay file, whatever its extension: both `.json` and `.jsonc` go through
 * `parseJsonc`, so the suffix is naming convention only.
 *
 * Parsing is deliberately *unforgiving*, the opposite of {@link
 * import("./default_config.ts").loadResolvedRemoteEnv}'s treatment of a project's own
 * `devcontainer.json`. This file exists only for `devc`, is small and hand-written, and its
 * whole purpose is to add mounts: silently starting a container without them is worse than a
 * hard error naming the file. Unknown top-level keys are the one exception — those warn and are
 * ignored, so a typo like `"mount"` is visible without being fatal.
 *
 * A file with no JSON tokens at all — empty, whitespace, or only comments, i.e. one a user has
 * created but not filled in — counts as no overlay rather than an error. It has to be caught
 * before `parseJsonc`, which reports "unexpected end of JSONC input" for it exactly as it does
 * for a genuinely truncated file.
 */
export async function loadOverlayFile(path: string): Promise<DevcOverlay> {
  const text = await Deno.readTextFile(path);
  if (isTokenFree(text)) return emptyOverlay();

  let parsed: unknown;
  try {
    parsed = parseJsonc(text);
  } catch (err) {
    throw typeError(
      path,
      `could not parse as JSONC (${err instanceof Error ? err.message : err})`,
    );
  }

  // `parseJsonc` yields `null` for an empty (or whitespace/comment-only) file.
  if (parsed === null || parsed === undefined) return emptyOverlay();
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw typeError(path, "expected a JSON object at the top level");
  }

  const raw = parsed as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!(OVERLAY_KEYS as readonly string[]).includes(key)) {
      console.error(
        `devc: ignoring unknown key "${key}" in ${path} (known keys: ${
          OVERLAY_KEYS.join(", ")
        })`,
      );
    }
  }

  return {
    mounts: raw.mounts === undefined ? [] : readMounts(path, raw.mounts),
    additionalFeatures: raw.additionalFeatures === undefined
      ? {}
      : readObject(path, "additionalFeatures", raw.additionalFeatures),
    remoteEnv: raw.remoteEnv === undefined
      ? {}
      : readRemoteEnv(path, raw.remoteEnv),
  };
}

/**
 * Merge the user overlay under the project overlay. The project wins because it is the more
 * specific statement about *this* repo:
 *
 * - `mounts` concatenate, user entries first — a mount is additive, so there is nothing to win.
 * - `remoteEnv` overrides per key.
 * - `additionalFeatures` merges per feature id, whole-value replace. A feature's options object
 *   is *not* deep-merged: half a project's options silently blended with half the user's would
 *   be far harder to reason about than "the project's entry replaces the user's".
 */
export function mergeOverlays(
  user: DevcOverlay,
  project: DevcOverlay,
): DevcOverlay {
  return {
    mounts: [...user.mounts, ...project.mounts],
    additionalFeatures: {
      ...user.additionalFeatures,
      ...project.additionalFeatures,
    },
    remoteEnv: { ...user.remoteEnv, ...project.remoteEnv },
  };
}

/**
 * The effective overlay for `localFolder`: the user-level file merged under the project-level
 * one. Applies in *both* modes — a project with its own `devcontainer.json` gets the overlay
 * just as the zero-config path does.
 *
 * `configDir` defaults to the real `~/.config/devc` and only needs overriding in tests.
 */
export async function loadMergedOverlay(
  localFolder: string,
  configDir: string = CONFIG_DIR,
): Promise<DevcOverlay> {
  const [userPath, projectPath] = await Promise.all([
    findUserOverlayPath(configDir),
    findProjectOverlayPath(localFolder),
  ]);
  const [user, project] = await Promise.all([
    userPath === null ? emptyOverlay() : loadOverlayFile(userPath),
    projectPath === null ? emptyOverlay() : loadOverlayFile(projectPath),
  ]);
  return mergeOverlays(user, project);
}

/**
 * The `devcontainer up` args `overlay` implies, appended after devc's own args:
 *
 * 1. `--mount <spec>`, one per merged mount entry, in merged order — these *append* to the base
 *    config's `mounts[]`.
 * 2. `--additional-features <json>`, a single arg; the devcontainer CLI merges it into the base
 *    config's `features`. Omitted entirely when the merged object is empty.
 * 3. `--remote-env KEY=value`, one per entry — these *override* the base's `remoteEnv` per key.
 *
 * Mount specs and `remoteEnv` values are substituted here because both reach Docker without
 * passing through the CLI's own substitution. `additionalFeatures` is deliberately *not*
 * substituted: that JSON is merged into the config by the CLI and goes through its substitution
 * pipeline, so pre-resolving would double-resolve.
 *
 * `containerWorkspaceFolder` must be the pre-`up` value from
 * `computeContainerWorkspaceFolder` — these args have to exist before `devcontainer up` runs, so
 * the authoritative `remoteWorkspaceFolder` it reports back is not available yet.
 */
export function overlayArgs(
  overlay: DevcOverlay,
  containerWorkspaceFolder: string,
  localWorkspaceFolder?: string,
): string[] {
  const sub = (v: string) =>
    substituteVars(v, containerWorkspaceFolder, localWorkspaceFolder);

  const args: string[] = [];
  for (const mount of overlay.mounts) args.push("--mount", sub(mount));
  if (Object.keys(overlay.additionalFeatures).length > 0) {
    args.push(
      "--additional-features",
      JSON.stringify(overlay.additionalFeatures),
    );
  }
  for (const [key, value] of Object.entries(overlay.remoteEnv)) {
    args.push("--remote-env", `${key}=${sub(value)}`);
  }
  return args;
}

/**
 * `overlay.remoteEnv` with its values substituted — the layer `devc exec`/`attach` apply on top
 * of the base config's own `remoteEnv`, since `docker exec` never sees `remoteEnv` at all.
 *
 * Unlike {@link overlayArgs}, this runs *after* `devcontainer up`, so
 * `containerWorkspaceFolder` should be the authoritative `remoteWorkspaceFolder` the CLI
 * reported.
 */
export function resolveOverlayRemoteEnv(
  overlay: DevcOverlay,
  containerWorkspaceFolder: string,
  localWorkspaceFolder?: string,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(overlay.remoteEnv).map(([k, v]) => [
      k,
      substituteVars(v, containerWorkspaceFolder, localWorkspaceFolder),
    ]),
  );
}
