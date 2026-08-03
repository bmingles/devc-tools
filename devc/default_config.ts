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
 * Copies the embedded `devc/default/` tree flat into `cacheDir` (default
 * `~/.cache/devc/default`), overwriting any existing copy, then rewrites the
 * copied `devcontainer.json` for zero-config use and returns its path — suitable
 * for `devcontainer up --config <path>`. There is no user-editable global
 * template override dir — customization happens per-project via `devc config`.
 *
 * **Zero-config transform.** The bundled default references the devc baseline as
 * a local Feature (`"./features/devc"`), but `@devcontainers/cli` validates a
 * local Feature against `<workspaceRoot>/.devcontainer` (the user's repo), not
 * the config's own directory. Since `devc up` loads this config out-of-tree via
 * `--config`, the Feature can never resolve here (no path form reaches the cache;
 * absolute paths are rejected outright). So the Feature reference is stripped and
 * the same baseline is delivered another way: build-time bits are baked by the
 * bundled `Dockerfile`, and the runtime bits run via a top-level
 * `postCreateCommand` pointing at the script the Dockerfile installed. The
 * `features/` subtree is still materialized (the Dockerfile `COPY`s scripts from
 * it) — it is simply not referenced by the transformed config. The cache copy is
 * machine-only, so rewriting it as comment-free JSON is fine.
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
  // deno-lint-ignore no-explicit-any
  const config: any = JSON.parse(stripLineComments(raw));
  if (config.features && typeof config.features === "object") {
    delete config.features["./features/devc"];
  }
  config.postCreateCommand = "/usr/local/share/devc/post-create.sh";
  await Deno.writeTextFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

  return configPath;
}

/**
 * The bundled default assets the `config` wizard needs: the `devcontainer.json` text (used as
 * the base for a first-creation), the `Dockerfile` bytes (copied verbatim), and the URL of the
 * embedded `features/` subtree (copied into the project so `"./features/devc"` resolves).
 */
export interface BundledDefault {
  /** The default `devcontainer.json` source text, exactly as embedded. */
  devcontainerJson: string;
  /** The default `Dockerfile` bytes, exactly as embedded. */
  dockerfile: Uint8Array;
  /** URL of the embedded `features/` directory, for a recursive copy. */
  featuresDirUrl: URL;
}

/** Read the embedded default assets the wizard writes on first creation. */
export async function loadBundledDefault(): Promise<BundledDefault> {
  const devcontainerJson = await Deno.readTextFile(
    new URL("devcontainer.json", DEFAULT_DIR_URL),
  );
  const dockerfile = await Deno.readFile(
    new URL("Dockerfile", DEFAULT_DIR_URL),
  );
  return {
    devcontainerJson,
    dockerfile,
    featuresDirUrl: new URL("features/", DEFAULT_DIR_URL),
  };
}

/** Recursively copy the embedded `default/features/` subtree into `destDir` (`.../features`). */
export async function copyBundledFeatures(destDir: string): Promise<void> {
  await copyDir(new URL("features/", DEFAULT_DIR_URL), destDir);
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
