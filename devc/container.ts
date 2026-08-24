// Thin re-export over `@devc-tools/core`'s container lifecycle, pre-bound to the CLI's own
// `DevcontainerRunner` (the `__devcontainer` self-exec — see `devcontainer_selfexec.ts`) so
// `main.ts` and `tui/config_flow.ts` keep importing the same names from the same place and
// neither learns that a runner exists. `attachToContainer` and `sessionNameForWorkspaceFolder`
// are re-exported from `attach.ts` for the same reason — nothing outside this module and
// `attach.ts` itself needs to know that lifecycle and attach now live apart.

import {
  type ContainerInfo,
  execInContainer as _execInContainer,
  type ExecOptions,
  type ExecResult,
  startContainer as _startContainer,
  type StartOptions,
} from '@devc-tools/core/container.ts';
import { selfExecDevcontainerRunner } from './devcontainer_selfexec.ts';

export {
  assertLocalFolderExists,
  buildExecArgs,
  buildUpArgs,
  computeContainerWorkspaceFolder,
  type ContainerInfo,
  type ContainerMount,
  containerNameForLocalFolder,
  type ContainerStatus,
  downContainer,
  type ExecOptions,
  type ExecResult,
  getContainerMounts,
  getContainerStatus,
  parseMounts,
  resolveLocalFolder,
  type StartOptions,
  stopContainer,
} from '@devc-tools/core/container.ts';

export { attachToContainer, sessionNameForWorkspaceFolder } from './attach.ts';
export type { AttachOptions } from './attach.ts';

/** {@link _startContainer}, pre-bound to the CLI's self-exec `DevcontainerRunner`. */
export function startContainer(
  localFolder: string,
  rebuild = false,
  opts: StartOptions = {},
): Promise<ContainerInfo> {
  return _startContainer(localFolder, rebuild, {
    devcontainer: selfExecDevcontainerRunner,
    ...opts,
  });
}

/** {@link _startContainer} with `rebuild: true`, pre-bound the same way. */
export function rebuildContainer(
  localFolder: string,
  opts: StartOptions = {},
): Promise<ContainerInfo> {
  return startContainer(localFolder, true, opts);
}

/**
 * {@link _execInContainer}, pre-bound to the CLI's self-exec `DevcontainerRunner` — `exec`
 * starts the container first (via `startContainer`) when it is not already running, so it needs
 * the same binding `startContainer` above does.
 */
export function execInContainer(
  localFolder: string,
  opts: ExecOptions,
): Promise<ExecResult> {
  return _execInContainer(localFolder, {
    devcontainer: selfExecDevcontainerRunner,
    ...opts,
  });
}
