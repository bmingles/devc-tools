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
 * Copies the embedded `devc/default/` tree straight to `cacheDir` (default
 * `~/.cache/devc/default`), overwriting any existing copy, and returns the path
 * to the materialized `devcontainer.json`, suitable for `devcontainer up
 * --config <path>`. There is no user-editable global template override dir —
 * customization happens per-project via `devc config`.
 *
 * `cacheDir` defaults to the real `~/.cache/devc/default` and only needs
 * overriding in tests.
 */
export async function materializeDefaultConfig(
  cacheDir: string = `${homeDir()}/.cache/devc/default`,
): Promise<string> {
  await copyDir(DEFAULT_DIR_URL, cacheDir);
  return `${cacheDir}/devcontainer.json`;
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
