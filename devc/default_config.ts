import { parse as parseJsonc } from 'jsr:@std/jsonc';
import { basenamePosix } from './posix.ts';

// Embedded `devc/default/` directory, read via Deno.readDir/Deno.readFile.
// Under `deno run` this resolves to the real source tree; under a
// `deno compile --include default` binary it resolves to the embedded
// virtual filesystem.
const DEFAULT_DIR_URL = new URL('./default/', import.meta.url);

/** The global config directory, `~/.config/devc`. */
export const CONFIG_DIR = `${homeDir()}/.config/devc`;

/**
 * User-level template directory, `~/.config/devc/templates`. A **sparse** overlay on the bundled
 * `default/` tree: any file placed here overrides the same-named bundled file, per file, in both
 * the zero-config cache ({@link materializeDefaultConfig}) and what `devc init` writes into a
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
 * So it is skipped, and {@link overlayDirFrom} says so on stderr: silently dropping the file would
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
  const created = await Deno.lstat(seedDir).then(() => false).catch(() => true);
  try {
    await Deno.mkdir(seedDir, { recursive: true });
  } catch (err) {
    // Recursive mkdir is not quite `mkdir -p`: it reports AlreadyExists when the path is a
    // regular file or a dangling symlink. Fall through to the guard, which says why.
    if (!(err instanceof Deno.errors.AlreadyExists)) throw err;
  }

  // Verify we actually have a directory — otherwise the problem resurfaces later as an opaque
  // "bind source path does not exist" from Docker.
  const stat = await Deno.stat(seedDir).catch(() => null);
  if (stat === null || !stat.isDirectory) {
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
      await Deno.stat(path);
      return path;
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) throw err;
    }
  }
  return null;
}

function homeDir(): string {
  return Deno.env.get('HOME') ?? Deno.env.get('USERPROFILE') ?? '.';
}

/** Recursively copies the embedded `default/` tree to a real directory on disk. */
async function copyDir(sourceUrl: URL, destDir: string): Promise<void> {
  await Deno.mkdir(destDir, { recursive: true });
  for await (const entry of Deno.readDir(sourceUrl)) {
    if (entry.isDirectory) {
      await copyDir(
        new URL(`${entry.name}/`, sourceUrl),
        `${destDir}/${entry.name}`,
      );
    } else {
      const bytes = await Deno.readFile(new URL(entry.name, sourceUrl));
      await Deno.writeFile(`${destDir}/${entry.name}`, bytes);
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
 * `Deno.copyFile` rather than read+write: unlike {@link copyDir}'s embedded-asset path, this
 * copies from a real filesystem where the user's own modes are worth preserving.
 */
async function overlayDirFrom(
  sourceDir: string,
  destDir: string,
  topLevel = true,
): Promise<void> {
  const entries: Deno.DirEntry[] = [];
  try {
    for await (const entry of Deno.readDir(sourceDir)) entries.push(entry);
  } catch (err) {
    // A missing template dir is the common case — it is never seeded.
    if (err instanceof Deno.errors.NotFound) return;
    throw err;
  }

  await Deno.mkdir(destDir, { recursive: true });
  for (const entry of entries) {
    if (
      topLevel && !entry.isDirectory &&
      TEMPLATE_OVERLAY_FILENAMES.includes(entry.name)
    ) {
      console.error(
        `devc: ignoring ${sourceDir}/${entry.name} — the devc.json overlay is read from ` +
          `${CONFIG_DIR}/devc.jsonc, not from the templates directory (which holds files copied ` +
          `into a project's .devcontainer/). Move it up one level to apply it to every project.`,
      );
      continue;
    }
    if (entry.isDirectory) {
      await overlayDirFrom(
        `${sourceDir}/${entry.name}`,
        `${destDir}/${entry.name}`,
        false,
      );
    } else {
      await Deno.copyFile(
        `${sourceDir}/${entry.name}`,
        `${destDir}/${entry.name}`,
      );
    }
  }
}

/**
 * Copies the embedded `devc/default/` tree into `cacheDir` (default
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
 * - `initializeCommand` runs on the *host* → resolved to `initialize-command.sh` in this
 *   cache dir.
 * - `postCreateCommand` runs in the *container* → resolved to the image-baked
 *   `post-create.sh` (which the Dockerfile `COPY`s in for exactly this case).
 *
 * Plain string replaces preserve the config's comments; the tokens match the source verbatim.
 * These rewrites are why the project-mode config can reference clean in-project paths (so edits
 * apply on recreate) while the hidden zero-config copy still resolves.
 *
 * `cacheDir` / `templatesDir` default to the real `~/.cache/devc/default` and
 * {@link TEMPLATES_DIR}, and only need overriding in tests.
 */
export async function materializeDefaultConfig(
  cacheDir: string = `${homeDir()}/.cache/devc/default`,
  templatesDir: string = TEMPLATES_DIR,
): Promise<string> {
  // Remove any prior copy so files dropped between versions don't linger.
  await Deno.remove(cacheDir, { recursive: true }).catch(() => {});
  await copyDir(DEFAULT_DIR_URL, cacheDir);
  await overlayDirFrom(templatesDir, cacheDir);

  const configPath = `${cacheDir}/devcontainer.json`;
  const raw = await Deno.readTextFile(configPath);
  const rewritten = raw
    .replaceAll(
      '${localWorkspaceFolder}/.devcontainer/initialize-command.sh',
      `${cacheDir}/initialize-command.sh`,
    )
    .replaceAll(
      '${containerWorkspaceFolder}/.devcontainer/post-create.sh',
      '/usr/local/share/devc/post-create.sh',
    );
  if (rewritten !== raw) await Deno.writeTextFile(configPath, rewritten);

  return configPath;
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
  for await (const entry of Deno.readDir(scriptsDir)) {
    if (entry.isFile && entry.name.endsWith('.sh')) {
      executable.push(`${scriptsDir}/${entry.name}`);
    }
  }
  for (const path of executable) await Deno.chmod(path, 0o755);

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
    return varName === 'HOME' ? homeDir() : Deno.env.get(varName) ?? '';
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
    const text = await Deno.readTextFile(configPath);
    config = parseJsonc(text) as DevcontainerJson | null;
  } catch (err) {
    console.error(
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
