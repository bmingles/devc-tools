// Embedded `devc/default/` directory, read via Deno.readDir/Deno.readFile.
// Under `deno run` this resolves to the real source tree; under a
// `deno compile --include default` binary it resolves to the embedded
// virtual filesystem.
const DEFAULT_DIR_URL = new URL("./default/", import.meta.url);

/**
 * The global config directory. `~/.config/devc-tui` **for now**, to avoid
 * colliding with any pre-existing `~/.config/devc/` from other `devc` tooling
 * while this implementation matures. This lives behind this single constant;
 * once this tool is robust enough to replace existing tooling, it flips to
 * `~/.config/devc`.
 */
export const CONFIG_DIR = `${homeDir()}/.config/devc-tui`;

/**
 * Host directory holding the user's `~/.claude` config for containers. Bind-mounted read-only
 * at `CLAUDE_SEED_TARGET`; `post-create.sh` symlinks every top-level *file* from it into the
 * `~/.claude` volume (directories are ignored — the `devc:skills` fence owns
 * `~/.claude/skills/`).
 */
export const CLAUDE_SEED_HOST_DIR = `${CONFIG_DIR}/.claude`;

/** Container path the seed directory is bind-mounted at (mirrors the bundled default). */
export const CLAUDE_SEED_TARGET = "/usr/local/share/devc/claude-seed";

/**
 * Files copied out of `~/.claude` into the seed directory the first time it is created, so an
 * existing setup keeps working after the switch from three per-file bind mounts. The rename
 * drops the `.devc` suffix, which only existed to avoid colliding with the real
 * `~/.claude/settings.json`; a dedicated directory removes the collision.
 */
const CLAUDE_SEED_MIGRATIONS: ReadonlyArray<readonly [string, string]> = [
  ["CLAUDE.md", "CLAUDE.md"],
  ["settings.devc.json", "settings.json"],
  ["statusline.sh", "statusline.sh"],
];

/** Outcome of `ensureClaudeSeedDir`. */
export interface ClaudeSeedResult {
  /** True when this call created the directory (false when it already existed). */
  created: boolean;
  /** Seed-side names copied from `~/.claude` (empty unless this call created the directory). */
  migrated: string[];
}

/**
 * Create the host seed directory if absent, and on first creation only, copy the three files
 * the old per-file bind mounts referenced out of `migrateFrom`.
 *
 * The bundled default's `initializeCommand` also creates this directory, so a project config
 * works without `devc` installed. This function still runs on every `up` because it owns the
 * things a shell one-liner cannot: the not-a-directory guard and the one-time migration.
 *
 * Migration is gated on *this call* having created the directory, so files the user later
 * deletes from the seed are not resurrected on the next `up`. Host originals are left in
 * place. `Deno.copyFile` copies permissions on Unix, so `statusline.sh` keeps its exec bit.
 *
 * `seedDir` / `migrateFrom` default to the real paths and only need overriding in tests.
 */
export async function ensureClaudeSeedDir(
  seedDir: string = CLAUDE_SEED_HOST_DIR,
  migrateFrom: string = `${homeDir()}/.claude`,
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
  if (!created) return { created, migrated: [] };

  const migrated: string[] = [];
  for (const [from, to] of CLAUDE_SEED_MIGRATIONS) {
    try {
      await Deno.copyFile(`${migrateFrom}/${from}`, `${seedDir}/${to}`);
      migrated.push(to);
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) throw err;
    }
  }
  return { created, migrated };
}

/**
 * True if `localFolder` has its own devcontainer config
 * (`.devcontainer/devcontainer.json` or `.devcontainer.json`), i.e. "project mode"
 * should be used.
 */
export async function hasOwnDevcontainerConfig(
  localFolder: string,
): Promise<boolean> {
  for (const rel of [".devcontainer/devcontainer.json", ".devcontainer.json"]) {
    try {
      await Deno.stat(`${localFolder}/${rel}`);
      return true;
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) throw err;
    }
  }
  return false;
}

function homeDir(): string {
  return Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? ".";
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
 * Copies the embedded `devc/default/` tree verbatim into `cacheDir` (default
 * `~/.cache/devc/default`), overwriting any existing copy, and returns the path
 * to the copied `devcontainer.json` — suitable for `devcontainer up --config
 * <path>`. There is no user-editable global template override dir — customization
 * happens per-project via `devc config`.
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
 * `cacheDir` defaults to the real `~/.cache/devc/default` and only needs
 * overriding in tests.
 */
export async function materializeDefaultConfig(
  cacheDir: string = `${homeDir()}/.cache/devc/default`,
): Promise<string> {
  // Remove any prior copy so files dropped between versions don't linger.
  await Deno.remove(cacheDir, { recursive: true }).catch(() => {});
  await copyDir(DEFAULT_DIR_URL, cacheDir);

  const configPath = `${cacheDir}/devcontainer.json`;
  const raw = await Deno.readTextFile(configPath);
  const rewritten = raw
    .replaceAll(
      "${localWorkspaceFolder}/.devcontainer/initialize-command.sh",
      `${cacheDir}/initialize-command.sh`,
    )
    .replaceAll(
      "${containerWorkspaceFolder}/.devcontainer/post-create.sh",
      "/usr/local/share/devc/post-create.sh",
    );
  if (rewritten !== raw) await Deno.writeTextFile(configPath, rewritten);

  return configPath;
}

/**
 * Read the embedded `default/devcontainer.json` text — the base a first-creation `devc config`
 * inserts its two fences into. Every *other* bundled file (Dockerfile, `post-create.sh`,
 * `initialize-command.sh`, `scripts/`) is written by {@link copyBundledAssets}.
 */
export async function loadBundledDevcontainerJson(): Promise<string> {
  return await Deno.readTextFile(new URL("devcontainer.json", DEFAULT_DIR_URL));
}

/**
 * Copy every embedded `default/` asset *except* `devcontainer.json` into `destDir`
 * (a project's `.devcontainer/`): the `Dockerfile`, the `post-create.sh` and
 * `initialize-command.sh` lifecycle entry scripts, and the `scripts/` sub-dependency
 * subtree. `devcontainer.json` is skipped because the wizard writes it itself (fenced).
 */
export async function copyBundledAssets(destDir: string): Promise<void> {
  await Deno.mkdir(destDir, { recursive: true });
  for await (const entry of Deno.readDir(DEFAULT_DIR_URL)) {
    if (entry.name === "devcontainer.json") continue;
    if (entry.isDirectory) {
      await copyDir(
        new URL(`${entry.name}/`, DEFAULT_DIR_URL),
        `${destDir}/${entry.name}`,
      );
    } else {
      const bytes = await Deno.readFile(new URL(entry.name, DEFAULT_DIR_URL));
      await Deno.writeFile(`${destDir}/${entry.name}`, bytes);
    }
  }
}

/**
 * Substitutes `${localEnv:VARNAME}` and `${containerWorkspaceFolder}` in a
 * string value. These are the only two `devcontainer.json`-style variables
 * resolved here — values passed directly to Docker (e.g. `-e`) are not
 * processed by the `devcontainer` CLI, so anything else
 * (`${localWorkspaceFolder}`, `${localWorkspaceFolderBasename}`,
 * `${containerEnv:...}`, etc.) is left as-is.
 *
 * `containerWorkspaceFolder` is the caller-supplied container-side mount path
 * (see `computeContainerWorkspaceFolder` in `container.ts`), which accounts for
 * both plain workspaces and git worktrees.
 */
export function substituteVars(
  value: string,
  containerWorkspaceFolder: string,
): string {
  return value
    .replaceAll("${containerWorkspaceFolder}", containerWorkspaceFolder)
    .replace(/\$\{localEnv:([^}]+)\}/g, (_, varName: string) => {
      return varName === "HOME" ? homeDir() : Deno.env.get(varName) ?? "";
    });
}

/** Strips `//`-to-end-of-line comments from lines that contain nothing else (no string tokens before the `//`). Safe for devcontainer.json where all comments are on their own lines. */
function stripLineComments(text: string): string {
  return text.split("\n").filter((line) => !/^\s*\/\//.test(line)).join("\n");
}

interface DevcontainerJson {
  remoteEnv?: Record<string, string>;
}

/**
 * Reads `remoteEnv` from the materialized default config at `configPath` and
 * resolves `${containerWorkspaceFolder}` and `${localEnv:VAR}` in all values.
 * Returns `{}` if the config defines no `remoteEnv`. There is no project
 * overlay merge — `remoteEnv` comes solely from the materialized default.
 */
export async function loadResolvedRemoteEnv(
  configPath: string,
  containerWorkspaceFolder: string,
): Promise<Record<string, string>> {
  const text = await Deno.readTextFile(configPath);
  const config: DevcontainerJson = JSON.parse(stripLineComments(text));
  const baseEnv: Record<string, string> = config.remoteEnv ?? {};

  return Object.fromEntries(
    Object.entries(baseEnv).map((
      [k, v],
    ) => [k, substituteVars(v, containerWorkspaceFolder)]),
  );
}
