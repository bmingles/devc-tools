import type { Dirent } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import process from 'node:process';
import { parse as parseJsoncLoose, type ParseError } from 'jsonc-parser';
import { writeBlocks } from './jsonc_edit.ts';
import { basenamePosix } from './posix.ts';
import { isAlreadyExists, isDirectoryNotEmpty, isNotFound } from './errors.ts';
import { logWarning } from './log.ts';

// Embedded `devc-core/default/` directory, read via `node:fs/promises`. Under `deno run` /
// `node` from source this resolves to the real source tree; under a `deno compile --include
// default` binary it resolves to the embedded virtual filesystem, which `node:fs` reads
// unmodified — see `.plans/devc-core-npm-library.md`'s Validation section.
const DEFAULT_DIR_URL = new URL('./default/', import.meta.url);

/** The global config directory, `~/.config/devc`. */
export const CONFIG_DIR = `${homeDir()}/.config/devc`;

/**
 * User-level template directory, `~/.config/devc/templates`. A **sparse** overlay on the bundled
 * `default/` tree: any file placed here overrides the same-named bundled file, per file, in both
 * the zero-config cache ({@link ensureDefaultConfig}) and what `devc init` writes into a
 * project ({@link copyBundledAssets}).
 *
 * Never seeded. It stays absent until the user creates it and holds only the files they want to
 * change, so a `devc` upgrade keeps shipping its new defaults for everything else — the reason
 * this is an overlay rather than a one-time copy of the whole tree. Deleting a file from here
 * restores the bundled version on the next run.
 */
export const TEMPLATES_DIR = `${CONFIG_DIR}/templates`;

/**
 * Overlay filenames that must never ride the template layer into a devcontainer.
 *
 * `templates/` and the `devc.json` overlay are adjacent paths with opposite meanings, and the
 * mistake is an easy one: `templates/` holds files that are *copied into* a project's
 * `.devcontainer/` and run without `devc` installed, while the overlay is a devc-only layer read
 * from `CONFIG_DIR` and applied as `devcontainer up` flags at launch. A `devc.json` left in
 * `templates/` would be copied to `<project>/.devcontainer/devc.json` by
 * {@link copyBundledAssets} and read back as that project's *own* overlay — the highest-precedence
 * slot — putting one machine's bind mounts into every scaffolded repo.
 *
 * So it is skipped, and {@link overlayDirFrom} says so as a `warning` (stderr, by default —
 * see `log.ts`): silently dropping the file would
 * leave exactly the "why isn't my overlay working" that put it there.
 */
const TEMPLATE_OVERLAY_FILENAMES: readonly string[] = [
  'devc.json',
  'devc.jsonc',
];

/**
 * Host directory holding the user's `~/.claude` config for containers. Bind-mounted read-only
 * at `CLAUDE_SEED_TARGET`; `post-create.sh` symlinks every top-level *file* from it into the
 * `~/.claude` volume (directories are ignored — the `devc:skills` fence owns
 * `~/.claude/skills/`).
 */
export const CLAUDE_SEED_HOST_DIR = `${CONFIG_DIR}/.claude`;

/** Container path the seed directory is bind-mounted at (mirrors the bundled default). */
export const CLAUDE_SEED_TARGET = '/usr/local/share/devc/claude-seed';

/** Outcome of `ensureClaudeSeedDir`. */
export interface ClaudeSeedResult {
  /** True when this call created the directory (false when it already existed). */
  created: boolean;
}

/**
 * Create the host seed directory if absent, and report whether this call is what created it.
 *
 * The directory starts and stays **empty** — what reaches the container is whatever the user
 * puts here, and nothing else. Nothing is ever copied out of the host's real `~/.claude`: those
 * are that machine's personal settings, and silently republishing them into every container is
 * the user's call to make, not devc's. Earlier versions did copy three files in on first
 * creation, as a migration off the per-file bind mounts; that is gone, and a setup still on the
 * old shape moves its files across by hand (see the README).
 *
 * The bundled default's `initializeCommand` also creates this directory, so a project config
 * works without `devc` installed. This function still runs on every `up` because it owns the one
 * thing a shell one-liner cannot: the not-a-directory guard.
 *
 * `seedDir` defaults to the real path and only needs overriding in tests.
 */
export async function ensureClaudeSeedDir(
  seedDir: string = CLAUDE_SEED_HOST_DIR,
): Promise<ClaudeSeedResult> {
  // Whether we created it has to be decided before the mkdir: recursive mkdir succeeds
  // silently on an existing directory, so it cannot report the difference. lstat (not stat) so
  // a dangling symlink counts as present and falls into the guard below rather than looking
  // like a fresh creation.
  const created = await lstat(seedDir).then(() => false).catch(() => true);
  try {
    await mkdir(seedDir, { recursive: true });
  } catch (err) {
    // Recursive mkdir is not quite `mkdir -p`: it reports AlreadyExists when the path is a
    // regular file or a dangling symlink. Fall through to the guard, which says why.
    if (!isAlreadyExists(err)) throw err;
  }

  // Verify we actually have a directory — otherwise the problem resurfaces later as an opaque
  // "bind source path does not exist" from Docker.
  const info = await stat(seedDir).catch(() => null);
  if (info === null || !info.isDirectory()) {
    throw new Error(
      `${seedDir} exists but is not a directory (expected the devc ~/.claude config folder)`,
    );
  }
  return { created };
}

/**
 * Path to `localFolder`'s own devcontainer config (`.devcontainer/devcontainer.json`, else
 * `.devcontainer.json`) — i.e. "project mode" — or `null` when it has none and the zero-config
 * path applies.
 *
 * Returns the *path*, not just a boolean, because callers need to read the config that is
 * actually in play: `remoteEnv` has to come from the project's own file in project mode, and a
 * boolean left no way to reach it (see {@link loadResolvedRemoteEnv}).
 */
export async function findOwnDevcontainerConfig(
  localFolder: string,
): Promise<string | null> {
  for (const rel of ['.devcontainer/devcontainer.json', '.devcontainer.json']) {
    const path = `${localFolder}/${rel}`;
    try {
      await stat(path);
      return path;
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }
  return null;
}

function homeDir(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? '.';
}

/** Recursively copies the embedded `default/` tree to a real directory on disk. */
async function copyDir(sourceUrl: URL, destDir: string): Promise<void> {
  await mkdir(destDir, { recursive: true });
  const entries = await readdir(sourceUrl, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      await copyDir(
        new URL(`${entry.name}/`, sourceUrl),
        `${destDir}/${entry.name}`,
      );
    } else {
      const bytes = await readFile(new URL(entry.name, sourceUrl));
      await writeFile(`${destDir}/${entry.name}`, bytes);
    }
  }
}

/**
 * Recursively copies a real on-disk directory over `destDir`, overwriting per file and recursing
 * into subdirectories. Files already in `destDir` that the source does not have are left alone —
 * this is an overlay, not a mirror. A missing `sourceDir` is a silent no-op.
 *
 * This is the *only* mechanism the template layer has, so every caller passes
 * {@link TEMPLATES_DIR} as `sourceDir` and the {@link TEMPLATE_OVERLAY_FILENAMES} guard lives
 * here rather than at the call sites. It applies at the top level only: a nested
 * `scripts/devc.json` is an ordinary data file with no overlay meaning. `topLevel` is internal to
 * the recursion and should not be passed.
 *
 * `copyFile` rather than read+write: unlike {@link copyDir}'s embedded-asset path, this
 * copies from a real filesystem where the user's own modes are worth preserving.
 */
async function overlayDirFrom(
  sourceDir: string,
  destDir: string,
  topLevel = true,
): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(sourceDir, { withFileTypes: true });
  } catch (err) {
    // A missing template dir is the common case — it is never seeded.
    if (isNotFound(err)) return;
    throw err;
  }

  await mkdir(destDir, { recursive: true });
  for (const entry of entries) {
    if (
      topLevel && !entry.isDirectory() &&
      TEMPLATE_OVERLAY_FILENAMES.includes(entry.name)
    ) {
      logWarning(
        `devc: ignoring ${sourceDir}/${entry.name} — the devc.json overlay is read from ` +
          `${CONFIG_DIR}/devc.jsonc, not from the templates directory (which holds files copied ` +
          `into a project's .devcontainer/). Move it up one level to apply it to every project.`,
      );
      continue;
    }
    if (entry.isDirectory()) {
      await overlayDirFrom(
        `${sourceDir}/${entry.name}`,
        `${destDir}/${entry.name}`,
        false,
      );
    } else {
      await copyFile(
        `${sourceDir}/${entry.name}`,
        `${destDir}/${entry.name}`,
      );
    }
  }
}

/**
 * Copies the embedded `devc-core/default/` tree into `cacheDir` (default
 * `~/.cache/devc/default`), overwriting any existing copy, overlays any user
 * {@link TEMPLATES_DIR} files on top of it per file, and returns the path to the copied
 * `devcontainer.json` — suitable for `devcontainer up --config <path>`.
 *
 * The three steps are ordered, and the order is load-bearing:
 *
 * 1. Remove the prior copy, so a file dropped between versions does not linger forever.
 * 2. Copy the embedded tree.
 * 3. Overlay `templatesDir`, per file — so deleting a template restores the bundled version.
 * 4. Apply the two path rewrites below, *after* the overlay, so a user-supplied
 *    `templates/devcontainer.json` gets them too. They are `replaceAll` of exact tokens, so a
 *    template that rewrote those lines itself simply no-ops.
 *
 * The copy is near-verbatim: the bundled default carries no local Feature, so
 * zero-config and `devc config` projects share the same `.devcontainer/` shape. The
 * baseline is delivered by the bundled `Dockerfile` (build-time) plus the top-level
 * `postCreateCommand` running `post-create.sh` → `scripts/*` (create-time), both of which
 * the source config already spells out. `@devcontainers/cli` accepts JSONC, so the copied
 * config keeps its comments.
 *
 * Two path rewrites are applied, because both entry scripts are referenced relative to a
 * project `.devcontainer/` that does not exist in the zero-config path (the workspace is the
 * user's project, and this cache dir is not mounted into the container):
 *
 * - `initializeCommand` runs on the *host* → resolved to `initialize-command.sh` in the
 *   directory this tree will finally live in (`opts.finalDir`, defaulting to `cacheDir`).
 * - `postCreateCommand` runs in the *container* → resolved to the image-baked
 *   `post-create.sh` (which the Dockerfile `COPY`s in for exactly this case).
 *
 * Plain string replaces preserve the config's comments; the tokens match the source verbatim.
 * These rewrites are why the project-mode config can reference clean in-project paths (so edits
 * apply on recreate) while the hidden zero-config copy still resolves.
 *
 * With `opts.bridge`, a fifth step injects the devc-bridge token mount — see
 * {@link injectBridgeMount}. It runs after the overlay for the same reason the rewrites do.
 *
 * Writes **unconditionally**, to exactly the directory it is handed. That is the whole of its
 * contract, and it is what makes it directly testable. Production code does not call it: the
 * zero-config path goes through {@link ensureDefaultConfig}, whose content-addressed cache is
 * what keeps two processes (or two projects) from rewriting one shared directory under each
 * other.
 *
 * `cacheDir` / `templatesDir` default to the real `~/.cache/devc/default` and
 * {@link TEMPLATES_DIR}, and only need overriding in tests. `opts.finalDir` is for the staging
 * case — see its own note below.
 */
export async function materializeDefaultConfig(
  cacheDir: string = `${homeDir()}/.cache/devc/default`,
  templatesDir: string = TEMPLATES_DIR,
  opts: {
    bridge?: boolean;
    /**
     * The directory this tree will live in once it is in place; the `initializeCommand` rewrite
     * resolves against it rather than against `cacheDir`. Defaults to `cacheDir`, so a caller
     * that writes straight to the final location — every caller before
     * {@link ensureDefaultConfig} existed, and every existing test — is unaffected.
     *
     * Set it when materializing into a staging directory that will be renamed into place: the
     * baked `initializeCommand` path is absolute, so a tree written under `.tmp-…/` and renamed
     * would point `initializeCommand` at a directory that no longer exists. The final path is
     * known before the write (it is a pure function of the inputs), which is what makes passing
     * it in possible at all.
     */
    finalDir?: string;
  } = {},
): Promise<string> {
  const finalDir = opts.finalDir ?? cacheDir;

  // Remove any prior copy so files dropped between versions don't linger.
  await rm(cacheDir, { recursive: true, force: true }).catch(() => {});
  await copyDir(DEFAULT_DIR_URL, cacheDir);
  await overlayDirFrom(templatesDir, cacheDir);

  const configPath = `${cacheDir}/devcontainer.json`;
  const raw = await readFile(configPath, 'utf8');
  const rewritten = raw
    .replaceAll(
      '${localWorkspaceFolder}/.devcontainer/initialize-command.sh',
      `${finalDir}/initialize-command.sh`,
    )
    .replaceAll(
      '${containerWorkspaceFolder}/.devcontainer/post-create.sh',
      '/usr/local/share/devc/post-create.sh',
    );
  const final = opts.bridge
    ? injectBridgeMount(rewritten, configPath)
    : rewritten;
  if (final !== raw) await writeFile(configPath, final);

  return configPath;
}

/**
 * Every file under a directory, as relative posix paths sorted lexicographically.
 *
 * Sorted **globally**, over the full relative path, rather than per directory as the recursion
 * descends: it is the one ordering that does not depend on how the walk happens to interleave
 * files and subdirectories, and the key below is only stable if the order is.
 *
 * `readdir` returns entries in whatever order the filesystem hands them over — insertion order on
 * ext4, roughly alphabetical on APFS, arbitrary on a `deno compile` VFS — so nothing here may
 * depend on it.
 */
async function listTreeUrl(root: URL, prefix = ''): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      out.push(
        ...await listTreeUrl(
          new URL(`${entry.name}/`, root),
          `${prefix}${entry.name}/`,
        ),
      );
    } else {
      out.push(`${prefix}${entry.name}`);
    }
  }
  return prefix === '' ? out.sort() : out;
}

/**
 * {@link listTreeUrl} for a real on-disk directory. A missing directory contributes nothing —
 * {@link TEMPLATES_DIR} is never seeded, so its absence is the common case, not an error.
 */
async function listTreeDir(root: string, prefix = ''): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (err) {
    if (isNotFound(err)) return [];
    throw err;
  }
  const out: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      out.push(
        ...await listTreeDir(
          `${root}/${entry.name}`,
          `${prefix}${entry.name}/`,
        ),
      );
    } else {
      out.push(`${prefix}${entry.name}`);
    }
  }
  return prefix === '' ? out.sort() : out;
}

/** Separates a file's path from its bytes in the key's hash stream. */
const KEY_SEPARATOR = new Uint8Array([0]);

/**
 * The cache key for a materialized default config: `sha256`, hex, first 12 chars, over — in this
 * order — every file of the bundled `default/` tree, every file of `templatesDir`, and the bridge
 * flag. Each file contributes its posix relative path, a `NUL`, then its bytes.
 *
 * **Everything that changes the output must be in here.** {@link ensureDefaultConfig} skips the
 * write entirely on a hit, so an input outside the key is an input the user can change with no
 * visible effect — which is why `templatesDir` is hashed and not merely defaulted. That is the
 * one way to get this design wrong.
 *
 * The path, the `NUL` and the sorted order are all load-bearing: without the path a file rename
 * would not register, without the separator `ab`+`c` and `a`+`bc` would collide, and without the
 * sort the key would depend on filesystem enumeration order and differ machine to machine.
 *
 * 12 hex chars is 48 bits. This is a cache key over a handful of directories on one machine, not
 * a security boundary — a collision needs ~16M distinct devc/template combinations before it is
 * even worth thinking about, and the cost of one would be a stale config, not a compromise.
 */
async function defaultConfigKey(
  templatesDir: string,
  bridge: boolean,
): Promise<string> {
  const hash = createHash('sha256');
  for (const rel of await listTreeUrl(DEFAULT_DIR_URL)) {
    hash.update(rel);
    hash.update(KEY_SEPARATOR);
    hash.update(await readFile(new URL(rel, DEFAULT_DIR_URL)));
  }
  for (const rel of await listTreeDir(templatesDir)) {
    hash.update(rel);
    hash.update(KEY_SEPARATOR);
    hash.update(await readFile(`${templatesDir}/${rel}`));
  }
  hash.update(bridge ? '1' : '0');
  return hash.digest('hex').slice(0, 12);
}

/**
 * The content-addressed zero-config cache, and what the lifecycle actually calls. Returns the
 * path to a materialized `devcontainer.json` for the current bundled `default/` tree, templates
 * and bridge flag — writing **nothing** when a directory for those inputs already exists.
 *
 * This exists because the obvious implementation — {@link materializeDefaultConfig} straight into
 * one shared `~/.cache/devc/default` on every start — is a shared mutable path, and three
 * separate problems fall out of it:
 *
 * - The `bridge` flag is resolved *per project* (from that project's overlay) while the directory
 *   was shared across *all* of them, so a bridge project and a non-bridge project wrote different
 *   content to the same file.
 * - Two copies of core on one machine (an installed `devc` binary and a library consumer's
 *   embedded copy) each carry their own bundled `default/`. Alternating between them rewrote the
 *   config under the other, which `devcontainer up` reads as a changed config — a container
 *   rebuild from nothing the user did.
 * - The unconditional `rm -rf` could land while another process's `devcontainer up` was reading
 *   that same config.
 *
 * Keying the directory by its inputs closes all three at once: distinct versions, template
 * revisions and bridge flags get distinct directories, so nothing clobbers anything; `rename` is
 * atomic within a filesystem, so no reader ever sees a half-written tree; and identical inputs
 * give an identical path, so the absolute `initialize-command.sh` baked into the config is stable
 * and nothing rebuilds spuriously.
 *
 * It is also cheaper than what it replaces. Every `up` — and every `execInContainer`, which goes
 * through `startContainer` — used to pay an `rm -rf` plus a full tree copy. A hit is now a hash
 * and a `stat`.
 *
 * The miss path stages into a sibling `.tmp-<pid>-<rand>/` and `rename`s it onto the target.
 * Losing that `rename` to another process is a success, not a failure: it won, its tree is
 * complete and byte-identical (same key, same inputs), so the staging copy is simply discarded.
 *
 * `cacheRoot` holds *many* `default-<key>/` directories — it is the parent, unlike
 * {@link materializeDefaultConfig}'s `cacheDir`, which is one materialized tree. Both it and
 * `templatesDir` default to the real paths and only need overriding in tests.
 */
export async function ensureDefaultConfig(
  cacheRoot: string = `${homeDir()}/.cache/devc`,
  templatesDir: string = TEMPLATES_DIR,
  opts: { bridge?: boolean } = {},
): Promise<string> {
  const bridge = opts.bridge === true;
  const target = `${cacheRoot}/default-${await defaultConfigKey(
    templatesDir,
    bridge,
  )}`;
  const configPath = `${target}/devcontainer.json`;

  // The hit test is on the config file rather than the directory, so a tree left half-written by
  // something other than this function (an interrupted older devc, a manual `cp`) does not read
  // as a hit. Within this function a partial tree is unreachable by construction — `rename` is
  // atomic — but the cache root outlives any one version of this code.
  try {
    await stat(configPath);
    return configPath;
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }

  // Staged as a *sibling* of the target, which is what makes the `rename` a same-filesystem
  // metadata operation rather than a copy. pid + random so two processes — or two concurrent
  // starts inside one process — never share a staging directory.
  await mkdir(cacheRoot, { recursive: true });
  const staging = `${cacheRoot}/.tmp-${process.pid}-${
    Math.random().toString(36).slice(2, 10)
  }`;
  try {
    // `finalDir` is the trap this whole function has to avoid: the tree is written under
    // `staging` but its `initializeCommand` must name `target`, which will not exist until the
    // `rename` below succeeds.
    await materializeDefaultConfig(staging, templatesDir, {
      bridge,
      finalDir: target,
    });
    try {
      await rename(staging, target);
    } catch (err) {
      // Another process materialized the same key between our `stat` and our `rename`. Its tree
      // is complete and identical to ours, so there is nothing to do but drop ours — overwriting
      // would reintroduce exactly the write-under-a-reader race this design removes.
      if (!isAlreadyExists(err) && !isDirectoryNotEmpty(err)) throw err;
    }
  } finally {
    // A no-op after a successful `rename`; the cleanup that matters is the lost-race and
    // thrown-partway cases, neither of which should leave a `.tmp-` directory behind.
    await rm(staging, { recursive: true, force: true }).catch(() => {});
  }

  return configPath;
}

/** The token bind mount the devc-bridge Feature needs. */
const BRIDGE_MOUNT =
  'type=bind,source=${localEnv:HOME}/.config/devc-bridge/run,target=/run/devc-bridge,readonly';
/** Fence id the injected mount is written under, i.e. `devc:bridge-mount`. */
const BRIDGE_FENCE = 'bridge-mount';
/** Enough of the mount to recognize one the user already wrote themselves. */
const BRIDGE_MOUNT_TARGET = 'target=/run/devc-bridge';

/**
 * True when `additionalFeatures` opts into the devc-bridge Feature, by any spelling.
 *
 * Matched on the id's last path segment with the tag stripped, so `…/devc-bridge`,
 * `…/devc-bridge:0`, `:1`, a pinned `:0.1.0` and a local `./features/devc-bridge` all count.
 * A registry other than ghcr.io/bmingles counts too — a Feature *named* devc-bridge needs the
 * same token mount whoever published it, and guessing otherwise would silently withhold it.
 */
export function declaresBridgeFeature(
  additionalFeatures: Record<string, unknown>,
): boolean {
  return Object.keys(additionalFeatures).some((id) => {
    // Strip an OCI tag, but not a `:` that belongs to a path or a port.
    const colon = id.lastIndexOf(':');
    const untagged = colon >= 0 && !id.slice(colon + 1).includes('/')
      ? id.slice(0, colon)
      : id;
    return untagged.replace(/\/+$/, '').split('/').pop() === 'devc-bridge';
  });
}

/**
 * Insert the devc-bridge token mount into the materialized config's `mounts` array, as the
 * `devc:bridge-mount` fence.
 *
 * Only ever applied to the **cache copy**, and only when a devc.json opted in. The bundled
 * default stays bridge-free so a devc container still comes up on a host that never installed
 * the bridge, and devc still never writes into a project's `.devcontainer/` — project-mode users
 * declare this mount themselves, exactly like a non-devc project.
 *
 * Nothing marks the insertion point, deliberately: the bundled `devcontainer.json` is also what
 * `devc init` copies into a project, so an anchor comment there would leave every scaffolded
 * repo carrying a marker (and the paragraph explaining it) for a Feature its author may never
 * opt into. The `mounts` array is anchor enough — `writeBlocks` finds it, or creates it — and
 * the fence's own header explains itself in the one config that actually has the mount.
 *
 * A string mount, and `readonly` is why all of this exists: the devc.json overlay cannot carry
 * it (overlay mounts become `devcontainer up --mount` args, which reject the field and re-serialize
 * without it — see `MOUNT_SPEC_RE`), and a Feature cannot declare it either (the Feature schema's
 * `Mount` has no such field). A `mounts` array in a `devcontainer.json` is the only place a
 * read-only bind can be expressed, which is what makes injecting here the only route rather than
 * merely the tidiest.
 *
 * Fence splicing rather than parse-and-serialize, matching how `devc config` writes the overlay:
 * the config is JSONC, may be a user's own template, and its comments and formatting are worth
 * keeping byte-for-byte.
 */
function injectBridgeMount(text: string, configPath: string): string {
  // A user template that already declares it wins — two of the same target is Docker's
  // `Duplicate mount point`, a hard create failure.
  if (text.includes(BRIDGE_MOUNT_TARGET)) return text;

  try {
    return writeBlocks(text, 'mounts', [{
      id: BRIDGE_FENCE,
      lines: [
        '// Added because a devc.json opts into the devc-bridge Feature. Read-only:',
        '// a writable token mount lets a container pin the host token for the next start.',
        JSON.stringify(BRIDGE_MOUNT),
      ],
    }]);
  } catch (err) {
    // Only reachable when a user template replaced devcontainer.json with something this
    // cannot edit (not an object, an unterminated fence). Warn rather than fail: their config
    // is theirs, but a silently absent mount would surface much later as an unexplained
    // `cannot read token` from inside the container.
    logWarning(
      `devc: could not add the devc-bridge token mount to ${configPath} (${
        err instanceof Error ? err.message : err
      }) — add this to its "mounts" array yourself:\n  "${BRIDGE_MOUNT}"`,
    );
    return text;
  }
}

/**
 * Copy the whole embedded `default/` tree into `destDir` (a project's `.devcontainer/`) — the
 * `devcontainer.json`, the `Dockerfile`, the `post-create.sh` and `initialize-command.sh`
 * lifecycle entry scripts, and the `scripts/` sub-dependency subtree — then overlay
 * `templatesDir` on top, per file, so a user's own `Dockerfile`, `scripts/*.sh` or
 * `devcontainer.json` reaches project mode too.
 *
 * Every bundled file goes through the same two steps, `devcontainer.json` included. It used to be
 * excluded here and written separately by the caller, back when `devc config` spliced its managed
 * mount fences into the text on first creation; those fences now live in the `devc.json` overlay,
 * so nothing needs the config as an editable string on the way in and the exception bought only a
 * second code path to keep in sync.
 */
export async function copyBundledAssets(
  destDir: string,
  templatesDir: string = TEMPLATES_DIR,
): Promise<void> {
  await copyDir(DEFAULT_DIR_URL, destDir);
  await overlayDirFrom(templatesDir, destDir);
}

/**
 * Copy the bundled assets into `destDir` (a project's `.devcontainer/`) via
 * {@link copyBundledAssets}, then restore the exec bit on the two lifecycle entry scripts and
 * their `scripts/*.sh` delegates. Returns the top-level paths written, in a stable order
 * (`devcontainer.json` first), for callers that report them.
 *
 * `copyBundledAssets` writes files 0644, so the chmod is what lets a dev run the scripts by hand
 * (`post-create.sh` invokes its steps via `bash`, so this is cleanliness rather than
 * correctness). The list is deliberately fixed rather than derived: a new top-level `*.sh` that a
 * user template adds does not get the exec bit, which is cosmetic since both lifecycle hooks are
 * invoked as `bash "<path>"`.
 */
export async function installBundledAssets(
  destDir: string,
  templatesDir: string = TEMPLATES_DIR,
): Promise<string[]> {
  await copyBundledAssets(destDir, templatesDir);

  const scriptsDir = `${destDir}/scripts`;
  const executable = [
    `${destDir}/post-create.sh`,
    `${destDir}/initialize-command.sh`,
  ];
  const entries = await readdir(scriptsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.sh')) {
      executable.push(`${scriptsDir}/${entry.name}`);
    }
  }
  for (const path of executable) await chmod(path, 0o755);

  return [
    `${destDir}/devcontainer.json`,
    `${destDir}/Dockerfile`,
    `${destDir}/post-create.sh`,
    `${destDir}/initialize-command.sh`,
    scriptsDir,
  ];
}

/**
 * Substitutes `devcontainer.json`-style variables in a string value:
 * `${containerWorkspaceFolder}`, `${localEnv:VARNAME}`, and — when
 * `localWorkspaceFolder` is supplied — `${localWorkspaceFolder}` and
 * `${localWorkspaceFolderBasename}`. Anything else (`${containerEnv:...}`,
 * `${devcontainerId}`, …) is left as-is: values passed directly to Docker (e.g. `-e`) are
 * never processed by the `devcontainer` CLI, and the rest cannot be resolved host-side.
 *
 * `containerWorkspaceFolder` is the caller-supplied container-side mount path — the
 * `remoteWorkspaceFolder` reported by `devcontainer up`, which accounts for both plain
 * workspaces and git worktrees.
 */
export function substituteVars(
  value: string,
  containerWorkspaceFolder: string,
  localWorkspaceFolder?: string,
): string {
  let out = value.replaceAll(
    '${containerWorkspaceFolder}',
    containerWorkspaceFolder,
  );
  if (localWorkspaceFolder !== undefined) {
    // Basename first: `${localWorkspaceFolder}` is a prefix of
    // `${localWorkspaceFolderBasename}`, so the other order would rewrite the longer token
    // into `<path>Basename}`.
    out = out
      .replaceAll(
        '${localWorkspaceFolderBasename}',
        basenamePosix(localWorkspaceFolder),
      )
      .replaceAll('${localWorkspaceFolder}', localWorkspaceFolder);
  }
  return out.replace(/\$\{localEnv:([^}]+)\}/g, (_, varName: string) => {
    return varName === 'HOME' ? homeDir() : process.env[varName] ?? '';
  });
}

interface DevcontainerJson {
  remoteEnv?: Record<string, unknown>;
}

/**
 * Reads `remoteEnv` from the devcontainer config at `configPath` and resolves the variables
 * {@link substituteVars} handles in each value. Returns `{}` if the config defines no
 * `remoteEnv`.
 *
 * This is what makes `remoteEnv` reach `devc exec`/`attach`: those run via `docker exec`,
 * which applies the container's `containerEnv` but never `remoteEnv` — `remoteEnv` is applied
 * by the *client* per connection (VS Code to its terminals, `devcontainer exec` to its child)
 * and is not stored on the container for anyone to inherit. So devc re-derives it.
 *
 * `configPath` is whichever config is in play: the project's own in project mode, the
 * materialized bundled default in the zero-config path. Because it may therefore be a file a
 * user hand-wrote, parsing is deliberately forgiving — JSONC (comments, trailing commas) is
 * parsed properly, and a config this cannot read degrades to `{}` with a warning rather than
 * throwing, so a malformed or exotic config costs env vars instead of breaking `devc exec`
 * outright. Non-string values are skipped for the same reason (the spec says strings).
 */
export async function loadResolvedRemoteEnv(
  configPath: string,
  containerWorkspaceFolder: string,
  localWorkspaceFolder?: string,
): Promise<Record<string, string>> {
  let config: DevcontainerJson | null;
  try {
    const text = await readFile(configPath, 'utf8');
    const errors: ParseError[] = [];
    config = parseJsoncLoose(text, errors, { allowTrailingComma: true }) as
      | DevcontainerJson
      | null;
    if (errors.length > 0) {
      const [first] = errors;
      throw new SyntaxError(
        `JSONC parse error ${first.error} at offset ${first.offset}`,
      );
    }
  } catch (err) {
    logWarning(
      `devc: could not read remoteEnv from ${configPath} (${
        err instanceof Error ? err.message : err
      }) — continuing without it`,
    );
    return {};
  }

  const baseEnv = config?.remoteEnv ?? {};
  return Object.fromEntries(
    Object.entries(baseEnv)
      .filter((entry): entry is [string, string] =>
        typeof entry[1] === 'string'
      )
      .map(([k, v]) => [
        k,
        substituteVars(v, containerWorkspaceFolder, localWorkspaceFolder),
      ]),
  );
}
