import { normalizePath as _normalizePath } from "./paths.ts";
import { basenamePosix, dirnamePosix, resolvePosix } from "./posix.ts";
import {
  CLAUDE_SEED_HOST_DIR,
  ensureClaudeSeedDir,
  findOwnDevcontainerConfig,
  loadResolvedRemoteEnv,
  materializeDefaultConfig,
} from "./default_config.ts";
import { displayPath } from "./config.ts";

export type ContainerStatus = "running" | "stopped" | "missing";

export interface ContainerInfo {
  containerId: string;
  remoteUser: string;
  remoteWorkspaceFolder: string;
  remoteEnv: Record<string, string>;
}

export interface ExecOptions {
  /** Container-side working directory. Defaults to remoteWorkspaceFolder. */
  cwd?: string;
  /** Extra env, applied on top of the container's remoteEnv. */
  env?: Record<string, string>;
  /** argv[0] and its arguments, exec'd directly (no shell). */
  cmd: string[];
}

export interface ContainerMount {
  type: "bind" | "volume";
  /** Host-side path. For volumes, the docker-managed `/var/lib/docker/...` dir. */
  source: string;
  /** Container-side mount point. */
  destination: string;
  rw: boolean;
}

function normalizePath(p: string): string {
  return _normalizePath(p).toLowerCase();
}

/**
 * Finds the container labeled `devcontainer.local_folder=<localFolder>` (after
 * `normalizePath`). `all` controls whether stopped containers are included
 * (`docker ps -a`) or only running ones (`docker ps`). Returns `null` if docker
 * errors or no container matches.
 */
async function findContainer(
  localFolder: string,
  all: boolean,
): Promise<{ id: string; state: string } | null> {
  const cmd = new Deno.Command("docker", {
    args: [
      "ps",
      ...(all ? ["-a"] : []),
      "--filter",
      "label=devcontainer.local_folder",
      "--format",
      '{{.ID}}\t{{.Label "devcontainer.local_folder"}}\t{{.State}}',
    ],
    stdout: "piped",
    stderr: "inherit",
  });

  const { code, stdout } = await cmd.output();
  if (code !== 0) return null;

  const target = normalizePath(localFolder);
  const lines = new TextDecoder().decode(stdout).trim().split("\n").filter(
    Boolean,
  );

  for (const line of lines) {
    const [id, labelPath, state] = line.split("\t");
    if (normalizePath(labelPath) === target) return { id, state };
  }

  return null;
}

export async function getContainerStatus(
  localFolder: string,
): Promise<ContainerStatus> {
  const found = await findContainer(localFolder, true);
  if (found === null) return "missing";
  return found.state === "running" ? "running" : "stopped";
}

/**
 * Builds the `docker exec` argv for a non-interactive run: `-i` (never `-t`),
 * `-u remoteUser`, `-w cwd`, one `-e K=V` per env entry (remoteEnv first, then
 * `env` — so `env` overrides `remoteEnv` on key collision), the container id, and
 * finally `cmd` verbatim. Pure/exported for unit testing.
 */
export function buildExecArgs(input: {
  containerId: string;
  remoteUser: string;
  cwd: string;
  remoteEnv: Record<string, string>;
  env: Record<string, string>;
  cmd: string[];
}): string[] {
  const { containerId, remoteUser, cwd, remoteEnv, env, cmd } = input;
  // `env` overrides `remoteEnv` on key collision; spreading in this order keeps
  // one entry per key with `env`'s value winning.
  const merged = { ...remoteEnv, ...env };
  const envFlags = Object.entries(merged).flatMap((
    [k, v],
  ) => ["-e", `${k}=${v}`]);
  return [
    "exec",
    "-i",
    ...envFlags,
    "-u",
    remoteUser,
    "-w",
    cwd,
    containerId,
    ...cmd,
  ];
}

/**
 * Ensures the container for `localFolder` is running (via `startContainer`,
 * rebuild=false), then runs `opts.cmd` non-interactively via `docker exec -i`
 * (no TTY), with `-u remoteUser`, `-w (opts.cwd ?? remoteWorkspaceFolder)`, and
 * `-e` flags for remoteEnv then opts.env. stdin/stdout/stderr are inherited so
 * the caller streams straight through. Resolves to the command's exit code.
 * Throws only on infra failure (container won't start / docker not runnable).
 */
export async function execInContainer(
  localFolder: string,
  opts: ExecOptions,
): Promise<number> {
  const info = await startContainer(localFolder, false);
  const args = buildExecArgs({
    containerId: info.containerId,
    remoteUser: info.remoteUser,
    cwd: opts.cwd ?? info.remoteWorkspaceFolder,
    remoteEnv: info.remoteEnv,
    env: opts.env ?? {},
    cmd: opts.cmd,
  });
  const { code } = await new Deno.Command("docker", {
    args,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn().status;
  return code;
}

/**
 * Parses the JSON emitted by `docker inspect --format '{{json .Mounts}}'` into a
 * `ContainerMount[]`. Maps `Type → type`, `Source → source`, `Destination →
 * destination`, `RW → rw`. `null`/empty/unparseable input → `[]`. Pure/exported
 * for unit testing.
 */
export function parseMounts(json: string | null): ContainerMount[] {
  if (!json) return [];
  // deno-lint-ignore no-explicit-any
  let raw: any;
  try {
    raw = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  return raw.map((m) => ({
    type: m.Type === "volume" ? "volume" : "bind",
    source: m.Source,
    destination: m.Destination,
    rw: m.RW === true,
  }));
}

/**
 * Returns the mount table for `localFolder`'s container (found via
 * `findContainer(localFolder, true)` — running or stopped, never started), from
 * `docker inspect --format '{{json .Mounts}}'`. Returns `null` if no container
 * matches. Does not resolve symlinks in `source` (the caller does).
 */
export async function getContainerMounts(
  localFolder: string,
): Promise<ContainerMount[] | null> {
  const found = await findContainer(localFolder, true);
  if (found === null) return null;
  const json = await dockerInspect(found.id, "{{json .Mounts}}");
  return parseMounts(json);
}

async function isGitWorktree(localFolder: string): Promise<boolean> {
  const [commonDir, gitDir] = await Promise.all([
    new Deno.Command("git", {
      args: ["-C", localFolder, "rev-parse", "--git-common-dir"],
      stdout: "piped",
      stderr: "null",
    }).output(),
    new Deno.Command("git", {
      args: ["-C", localFolder, "rev-parse", "--git-dir"],
      stdout: "piped",
      stderr: "null",
    }).output(),
  ]);
  if (commonDir.code !== 0 || gitDir.code !== 0) return false;
  return new TextDecoder().decode(commonDir.stdout).trim() !==
    new TextDecoder().decode(gitDir.stdout).trim();
}

async function runGitRevParse(
  cwd: string,
  flag: string,
): Promise<string | null> {
  const cmd = new Deno.Command("git", {
    args: ["-C", cwd, "rev-parse", flag],
    stdout: "piped",
    stderr: "null",
  });
  const { code, stdout } = await cmd.output();
  if (code !== 0) return null;
  return new TextDecoder().decode(stdout).trim();
}

/**
 * Resolves a user-supplied path argument to an absolute, slash-normalized path
 * against `cwd` (default: the process cwd). A bare relative path such as `.` must
 * become absolute before it reaches container naming
 * (`containerNameForLocalFolder`), `computeContainerWorkspaceFolder`, or the
 * `devcontainer.local_folder` label match in `findContainer` — otherwise `.`
 * yields the invalid image tag `devc-.-<hash>` and a `/workspaces/.` workspace
 * folder, and fails to match the absolute path the `devcontainer` CLI records in
 * the label (so `status`/`stop`/`down`/`mounts` can't find the container). An
 * already-absolute argument is returned normalized as-is. Mirrors how
 * `devcontainer up` resolves `--workspace-folder` internally.
 */
export function resolveLocalFolder(
  pathArg?: string,
  cwd: string = Deno.cwd(),
): string {
  return resolvePosix(_normalizePath(cwd), _normalizePath(pathArg ?? "."));
}

/**
 * Computes the absolute container-side path where `devcontainer up` will mount
 * `localFolder`, replicating the `devcontainer` CLI's algorithm (verified against
 * 0.87.0) for both plain directories and git worktrees mounted with
 * `--mount-git-worktree-common-dir`.
 *
 * - Non-git directories and non-worktree repos: `/workspaces/<basename(localFolder)>`.
 * - Git worktrees: walks up from `localFolder` to the common ancestor of
 *   `localFolder` and the main repo's `.git` directory (from
 *   `git rev-parse --git-common-dir`), then returns
 *   `/workspaces/<relative path from that ancestor to localFolder>`.
 */
export async function computeContainerWorkspaceFolder(
  localFolder: string,
): Promise<string> {
  const normalizedLocal = _normalizePath(localFolder);

  const cdup = await runGitRevParse(localFolder, "--show-cdup");
  const gitRoot = cdup === null || cdup === ""
    ? normalizedLocal
    : resolvePosix(normalizedLocal, cdup);

  const [commonDir, gitDir] = await Promise.all([
    runGitRevParse(gitRoot, "--git-common-dir"),
    runGitRevParse(gitRoot, "--git-dir"),
  ]);

  if (commonDir === null || gitDir === null || commonDir === gitDir) {
    return `/workspaces/${basenamePosix(gitRoot)}`;
  }

  const commonGitDir = resolvePosix(gitRoot, commonDir);
  const target = dirnamePosix(commonGitDir);

  const segments: string[] = [];
  let f = gitRoot;
  while (
    normalizePath(target) !== normalizePath(f) &&
    !normalizePath(target).startsWith(`${normalizePath(f)}/`)
  ) {
    segments.unshift(basenamePosix(f));
    const parent = dirnamePosix(f);
    if (parent === f) break;
    f = parent;
  }

  return `/workspaces/${segments.join("/")}`;
}

/**
 * Derives a deterministic container name for `localFolder`:
 * `devc-<sanitized-basename>-<8-hex-sha256-prefix>`, mirroring the devcontainer CLI's
 * `vsc-<workspaceFolderBasename>-<hash>` convention for auto-built image tags. The hash
 * is over `normalizePath(localFolder)` (lowercased), so:
 *  - the name is stable across runs for the same folder
 *  - two folders with the same basename (e.g. two checkouts of the same repo) get
 *    different names
 * The basename is sanitized to `[a-zA-Z0-9_.-]` (other characters become `-`); an empty
 * basename (e.g. `localFolder === "/"`) falls back to `"workspace"`. The `devc-` prefix
 * guarantees the result starts with an alphanumeric character (Docker container name
 * requirement) even if the basename starts with `.` or `-`.
 */
export async function containerNameForLocalFolder(
  localFolder: string,
): Promise<string> {
  const normalized = normalizePath(localFolder);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(normalized),
  );
  const hash = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 8);
  const base = basenamePosix(normalized).replace(/[^a-zA-Z0-9_.-]/g, "-") ||
    "workspace";
  return `devc-${base}-${hash}`;
}

async function dockerInspect(
  containerId: string,
  format: string,
): Promise<string | null> {
  try {
    const cmd = new Deno.Command("docker", {
      args: ["inspect", "--format", format, containerId],
      stdout: "piped",
      stderr: "null",
    });
    const { code, stdout } = await cmd.output();
    if (code !== 0) return null;
    return new TextDecoder().decode(stdout).trim();
  } catch {
    return null;
  }
}

/**
 * Best-effort: if the container's current name (from `docker inspect --format
 * '{{.Name}}'`, with the leading `/` stripped) already equals `desiredName`, returns
 * (no-op — the reuse/restart case).
 *
 * Otherwise, checks whether some *other* container already holds `desiredName` (via
 * `docker ps -a --filter name=^<desiredName>$ --format '{{.ID}}'`, excluding
 * `containerId`). If found, prints a warning to stderr identifying the conflicting
 * container (its ID and its `devcontainer.local_folder` label, fetched via `docker
 * inspect --format '{{index .Config.Labels "devcontainer.local_folder"}}'`) and
 * returns without renaming — `containerId` keeps its Docker-assigned name for now.
 *
 * Otherwise (no conflict) runs `docker rename <containerId> <desiredName>`.
 *
 * Never throws and never aborts `devc attach` — naming is cosmetic — but a conflict
 * is surfaced loudly (stderr warning with a concrete next step) rather than swallowed,
 * since an unrenamed container is otherwise indistinguishable from one where renaming
 * was simply never attempted.
 */
async function renameContainerIfNeeded(
  containerId: string,
  desiredName: string,
  localFolder: string,
): Promise<void> {
  try {
    const currentName = await dockerInspect(containerId, "{{.Name}}");
    if (
      currentName !== null && currentName.replace(/^\//, "") === desiredName
    ) return;

    const cmd = new Deno.Command("docker", {
      args: [
        "ps",
        "-a",
        "--filter",
        `name=^${desiredName}$`,
        "--format",
        "{{.ID}}",
      ],
      stdout: "piped",
      stderr: "null",
    });
    const { stdout } = await cmd.output();
    const conflictId = new TextDecoder().decode(stdout).trim().split("\n")
      .map((id) => id.trim())
      .find((id) => id && id !== containerId);

    if (conflictId) {
      const otherLocalFolder = await dockerInspect(
        conflictId,
        '{{index .Config.Labels "devcontainer.local_folder"}}',
      );
      console.error(
        `warning: could not rename container ${containerId} (workspace: ${localFolder}) to ` +
          `"${desiredName}" — container ${conflictId} (workspace: ${
            otherLocalFolder ?? "unknown"
          }) ` +
          `already has that name. If ${conflictId} is being removed, this is transient — re-run ` +
          `\`devc attach\` once it's gone. ${containerId} will keep its default name for now.`,
      );
      return;
    }

    await new Deno.Command("docker", {
      args: ["rename", containerId, desiredName],
      stdout: "null",
      stderr: "inherit",
    }).output();
  } catch {
    // naming is cosmetic — never abort devc attach
  }
}

/**
 * Best-effort: tags the image currently used by `containerId` (its image ID, from
 * `docker inspect --format '{{.Image}}'`) as `<name>:latest` — an *additional* alias
 * tag, not a replacement. Does not remove or alter the devcontainer CLI's own
 * `vsc-<basename>-<hash>` tag, which the CLI uses to detect "image already built,
 * skip rebuild" on the next `up`; deleting or repointing that tag would force a
 * rebuild on every `devc attach`. `docker tag` is idempotent/overwriting, so calling
 * this on every `startContainer` keeps the alias pointing at the current image even
 * after a rebuild. Swallows failures from either `docker` call.
 */
async function tagImageIfNeeded(
  containerId: string,
  name: string,
): Promise<void> {
  try {
    const imageId = await dockerInspect(containerId, "{{.Image}}");
    if (imageId === null) return;

    await new Deno.Command("docker", {
      args: ["tag", imageId, `${name}:latest`],
      stdout: "null",
      stderr: "inherit",
    }).output();
  } catch {
    // image alias tagging is cosmetic — never abort devc attach
  }
}

/**
 * Best-effort dump of captured `devcontainer up` stdout to stderr when a build
 * fails. The CLI emits one JSON log record per line (typically
 * `{"type":"...","level":N,"text":"..."}`); we print each record's `text` field
 * when present, falling back to the raw line. This is the "print on failure"
 * diagnostic — stdout is otherwise consumed only to parse the final outcome JSON,
 * so postCreate/build detail on it would be invisible.
 */
function dumpBuildOutput(text: string): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  console.error("--- devcontainer up output ---");
  for (const line of trimmed.split("\n")) {
    try {
      const rec = JSON.parse(line);
      console.error(
        typeof rec?.text === "string" ? rec.text.replace(/\r?\n$/, "") : line,
      );
    } catch {
      console.error(line);
    }
  }
  console.error("--- end devcontainer up output ---");
}

/**
 * Fail-fast guard for the container-creating commands (attach/claude/up/exec):
 * throws if `localFolder` doesn't exist or isn't a directory, so a mistyped path
 * never reaches `devcontainer up` — which would otherwise try to build a brand-new
 * container for the bogus path. Lookup-only commands (status/stop/down/mounts) do
 * not use this: for them a missing directory simply has no matching container.
 */
export function assertLocalFolderExists(localFolder: string): void {
  let stat: Deno.FileInfo;
  try {
    stat = Deno.statSync(localFolder);
  } catch {
    throw new Error(`no such directory: ${localFolder}`);
  }
  if (!stat.isDirectory) {
    throw new Error(`not a directory: ${localFolder}`);
  }
}

/** Extra knobs for the image build performed by `devcontainer up`. */
export interface StartOptions {
  /** Pass `--build-no-cache`, so the image is rebuilt from scratch. */
  noCache?: boolean;
}

export async function startContainer(
  localFolder: string,
  rebuild = false,
  opts: StartOptions = {},
): Promise<ContainerInfo> {
  // Guard before any git/docker/devcontainer work so a bad path fails fast
  // instead of spinning up a container for it.
  assertLocalFolderExists(localFolder);

  // The ~/.claude seed mount's source must exist before `devcontainer up` runs: a bind mount
  // with a missing source is a hard error, not an auto-created directory.
  const seed = await ensureClaudeSeedDir();
  if (seed.migrated.length > 0) {
    console.log(
      `devc: moved ${seed.migrated.join(", ")} into ${
        displayPath(CLAUDE_SEED_HOST_DIR)
      }`,
    );
  }

  const worktree = await isGitWorktree(localFolder);
  const args = ["up", "--workspace-folder", localFolder];
  if (worktree) args.push("--mount-git-worktree-common-dir");
  if (rebuild) args.push("--remove-existing-container");
  if (opts.noCache) args.push("--build-no-cache");

  // The config `devcontainer up` will actually use. A project's own config is found by the
  // CLI on its own; only the out-of-tree bundled default needs `--config` to be found at all.
  const ownConfig = await findOwnDevcontainerConfig(localFolder);
  const configPath = ownConfig ?? await materializeDefaultConfig();
  if (ownConfig === null) args.push("--config", configPath);

  const cmd = new Deno.Command("devcontainer", {
    args,
    stdout: "piped",
    stderr: "inherit",
  });

  const { code, stdout } = await cmd.output();
  const text = new TextDecoder().decode(stdout);

  // devcontainer up emits one JSON object per line; the final line is the outcome
  const lines = text.trim().split("\n").filter(Boolean);
  if (lines.length === 0) {
    dumpBuildOutput(text);
    throw new Error(
      `devcontainer up failed with exit code ${code} (no output)`,
    );
  }

  // deno-lint-ignore no-explicit-any
  let result: any;
  try {
    result = JSON.parse(lines[lines.length - 1]);
  } catch {
    // The final line wasn't the expected outcome JSON — surface everything so
    // the real error (build/postCreate failure, etc.) isn't lost.
    dumpBuildOutput(text);
    throw new Error(
      `devcontainer up failed with exit code ${code} (unparseable output)`,
    );
  }

  if (result.outcome !== "success") {
    dumpBuildOutput(text);
    throw new Error(
      `devcontainer up failed: ${result.message ?? JSON.stringify(result)}`,
    );
  }

  const name = await containerNameForLocalFolder(localFolder);
  await renameContainerIfNeeded(result.containerId, name, localFolder);
  await tagImageIfNeeded(result.containerId, name);

  // Re-derive `remoteEnv` from the in-play config, for *both* modes — `docker exec` (how
  // exec/attach run) never sees it otherwise. Done after the `up` so `${containerWorkspaceFolder}`
  // resolves against the CLI's own `remoteWorkspaceFolder` rather than a local reimplementation
  // of how it computes that path.
  const remoteEnv = await loadResolvedRemoteEnv(
    configPath,
    result.remoteWorkspaceFolder,
    localFolder,
  );

  return {
    containerId: result.containerId,
    remoteUser: result.remoteUser,
    remoteWorkspaceFolder: result.remoteWorkspaceFolder,
    remoteEnv,
  };
}

/**
 * Recreate the container for `localFolder` from scratch: `devcontainer up` with
 * `--remove-existing-container` (plus `--build-no-cache` when asked). This — not an
 * image-only build — is what makes a `devcontainer.json` change take effect, because
 * mounts are bound at container-create time.
 *
 * Backs both `devc build` and the `devc config` post-apply rebuild prompt.
 */
export function rebuildContainer(
  localFolder: string,
  opts: StartOptions = {},
): Promise<ContainerInfo> {
  return startContainer(localFolder, true, opts);
}

export async function stopContainer(localFolder: string): Promise<void> {
  const found = await findContainer(localFolder, false);
  if (found === null) return;

  await new Deno.Command("docker", {
    args: ["stop", found.id],
    stdout: "inherit",
    stderr: "inherit",
  }).output();
}

/**
 * Stops (if running) and removes the container for `localFolder`. No-op if no
 * container (running or stopped) matches. After this, the next `devc attach` for
 * `localFolder` creates a brand-new container.
 */
export async function downContainer(localFolder: string): Promise<void> {
  const found = await findContainer(localFolder, true);
  if (found === null) return;

  if (found.state === "running") {
    await new Deno.Command("docker", {
      args: ["stop", found.id],
      stdout: "inherit",
      stderr: "inherit",
    }).output();
  }

  await new Deno.Command("docker", {
    args: ["rm", found.id],
    stdout: "inherit",
    stderr: "inherit",
  }).output();
}

export interface AttachOptions {
  sessionName?: string;
  /**
   * Keep attach/build output on screen by skipping the first-prompt clear
   * (i.e. don't set `DEVC_ATTACH=1`). Useful for reading postCreate/build
   * warnings that the clear would otherwise erase.
   */
  noClear?: boolean;
  /**
   * When set, run this command inside a login shell instead of dropping into an
   * interactive shell — the shortcut behind `devc claude`. The attach ends when
   * the command exits. The screen is cleared after login init (matching the
   * first-prompt clear a plain attach does) unless `noClear`.
   */
  command?: string;
}

/**
 * Derives an attach session name from the container's workspace folder, e.g.
 * `/workspaces/some-tool` -> `some-tool`. `.` and `:` are replaced to keep
 * the name a safe single token (they also carry meaning in tmux's
 * `session:window.pane` target syntax when a host tmux window is renamed).
 */
export function sessionNameForWorkspaceFolder(
  remoteWorkspaceFolder: string,
): string {
  const name = basenamePosix(remoteWorkspaceFolder).replace(/[.:]/g, "_");
  return name || "main";
}

// Solarized Dark — visually marks an attached container shell apart from local
// terminals for the duration of the attach.
const ATTACH_BG = "#002b36";
const ATTACH_FG = "#839496";

/**
 * Reports whether the terminal devc is running in is a genuine tmux client.
 *
 * `$TMUX` alone is not reliable: it is exported, so a child that merely
 * inherited it — e.g. a VS Code terminal launched via `code .` from a tmux
 * shell — looks like tmux even though it is not a tmux client. A real tmux
 * pane's `#{pane_tty}` equals the process's own controlling tty; an inherited
 * pointer resolves to the original pane, whose tty differs from the child's pty.
 */
async function hostIsTmux(): Promise<boolean> {
  if (!Deno.env.get("TMUX")) return false;
  const decode = (o: Deno.CommandOutput) =>
    o.code === 0 ? new TextDecoder().decode(o.stdout).trim() : "";
  const [paneTty, ownTty] = await Promise.all([
    new Deno.Command("tmux", {
      args: ["display-message", "-p", "#{pane_tty}"],
      stdout: "piped",
      stderr: "null",
    }).output().then(decode).catch(() => ""),
    new Deno.Command("tty", {
      stdin: "inherit",
      stdout: "piped",
      stderr: "null",
    }).output().then(decode).catch(() => ""),
  ]);
  return paneTty !== "" && paneTty === ownTty;
}

/**
 * Tints the terminal for the lifetime of an attach so a container shell reads
 * as distinct from local terminals, and returns a function that undoes it.
 * Dispatches on environment because the effective lever differs:
 *
 * - Inside a local tmux, the terminal-level background is hidden by tmux's own
 *   per-cell rendering, so OSC 11 has no visible effect. We set the tmux
 *   `window-style`/`window-active-style` for the current window instead and
 *   unset them on detach (reverting to whatever global default was in place).
 * - Otherwise (VS Code integrated terminal, or a bare iTerm2 session) we set
 *   the terminal background/foreground directly via OSC 11/10 — honored by
 *   both xterm.js and iTerm2 — and reset via OSC 111/110 on detach.
 */
async function applyAttachColors(
  inTmux: boolean,
): Promise<() => Promise<void>> {
  if (inTmux) {
    const style = `bg=${ATTACH_BG},fg=${ATTACH_FG}`;
    const setStyle = (name: string, value?: string) =>
      new Deno.Command("tmux", {
        args: value === undefined
          ? ["set", "-uw", name]
          : ["set", "-w", name, value],
        stdout: "null",
        stderr: "null",
      }).output().catch(() => {});
    await setStyle("window-style", style);
    await setStyle("window-active-style", style);
    return async () => {
      await setStyle("window-style");
      await setStyle("window-active-style");
    };
  }
  const enc = new TextEncoder();
  await Deno.stdout.write(
    enc.encode(`\x1b]11;${ATTACH_BG}\x07\x1b]10;${ATTACH_FG}\x07`),
  );
  return async () => {
    await Deno.stdout.write(enc.encode(`\x1b]111\x07\x1b]110\x07`));
  };
}

export async function attachToContainer(
  info: ContainerInfo,
  options: AttachOptions = {},
): Promise<void> {
  const {
    sessionName = sessionNameForWorkspaceFolder(info.remoteWorkspaceFolder),
    noClear = false,
    command,
  } = options;

  // A genuine tmux client (not a child that merely inherited $TMUX, e.g. a VS
  // Code terminal) drives both how we tint and whether the window-rename below
  // targets a real pane instead of retargeting the pane that spawned it.
  const inTmux = await hostIsTmux();

  // Set terminal title to project name. If running inside a host tmux session,
  // rename that window — it's what the host terminal actually displays, not any
  // title set from inside the container.
  if (inTmux) {
    await new Deno.Command("tmux", {
      args: ["rename-window", sessionName],
      stdout: "null",
      stderr: "null",
    }).output().catch(() => {});
  }
  await Deno.stdout.write(
    new TextEncoder().encode(`\x1b]0;${sessionName}\x07`),
  );

  // The login shell to run inside the container. Without `command`, an
  // interactive login shell (plain `devc attach`). With `command`, a login
  // shell that runs the command and exits when it does (e.g. `devc claude`).
  // `clear` wipes login-init clutter before the command runs, mirroring the
  // first-prompt clear a plain attach does via DEVC_ATTACH.
  const loginShell = (clear: boolean): string[] => {
    if (!command) return ["/bin/bash", "-l"];
    const inner = clear
      ? `clear; printf '\\033[3J'; exec ${command}`
      : `exec ${command}`;
    return ["/bin/bash", "-lc", inner];
  };

  const shellArgs = loginShell(!noClear);

  // `docker exec -t` hardcodes TERM=xterm and drops the rest of the host's terminal
  // identity, so keys negotiated against the outer terminal (extended keys like
  // shift+enter) break inside the container. Propagate the identity vars the app
  // keys off, each only when the host has it set:
  //   TERM                 — e.g. tmux-256color, so behavior matches the host
  //   TERM_PROGRAM         — e.g. vscode, so Claude interprets VS Code's shift+enter
  //                          sequence (which `/terminal-setup` makes VS Code emit)
  //   TERM_PROGRAM_VERSION — companion to TERM_PROGRAM
  // Placed before remoteEnv so explicit remoteEnv overrides still win.
  const termIdentityFlags = ["TERM", "TERM_PROGRAM", "TERM_PROGRAM_VERSION"]
    .flatMap((k) => {
      const v = Deno.env.get(k);
      return v ? ["-e", `${k}=${v}`] : [];
    });
  const baseEnvFlags = [
    ...termIdentityFlags,
    ...Object.entries(info.remoteEnv).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
  ];

  // Claude only requests extended keys (shift+enter et al.) from the outer terminal
  // when it detects tmux via $TMUX, which `docker exec` drops — so a host-tmux user
  // loses shift+enter inside the container despite the correct TERM. Re-inject the
  // host $TMUX (only set when the host really is in tmux) so the container app sees it.
  const hostTmux = Deno.env.get("TMUX");
  const tmuxEnvFlags = hostTmux ? ["-e", `TMUX=${hostTmux}`] : [];

  // DEVC_ATTACH=1 arms the first-prompt clear in bashrc-additions.sh. Skip it
  // when the caller asked to keep output on screen (--no-clear), or when running
  // a command (no interactive prompt fires — the clear is baked into the command
  // via loginShell()).
  const attachFlag = noClear || command ? [] : ["-e", "DEVC_ATTACH=1"];
  const envFlags = [...baseEnvFlags, ...tmuxEnvFlags, ...attachFlag];

  // Tint the terminal for the duration of the attach; reset on detach (including
  // on a non-zero exit or a thrown error via finally).
  const resetColors = await applyAttachColors(inTmux);
  try {
    const { code } = await new Deno.Command("docker", {
      args: [
        "exec",
        "-it",
        ...envFlags,
        "-u",
        info.remoteUser,
        "-w",
        info.remoteWorkspaceFolder,
        info.containerId,
        ...shellArgs,
      ],
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    }).spawn().status;

    if (code !== 0) throw new Error(`docker exec exited with code ${code}`);
  } finally {
    await resetColors();
  }
}
