# devc-tui — the `folders` fence must hold host paths

The `devc-tui:folders` block in the `.code-workspace` is written with **container** paths
(`model.ts:117`, `path: targetFor(cfg, id)` → `/workspaces/<id>`). The workspace file is
opened by VS Code on the host, so those entries resolve to nothing. The hand-written entries
sitting in the same array — `{ "path": "." }`, `{ "path": "../../spikes/devc-wksp" }` — are
host paths relative to the workspace file, which is the convention the fence should follow.

The `devc-tui:projects` and `devc-tui:skills` mount fences are **correct as they are**:
`source=` is a host path and `target=` is a container path, and neither changes here.

## Decisions

- **Folder paths are host paths, relative to the directory holding the workspace file**, with
  POSIX separators. `../projecta`, not `/workspaces/projecta` and not
  `/Users/me/src/projecta`.
- **Absolute is the fallback**, used only when no relative path exists (`relative()` returning
  an absolute path, as it does across Windows drives). On POSIX this never triggers.
- **The base directory is derived, not threaded.** It is a pure function of
  `cfg.workspaceFile` and `tree.workspaceDir`, both of which `derive` already has, so no
  caller signature changes:
  - `cfg.workspaceFile === null` ⇒ the workspace dir (auto-detect only ever finds a
    `*.code-workspace` sitting directly in it);
  - otherwise `dirname()` of the configured path, resolved against the workspace dir when it
    is relative — mirroring `resolveTargets`.
- **Read-back moves with the write.** `readSelection` recovers the selection from this same
  fence (`model.ts:190`), so it must resolve entries against the base directory and take the
  id from the path relative to `root`. Left alone, every entry would be dropped as
  "no matching project under root" and the selection would reset on every run.
- **The mounts fence read-back is untouched** — it still maps `target=` back through
  `idForTarget`, since mount targets really are container paths.

## Checklist

### config.ts

- [x] Export a helper giving the directory the workspace file lives in, from `cfg` and the
      workspace dir, per the rule above. No IO.

### model.ts

- [x] `derive` writes `Folder.path` as the host path of the node, relative to that directory,
      POSIX separators, absolute only as the fallback.
- [x] `readSelection`'s folders branch resolves each entry against that directory and derives
      the id as the path relative to `tree.root`; entries landing outside `root` keep the
      existing "dropping unknown entry" warning.
- [x] `readSelection`'s projects-fence fallback branch still uses `idForTarget` unchanged.
- [x] `idForTarget` stays exported and unchanged — mounts still need it.
- [x] Update the file header comment, which currently states "Target = containerRoot + id" as
      though it governed folders too.

### README.md

- [x] State that `devc-tui:folders` holds host paths relative to the workspace file, and that
      the mount fences hold `source=<host>,target=<container>`.
- [x] Update any example or wording implying folder entries are container paths.

## Validation

- [x] `cd devc-tui && deno task check` passes.
- [x] `cd devc-tui && deno task test` passes.
- [x] With root `<tmp>/root`, workspace dir `<tmp>/ws` and `projecta` selected, the workspace
      file's `folders` array is exactly
      `[{ "path": "." }, { "path": "../root/projecta", "name": "projecta" }]`.
- [x] With the workspace dir *inside* root (`<root>/here`) and `projecta` selected, the entry
      is `{ "path": "../projecta", "name": "projecta" }`.
- [x] The `name` of every folder entry is still the id (path relative to `root`), unchanged.
- [x] `devc-tui select projecta && devc-tui apply` is idempotent — the second run reports no
      changes, proving the new paths read back to the same ids they were written from.
- [x] `devc-tui select projecta` then `devc-tui deselect projecta` restores the workspace file
      to its original bytes.
- [x] A folders entry pointing outside `root` is dropped with the existing warning on stderr.
- [x] The `devc-tui:projects` and `devc-tui:skills` fences are byte-identical to what they
      were before this change (host `source=`, container `target=`).
- [x] The TUI session test still writes bytes identical to the equivalent `devc-tui select`.

## Relevant Files

| File | Change |
| --- | --- |
| `devc-tui/config.ts` | workspace-file-directory helper |
| `devc-tui/model.ts` | folder path write, folders read-back, header comment |
| `devc-tui/README.md` | which fence holds which kind of path |
| `devc-tui/tests/model_test.ts` | `folderLines` / `deriveFolders` path expectations |
| `devc-tui/tests/cli_test.ts` | `folders` array expectations, round-trip |
| `.plans/PLAN.md` | register, then close out |

`devc-tui/scan.ts`, `devc-tui/jsonc_edit.ts`, `devc-tui/tui/*` and the fence syntax are
untouched; `derive`'s and `readSelection`'s signatures do not change.
