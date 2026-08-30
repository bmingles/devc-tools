// The layer merge that produces devc's *effective* `devcontainer.json`.
//
// devc used to translate the `devc.json` overlay into `devcontainer up` flags (`--mount`,
// `--remote-env`, `--additional-features`). That capped the overlay at what those flags can
// say — four keys, no `readonly`, and no way to remove or replace anything the base config
// declares. Now the layers are merged into one config file and handed to the CLI, so the
// overlay can say anything a `devcontainer.json` can.
//
// Layers, lowest to highest:
//
//   devc layer  →  base config  →  user devc.json  →  project devc.json
//
// The devc layer is devc's own contribution (baseline Features, the bridge token mount) and is
// lowest so everything else can override it. See `overlay.ts`'s `devcContributions`.
//
// **Nothing here substitutes variables.** `${localEnv:HOME}`, `${containerWorkspaceFolder}` and
// friends are written through verbatim and resolved by the devcontainer CLI, which is what makes
// `${devcontainerId}` and `${containerEnv:…}` work in an overlay value at all.

import { logWarning } from './log.ts';

/** A parsed `devcontainer.json` (or one layer of one). */
export type ConfigObject = Record<string, unknown>;

/**
 * Merge directive: a top-level array of key names whose values **replace** rather than merge.
 * Consumed here and never written to the output.
 *
 * It exists for the one case the rules below cannot express — "throw away everything the layers
 * under me said about this key". `null` covers deletion and {@link dedupeMounts} covers most
 * replacement, so this is rarely the answer.
 */
export const REPLACE_KEY = '$replace';

/**
 * The `devcontainer.json` keys that may only appear one at a time: a config is an image, a
 * build, or a compose project. When a layer sets one, the other two are dropped from the result
 * — merging them would produce a config the CLI rejects.
 */
const SHAPE_KEYS = ['image', 'build', 'dockerComposeFile'] as const;

/**
 * Lifecycle command keys. Single-valued per config, so a higher layer setting one silently
 * discards a lower layer's — worth a warning, because "and also run mine" is what people mean
 * and is not what happens. The object form would run both, but *in parallel* (verified in
 * `@devcontainers/cli` 0.88.0), which is a different thing again — so devc does not auto-combine.
 */
const LIFECYCLE_KEYS = [
  'initializeCommand',
  'onCreateCommand',
  'updateContentCommand',
  'postCreateCommand',
  'postStartCommand',
  'postAttachCommand',
] as const;

function isPlainObject(value: unknown): value is ConfigObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The mount target of one `mounts` entry — the `target=`/`dst=` field of a string spec, or the
 * `target` property of an object one — or `null` when it has none this can find.
 *
 * An entry whose target cannot be read is never deduped against anything (see
 * {@link dedupeMounts}): silently collapsing two mounts because neither could be parsed would be
 * far worse than leaving Docker to report a duplicate.
 */
export function mountTarget(entry: unknown): string | null {
  if (typeof entry === 'string') {
    const match = /(?:^|,)\s*(?:target|dst|destination)=([^,]*)/.exec(entry);
    return match === null || match[1] === '' ? null : match[1];
  }
  if (isPlainObject(entry) && typeof entry.target === 'string') {
    return entry.target === '' ? null : entry.target;
  }
  return null;
}

/**
 * `mounts` with each target appearing once: a later entry sharing an earlier one's target
 * **replaces it in place**, so the base config's ordering survives and the highest layer's value
 * wins.
 *
 * This is what turns "arrays append" into "override the bundled `claude-seed` mount", and it is
 * why the overlay can now replace an infra mount instead of colliding with it — two entries on
 * one target used to reach Docker and fail the create with `Duplicate mount point`.
 */
function dedupeMounts(mounts: readonly unknown[]): unknown[] {
  const out: unknown[] = [];
  const seen = new Map<string, number>();
  for (const entry of mounts) {
    const target = mountTarget(entry);
    if (target === null) {
      out.push(entry);
      continue;
    }
    const at = seen.get(target);
    if (at === undefined) {
      seen.set(target, out.length);
      out.push(entry);
    } else {
      out[at] = entry;
    }
  }
  return out;
}

/** `extensions` with each id once, first occurrence kept — the base's ordering wins. */
function dedupeExtensions(extensions: readonly unknown[]): unknown[] {
  const seen = new Set<string>();
  const out: unknown[] = [];
  for (const entry of extensions) {
    if (typeof entry !== 'string') {
      out.push(entry);
      continue;
    }
    if (seen.has(entry)) continue;
    seen.add(entry);
    out.push(entry);
  }
  return out;
}

/**
 * Merge one object into another, recursively. A `null` value **deletes** its key (RFC 7386's
 * one borrowed rule) at any depth; arrays append; anything else is replaced by the higher value.
 *
 * `features` merges the same as everything else — per Feature id, and within a Feature's options
 * object, per option key — so a project overlay can override a single option (e.g. one flag in
 * `installPiCli`) without restating the rest of what the user or base config set.
 */
function mergeObjects(lower: ConfigObject, higher: ConfigObject): ConfigObject {
  const out: ConfigObject = { ...lower };
  for (const [key, value] of Object.entries(higher)) {
    if (value === null) {
      delete out[key];
      continue;
    }
    out[key] = mergeValues(out[key], value);
  }
  return out;
}

function mergeValues(lower: unknown, higher: unknown): unknown {
  if (Array.isArray(lower) && Array.isArray(higher)) {
    return [...lower, ...higher];
  }
  if (isPlainObject(lower) && isPlainObject(higher)) {
    return mergeObjects(lower, higher);
  }
  return higher;
}

/** The `$replace` key names declared by one layer, ignoring a malformed value. */
function replaceKeys(layer: ConfigObject): Set<string> {
  const declared = layer[REPLACE_KEY];
  if (declared === undefined) return new Set();
  if (!Array.isArray(declared)) {
    logWarning(
      `devc: ignoring "${REPLACE_KEY}" (must be an array of key names) — merging as usual`,
    );
    return new Set();
  }
  return new Set(declared.filter((k): k is string => typeof k === 'string'));
}

/**
 * Warn when `higher` replaces a lifecycle command `lower` already set, and when it changes the
 * config's shape (image/build/compose) — the two places where merging quietly discards something
 * the layer below asked for. Returns the shape key `higher` declared, if any.
 */
function warnAndFindShape(
  lower: ConfigObject,
  higher: ConfigObject,
): string | null {
  for (const key of LIFECYCLE_KEYS) {
    // `null` is a deletion, not a replacement — nothing is being silently discarded in favour of
    // something else, which is the only thing this warning is about.
    if (
      higher[key] !== undefined && higher[key] !== null &&
      lower[key] !== undefined
    ) {
      logWarning(
        `devc: an overlay's "${key}" replaces the one below it — lifecycle commands are ` +
          'single-valued, so only the highest layer runs. To add a create-time step without ' +
          'replacing one, use devc-post-create.sh.',
      );
    }
  }

  const declared = SHAPE_KEYS.filter((key) =>
    higher[key] !== undefined && higher[key] !== null
  );
  if (declared.length === 0) return null;
  const [shape] = declared;
  for (const key of SHAPE_KEYS) {
    if (key !== shape && lower[key] !== undefined) {
      logWarning(
        `devc: an overlay's "${shape}" replaces the base config's "${key}" — a devcontainer.json ` +
          'is an image, a build or a compose project, never two.',
      );
    }
  }
  return shape;
}

/** Merge `higher` onto `lower`, applying `$replace`, the shape rules, and the warnings. */
function mergeLayer(lower: ConfigObject, higher: ConfigObject): ConfigObject {
  const replace = replaceKeys(higher);
  const shape = warnAndFindShape(lower, higher);

  const out: ConfigObject = { ...lower };
  if (shape !== null) {
    for (const key of SHAPE_KEYS) if (key !== shape) delete out[key];
  }

  for (const [key, value] of Object.entries(higher)) {
    if (key === REPLACE_KEY) continue;
    if (value === null) {
      delete out[key];
      continue;
    }
    out[key] = replace.has(key) ? value : mergeValues(out[key], value);
  }
  return out;
}

/**
 * The effective config for `layers`, lowest first.
 *
 * Rules, applied per key of each layer in turn:
 *
 * 1. `null` deletes the key (at any depth).
 * 2. A key named in that layer's `$replace` is set outright, no merging.
 * 3. Two plain objects merge recursively — `features` included, so a project overlay can
 *    override a single option on a Feature without restating the rest.
 * 4. Two arrays append, lower first.
 * 5. Anything else: the higher layer wins.
 *
 * Then, once over the result: `mounts` dedupe by target (highest wins, position preserved) and
 * `customizations.vscode.extensions` dedupe by id.
 *
 * Never mutates an input layer.
 */
export function mergeConfigs(layers: readonly ConfigObject[]): ConfigObject {
  const merged = layers.reduce<ConfigObject>(mergeLayer, {});

  if (Array.isArray(merged.mounts)) merged.mounts = dedupeMounts(merged.mounts);

  const vscode = isPlainObject(merged.customizations)
    ? merged.customizations.vscode
    : undefined;
  if (isPlainObject(vscode) && Array.isArray(vscode.extensions)) {
    merged.customizations = {
      ...(merged.customizations as ConfigObject),
      vscode: { ...vscode, extensions: dedupeExtensions(vscode.extensions) },
    };
  }

  return merged;
}
