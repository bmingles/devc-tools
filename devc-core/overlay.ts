// The `devc.json` overlay: an optional, devc-only file contributing `mounts`,
// `additionalFeatures`, `remoteEnv` and `baselineFeatures` on top of whichever
// `devcontainer.json` is in play.
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

import { readFile, stat } from 'node:fs/promises';
import { parse as parseJsoncLoose, type ParseError } from 'jsonc-parser';
import {
  CONFIG_DIR,
  declaresFeatureNamed,
  substituteVars,
} from './default_config.ts';
import { isNotADirectory, isNotFound } from './errors.ts';
import { logWarning } from './log.ts';

/**
 * Parse JSONC (comments and trailing commas both allowed), throwing when `jsonc-parser`
 * reports any real problem. `allowTrailingComma` is what keeps a trailing comma out of the
 * error list — without it, `jsonc-parser` still recovers a value but also reports the comma
 * itself as an error, which would make a spec-legal file fail here.
 */
function parseJsonc(text: string): unknown {
  const errors: ParseError[] = [];
  const value = parseJsoncLoose(text, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    const [first] = errors;
    throw new SyntaxError(
      `JSONC parse error ${first.error} at offset ${first.offset}`,
    );
  }
  return value;
}

/** The merged, validated contents of the overlay layer. Every field is always present. */
export interface DevcOverlay {
  /** Docker `--mount` specs, in merged order (user entries first). */
  mounts: string[];
  /**
   * Feature id → options, the ones *you* ask for — merged per feature id (whole-value replace,
   * no deep merge). See {@link DevcOverlay.baselineFeatures} for the ones devc adds on its own;
   * the two are adjacent and opposite: this one is a map that adds, that one is a boolean that
   * withholds.
   */
  additionalFeatures: Record<string, unknown>;
  /** Container env, merged per key. */
  remoteEnv: Record<string, string>;
  /**
   * False disables every Feature devc contributes on its own (see
   * {@link DevcOverlay.additionalFeatures} for the ones you ask for yourself). Default `true`.
   *
   * The one overlay key where {@link mergeOverlays} does **not** let the project win: it is
   * `user.baselineFeatures && project.baselineFeatures` — a **veto**, not "more specific wins".
   * The user-level file belongs to the machine's owner, and a repo talking a machine back into
   * running devc's baseline after the owner turned it off is not a thing anyone asked for. A
   * project *can* turn it off even when the user left it on, same as any other opt-out.
   */
  baselineFeatures: boolean;
}

/** The only four keys the overlay understands. Anything else warns and is ignored. */
const OVERLAY_KEYS = [
  'mounts',
  'additionalFeatures',
  'remoteEnv',
  'baselineFeatures',
] as const;

/**
 * Project-level overlay locations, relative to the project folder, in first-hit-wins order.
 *
 * Both directories are first-class and behave identically. `.devcontainer/devc.json` often suits
 * a gitignored local override — one file to ignore, sitting beside the config it overlays —
 * while `.devc/` suits a repo that wants `devc`'s files grouped in one place.
 */
const PROJECT_CANDIDATES = [
  '.devc/devc.jsonc',
  '.devc/devc.json',
  '.devcontainer/devc.jsonc',
  '.devcontainer/devc.json',
] as const;

/** User-level overlay filenames, relative to the global config dir, in first-hit-wins order. */
const USER_CANDIDATES = ['devc.jsonc', 'devc.json'] as const;

/**
 * The devcontainer CLI's own `--mount` arg validation, copied verbatim from
 * `devContainersSpecCLI.ts`. It is the whole vocabulary a mount spec has here: field order is
 * fixed, and `source`/`target` cannot contain a comma.
 *
 * Anything else — `consistency=cached`, `readonly`, a reordered spec — is rejected by the CLI
 * with a context-free `Unmatched argument format: mount must match …` that names neither the
 * file nor the entry. devc validates against the same regex at load so the error can.
 *
 * There is no way to express a read-only mount through this flag. The CLI re-serializes the
 * parsed spec as `type=…,src=…,dst=…` before it reaches `docker run`, so even a smuggled field
 * would be dropped; only *string* mounts inside a `devcontainer.json` `mounts` array are passed
 * through verbatim (which is how the infra `claude-seed` mount stays `readonly`).
 */
export const MOUNT_SPEC_RE =
  /^type=(bind|volume),source=([^,]+),target=([^,]+)(?:,external=(true|false))?$/;

/** Fields devc used to emit, named individually because they are the likely reason for a failure. */
const RETIRED_MOUNT_FIELDS = ['consistency', 'readonly'] as const;

/** An overlay contributing nothing. `baselineFeatures` defaults `true`, same as a file that omits it. */
export function emptyOverlay(): DevcOverlay {
  return {
    mounts: [],
    additionalFeatures: {},
    remoteEnv: {},
    baselineFeatures: true,
  };
}

/**
 * True when `overlay` would emit no `devcontainer up` args at all.
 *
 * Deliberately does **not** consider `baselineFeatures`: that field never emits an arg by
 * itself (it is consulted by {@link withBaselineFeatures}, upstream of this call, to decide
 * what to *add* to `additionalFeatures`) — so a `baselineFeatures: false` overlay that declares
 * nothing else really is empty, and a caller that tests the *effective* overlay after
 * injection instead of the user's own would wrongly treat every overlay as non-empty and pay
 * for {@link import("./container.ts").computeContainerWorkspaceFolder}'s git subprocesses on
 * every `up`. Test the overlay before injection here, not after.
 */
export function isEmptyOverlay(overlay: DevcOverlay): boolean {
  return overlay.mounts.length === 0 &&
    Object.keys(overlay.additionalFeatures).length === 0 &&
    Object.keys(overlay.remoteEnv).length === 0;
}

async function firstExisting(paths: readonly string[]): Promise<string | null> {
  for (const path of paths) {
    try {
      await stat(path);
      return path;
    } catch (err) {
      // `NotADirectory` is the same answer as `NotFound` here: a candidate whose parent is a
      // regular file (a project with a `.devcontainer` *file*) has no overlay at that path.
      // Anything else — a permissions failure, say — is a real problem and still throws.
      if (!isNotFound(err) && !isNotADirectory(err)) throw err;
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

/** Where `devc config` will write, and whether that file has to be created first. */
export interface OverlayTarget {
  /** Absolute path of the overlay file to write. */
  path: string;
  /** True when nothing is there yet and the file must be seeded. */
  creating: boolean;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The overlay file `devc config` should write for `localFolder`.
 *
 * An existing overlay always wins, in {@link findProjectOverlayPath}'s order — devc never
 * creates a second overlay beside one that is already there, since only the first hit is ever
 * read and the loser would silently do nothing.
 *
 * With none present, the new file goes beside the config it overlays (`.devcontainer/`) when
 * that directory exists, and into `.devc/` otherwise. The second case is what lets `devc config`
 * work on a zero-config project: recording a mount must not drag in a whole `.devcontainer/`
 * the user would then have to maintain.
 */
export async function resolveProjectOverlayTarget(
  localFolder: string,
): Promise<OverlayTarget> {
  const existing = await findProjectOverlayPath(localFolder);
  if (existing !== null) return { path: existing, creating: false };
  const dir = (await isDirectory(`${localFolder}/.devcontainer`))
    ? '.devcontainer'
    : '.devc';
  return { path: `${localFolder}/${dir}/devc.jsonc`, creating: true };
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
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .trim() === '';
}

/**
 * Why `spec` was rejected, phrased for someone looking at their own file. The retired-field
 * case is called out by name because it is the one a devc upgrade causes: those fields were
 * emitted into `devcontainer.json` fences, where they were legal, and are not legal here.
 */
function mountSpecComplaint(spec: string): string {
  const offenders = RETIRED_MOUNT_FIELDS.filter((f) =>
    new RegExp(`(^|,)\\s*${f}\\b`).test(spec)
  );
  if (offenders.length > 0) {
    return `${
      offenders.map((f) => `"${f}"`).join(' and ')
    } cannot be used here — \`devcontainer up --mount\` accepts only ` +
      'type, source, target and external, so a read-only overlay mount is not possible';
  }
  return 'must be type=<bind|volume>,source=<source>,target=<target>[,external=<true|false>] ' +
    '— in that field order, with no commas in the paths';
}

function readMounts(path: string, value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw typeError(path, '"mounts" must be an array of mount-spec strings');
  }
  return value.map((entry, i) => {
    if (typeof entry !== 'string') {
      throw typeError(path, `"mounts"[${i}] must be a string`);
    }
    // Validated raw, before substitution: none of the `${…}` tokens can contain a comma, so
    // the check is equivalent and the error can quote what the user actually wrote.
    if (!MOUNT_SPEC_RE.test(entry)) {
      throw typeError(
        path,
        `"mounts"[${i}] (${entry}): ${mountSpecComplaint(entry)}`,
      );
    }
    return entry;
  });
}

function readObject(
  path: string,
  key: string,
  value: unknown,
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw typeError(path, `"${key}" must be an object`);
  }
  return value as Record<string, unknown>;
}

function readRemoteEnv(
  path: string,
  value: unknown,
): Record<string, string> {
  const obj = readObject(path, 'remoteEnv', value);
  return Object.fromEntries(
    Object.entries(obj).map(([k, v]) => {
      if (typeof v !== 'string') {
        throw typeError(path, `"remoteEnv"."${k}" must be a string`);
      }
      return [k, v];
    }),
  );
}

/**
 * Unlike every other known key, a malformed `baselineFeatures` **warns and is ignored**
 * (falling back to the default `true`) rather than failing the load. The other keys are hard
 * errors because silently starting a container missing a mount is worse than refusing to
 * start; a mistyped `baselineFeatures` has no such asymmetry — either value is a container that
 * comes up, so there is nothing here worth failing over.
 */
function readBaselineFeatures(path: string, value: unknown): boolean {
  if (typeof value !== 'boolean') {
    logWarning(
      `devc: ignoring non-boolean "baselineFeatures" in ${path} (must be true or false) — defaulting to true`,
    );
    return true;
  }
  return value;
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
  const text = await readFile(path, 'utf8');
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
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw typeError(path, 'expected a JSON object at the top level');
  }

  const raw = parsed as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!(OVERLAY_KEYS as readonly string[]).includes(key)) {
      logWarning(
        `devc: ignoring unknown key "${key}" in ${path} (known keys: ${
          OVERLAY_KEYS.join(', ')
        })`,
      );
    }
  }

  return {
    mounts: raw.mounts === undefined ? [] : readMounts(path, raw.mounts),
    additionalFeatures: raw.additionalFeatures === undefined
      ? {}
      : readObject(path, 'additionalFeatures', raw.additionalFeatures),
    remoteEnv: raw.remoteEnv === undefined
      ? {}
      : readRemoteEnv(path, raw.remoteEnv),
    baselineFeatures: raw.baselineFeatures === undefined
      ? true
      : readBaselineFeatures(path, raw.baselineFeatures),
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
 *
 * `baselineFeatures` is the one exception to "project wins" — see its own doc comment on
 * {@link DevcOverlay.baselineFeatures} for why disabling it is a veto instead.
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
    baselineFeatures: user.baselineFeatures && project.baselineFeatures,
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
 * The `devc-config` Feature devc contributes to every container it starts — dynamically, via
 * {@link withBaselineFeatures} only. Deliberately **not** also declared in the bundled
 * `devcontainer.json` (`devc-core/default/devcontainer.json`): what this Feature does (running a
 * `devc-post-create.sh` a project committed for devc's own convention) is devc-specific, so
 * unlike the other bundled Features it is fine for a `devc init`-scaffolded project to lose it
 * once `devc` itself is uninstalled. See `features/devc-config/README.md`.
 *
 * **Exact version, not the floating `:0`** — a departure from the bundled `devcontainer.json`,
 * which uses `:0` for every Feature it lists. Those are opt-in; this one is forced on every
 * container devc starts, so a bad Feature publish would otherwise reach every user's next build
 * with no devc release and no opt-in anywhere. Bumping it is a devc release, deliberately.
 * Guarded by `tests/workflow_guards_test.sh` against `features/devc-config/devcontainer-feature.json`'s
 * own `version` — a comment saying "keep these in step" is how pins drift.
 */
export const DEVC_CONFIG_FEATURE =
  'ghcr.io/bmingles/devc-tools/devc-config:0.2.0';

/**
 * The Features devc contributes to every container it starts, id paired with the bare name
 * {@link declaresFeatureNamed} matches against. Exactly one entry today; a later plan can add
 * more (see `.plans/archived/devc-inject-project-hook.md`'s Not in this plan).
 */
const BASELINE_FEATURES: readonly { id: string; name: string }[] = [
  { id: DEVC_CONFIG_FEATURE, name: 'devc-config' },
];

/**
 * `overlay` plus the Features devc contributes itself, added *under* whatever the overlay
 * already declares.
 *
 * For each baseline Feature, it is skipped when **any** of:
 *
 * 1. `overlay.baselineFeatures` is false;
 * 2. `overlay.additionalFeatures` already declares a Feature of that name (by any spelling —
 *    {@link declaresFeatureNamed});
 * 3. `declaredInConfig` (the in-play `devcontainer.json`'s own `features`) contains a Feature of
 *    that name.
 *
 * Skipping on 2 and 3 — rather than letting the CLI's own merge sort it out — matters because
 * the pinned `@devcontainers/cli` dedupes `--additional-features` against a config's `features`
 * by **exact id string**, not by name: a consumer who pins `…/devc-config:0.2.0` while devc
 * injects `:0.1.0` would get **both installed and the hook run twice**, not one overriding the
 * other. Measured against `@devcontainers/cli` 0.88.0.
 *
 * Returns a new object; never mutates `overlay`.
 */
export function withBaselineFeatures(
  overlay: DevcOverlay,
  declaredInConfig: readonly string[],
): DevcOverlay {
  if (!overlay.baselineFeatures) return overlay;

  const declaredInConfigAsFeatures = Object.fromEntries(
    declaredInConfig.map((id) => [id, {}]),
  );

  const additions: Record<string, unknown> = {};
  for (const feature of BASELINE_FEATURES) {
    if (declaresFeatureNamed(overlay.additionalFeatures, feature.name)) {
      continue;
    }
    if (declaresFeatureNamed(declaredInConfigAsFeatures, feature.name)) {
      continue;
    }
    additions[feature.id] = {};
  }
  if (Object.keys(additions).length === 0) return overlay;

  return {
    ...overlay,
    additionalFeatures: { ...additions, ...overlay.additionalFeatures },
  };
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
  for (const mount of overlay.mounts) args.push('--mount', sub(mount));
  if (Object.keys(overlay.additionalFeatures).length > 0) {
    args.push(
      '--additional-features',
      JSON.stringify(overlay.additionalFeatures),
    );
  }
  for (const [key, value] of Object.entries(overlay.remoteEnv)) {
    args.push('--remote-env', `${key}=${sub(value)}`);
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
