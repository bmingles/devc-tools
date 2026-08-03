import {
  attachToContainer,
  downContainer,
  execInContainer,
  getContainerMounts,
  getContainerStatus,
  resolveLocalFolder,
  sessionNameForWorkspaceFolder,
  startContainer,
  stopContainer,
} from "./container.ts";
import { parseAttachArgs } from "./args.ts";

const USAGE =
  "Usage: devc attach [path] [--build] [--no-clear] | devc claude [path] [...] | " +
  "devc up [path] [--json] | devc exec [path] [--cwd <dir>] [--env K=V]... -- <cmd...> | " +
  "devc mounts [path] [--json] | devc stop [path] | devc down [path] | devc status [path]";

const subcommand = Deno.args[0];

/** Prints a `devc:`-prefixed error to stderr and exits 1 (never returns). */
function fail(e: unknown): never {
  console.error(`devc: ${e instanceof Error ? e.message : e}`);
  Deno.exit(1);
}

/**
 * Shared `devc attach` / `devc claude` flow: start (or rebuild) the container
 * for `target`, then attach. When `command` is given (`devc claude`), it runs
 * inside a login shell instead of dropping into an interactive shell.
 */
async function attach(rawArgs: string[], command?: string): Promise<void> {
  const { target: rawTarget, rebuild, noClear } = parseAttachArgs(rawArgs);
  const target = resolveLocalFolder(rawTarget);
  const what = command ? `${target} and running \`${command}\`` : `${target}`;
  console.log(
    rebuild
      ? `Rebuilding and attaching to ${what}...`
      : `Attaching to ${what}...`,
  );
  const info = await startContainer(target, rebuild).catch(fail);

  // Derive session name from the git root of the local folder so it matches
  // $PROJECT_PATH basename in the container, even when devc is run on a subfolder.
  const gitRootResult = await new Deno.Command("git", {
    args: ["-C", target, "rev-parse", "--show-toplevel"],
    stdout: "piped",
    stderr: "null",
  }).output();
  const projectRoot = gitRootResult.code === 0
    ? new TextDecoder().decode(gitRootResult.stdout).trim()
    : target;
  const sessionName = sessionNameForWorkspaceFolder(projectRoot);

  await attachToContainer(info, {
    noClear,
    sessionName,
    command,
  });
  Deno.exit(0);
}

if (subcommand === "-h" || subcommand === "--help") {
  console.log(USAGE);
  Deno.exit(0);
}

if (subcommand === "attach") {
  await attach(Deno.args.slice(1));
}

if (subcommand === "claude") {
  await attach(Deno.args.slice(1), "claude");
}

if (subcommand === "stop") {
  const target = resolveLocalFolder(Deno.args[1]);
  await stopContainer(target);
  console.log(`Stopped container for ${target}`);
  Deno.exit(0);
}

if (subcommand === "down") {
  const target = resolveLocalFolder(Deno.args[1]);
  await downContainer(target);
  console.log(`Removed container for ${target}`);
  Deno.exit(0);
}

if (subcommand === "status") {
  const target = resolveLocalFolder(Deno.args[1]);
  console.log(await getContainerStatus(target));
  Deno.exit(0);
}

if (subcommand === "up") {
  const rest = Deno.args.slice(1);
  const json = rest.includes("--json");
  const target = resolveLocalFolder(rest.find((a) => !a.startsWith("--")));
  const info = await startContainer(target, false).catch(fail);
  if (json) {
    console.log(JSON.stringify(info));
  } else {
    console.log(
      `${info.containerId} running — workspace ${info.remoteWorkspaceFolder}`,
    );
  }
  Deno.exit(0);
}

if (subcommand === "exec") {
  const rest = Deno.args.slice(1);

  // Everything after the `--` separator is the command, verbatim (exec'd
  // directly — no shell). Flags/path are parsed only from before it.
  const sepIndex = rest.indexOf("--");
  const flagArgs = sepIndex === -1 ? rest : rest.slice(0, sepIndex);
  const cmd = sepIndex === -1 ? [] : rest.slice(sepIndex + 1);

  let target: string | undefined;
  let cwd: string | undefined;
  const env: Record<string, string> = {};
  for (let i = 0; i < flagArgs.length; i++) {
    const a = flagArgs[i];
    if (a === "--cwd") {
      cwd = flagArgs[++i];
    } else if (a === "--env") {
      const kv = flagArgs[++i] ?? "";
      const eq = kv.indexOf("=");
      if (eq === -1) {
        console.error(`devc: --env expects K=V, got "${kv}"`);
        Deno.exit(125);
      }
      env[kv.slice(0, eq)] = kv.slice(eq + 1);
    } else if (!a.startsWith("--") && target === undefined) {
      target = a;
    }
  }

  if (cmd.length === 0) {
    console.error("devc: exec requires a command after `--`");
    Deno.exit(125);
  }

  try {
    const code = await execInContainer(resolveLocalFolder(target), {
      cwd,
      env,
      cmd,
    });
    Deno.exit(code); // command's own exit code
  } catch (e) {
    console.error(`devc: ${e instanceof Error ? e.message : e}`);
    Deno.exit(125); // reserved: devc/docker infra failure
  }
}

if (subcommand === "mounts") {
  const rest = Deno.args.slice(1);
  const json = rest.includes("--json");
  const target = resolveLocalFolder(rest.find((a) => !a.startsWith("--")));
  const m = await getContainerMounts(target);
  if (json) {
    console.log(JSON.stringify(m ?? []));
  } else if (m === null) {
    console.log(`No container for ${target}`);
  } else {
    for (const mount of m) {
      console.log(
        `${mount.type}\t${mount.source} -> ${mount.destination}\t${
          mount.rw ? "rw" : "ro"
        }`,
      );
    }
  }
  Deno.exit(0);
}

console.error(`Unknown subcommand: ${subcommand ?? "(none)"}`);
console.error(USAGE);
Deno.exit(1);
