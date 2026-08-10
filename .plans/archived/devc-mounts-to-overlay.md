# Move the wizard's mount fences into the `devc.json` overlay

`devc config` currently writes its two managed mount fences (`devc:source`,
`devc:skills`) into the project's `.devcontainer/devcontainer.json`. That is the
wrong file for what those mounts actually are.

Extra bind mounts are **machine-specific, not project-specific**. Even when a
teammate genuinely needs the same sibling repo mounted, they will not have it
checked out at the same host path — so the mount cannot be committed and be
correct for anyone but its author. Today the wizard's output lands in a tracked
file anyway, which means every `devc config` run dirties `devcontainer.json`
with paths that are meaningless on any other machine.

The `devc.json` overlay already exists for exactly this: an optional, devc-only
file that is translated into `devcontainer up` CLI flags and never written into
the project's config, explicitly designed to serve a "gitignored local override"
shape. Moving both fences there puts machine-specific mounts in the
machine-specific file and takes `devc config` out of the business of editing a
tracked `devcontainer.json` at all.

## Research findings: read-only mounts through the overlay

**Read-only is not expressible through `devcontainer up --mount`, and no sound
workaround exists.** Investigated against the installed CLI
(`~/.devcontainers/cli/0.87.0`), confirmed against upstream `main`, with the
candidate workarounds prototyped against real Docker (29.6.2, Docker Desktop).
Recorded here so it is not re-litigated.

The CLI validates every `--mount` against a strict regex and then _rebuilds_ the
spec, discarding anything it did not capture:

```js
// devContainersSpecCLI.ts — arg validation
/^type=(bind|volume),source=([^,]+),target=([^,]+)(?:,external=(true|false))?$/;
// …and the serializer that reaches `docker run`:
function iG(A) { // object form (what --mount becomes)
  if (typeof A == 'string') return ['--mount', A]; // string form: passed through VERBATIM
  return ['--mount', `type=${A.type},src=${A.source},dst=${A.target}`];
}
```

Consequences:

- `,readonly` and `,consistency=cached` both **fail arg validation outright**
  (`Unmatched argument format: mount must match …`). Field order is fixed.
- Only _string_ mounts inside a `devcontainer.json` `mounts` array reach
  `docker run` untouched. That is why the infra `claude-seed` mount can be
  `readonly` and an overlay mount cannot.
- `devcontainer up` has **no** `--cap-add` / `--security-opt` / docker-run
  passthrough, so container-level settings can only come from the config file.

Prototype results for restoring read-only some other way:

| Mechanism                                                                                                  | Read-only?           | Live host edits?                                                                                                                   | Verdict                                                                            |
| ---------------------------------------------------------------------------------------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `--mount type=volume` backed by `docker volume create --opt type=none --opt o=bind,ro --opt device=<path>` | yes — writes refused | **no — silently stale**; a _fresh_ container still served pre-edit file content, while the same volume without `ro` was fully live | Disqualified: silent staleness is worse than a writable mount                      |
| rw staging mount + copy into `~/.claude/skills` in `post-create.sh`                                        | partial              | no — needs a rebuild to resync                                                                                                     | Disqualified: the staging mount is itself writable, so the host is still reachable |
| in-container `mount -o remount,bind,ro <target>`                                                           | yes                  | yes                                                                                                                                | Requires `capAdd: ["SYS_ADMIN"]` on the container                                  |
| post-`up` `docker exec --privileged … mount -o remount,bind,ro`                                            | yes                  | yes                                                                                                                                | **Still** requires `SYS_ADMIN` or `seccomp=unconfined` at create time              |

The last row is the decisive negative result. `docker exec --privileged` grants
capabilities to the exec'd process but cannot unlock `mount`, because Docker's
default **seccomp** profile compiles its `mount` allowance in at _container
create_ time from the container's configured capabilities. The remount failed
with `mount: permission denied` on an otherwise-identical container and
succeeded the instant `--security-opt seccomp=unconfined` was added.

So read-only skills mounts would cost `SYS_ADMIN` — a container-escape-class
capability — which runs directly against
`.plans/design/devcontainer-agent-sandbox-hardening.md`. **Decision: drop
read-only rather than work around it.** One property worth recording, because it
is what makes the _remaining_ `readonly` infra mounts meaningful: a real `ro`
bind mount holds against container-**root** (`docker exec -u 0` could not
remount it `rw` without `SYS_ADMIN`), whereas permission-based hiding does not,
since `vscode` has passwordless sudo.

## Design

### Where the overlay is written ("smart detection")

One new resolver. An **existing** project overlay always wins — devc never
creates a second file next to one that is already there:

1. `<project>/.devc/devc.jsonc`
2. `<project>/.devc/devc.json`
3. `<project>/.devcontainer/devc.jsonc`
4. `<project>/.devcontainer/devc.json`
5. None of the above exist → create
   **`<project>/.devcontainer/devc.jsonc`** when `<project>/.devcontainer/` is
   an existing directory, otherwise **`<project>/.devc/devc.jsonc`**.

Steps 1–4 are exactly `findProjectOverlayPath()`'s existing order
(`devc/overlay.ts:79`) — reuse it, do not duplicate the list. Step 5's fallback
to `.devc/` is what lets `devc config` work on a zero-config project that has no
`.devcontainer/`.

Writing into an existing overlay must preserve everything devc does not own:
`writeBlocks` only rewrites the two fences, so hand-written `mounts` entries,
`additionalFeatures`, `remoteEnv`, and comments come out byte-for-byte
identical. (This repo's own `.devc/devc.json` is exactly that case — it already
holds two hand-written mounts and would become the target.)

The user-level overlay (`~/.config/devc/devc.jsonc`) is never a target: the
wizard is per-project.

### `devc config` no longer scaffolds `.devcontainer/`

Deliberate behavior change. `applySelection` currently creates `.devcontainer/`
and calls `installBundledAssets` (Dockerfile, `post-create.sh`, `scripts/`) on
first run. Once mounts live in the overlay, a user adding one mount to a
zero-config project would get a whole `.devcontainer/` they must now maintain —
strictly worse than the zero-config path they had. Scaffolding is `devc init`'s
job and stays there unchanged.

### No migration

There is no migration path, by decision: the tool has one user, who will delete
the old fences by hand. `devc config` seeds from the overlay's fences, else from
`recentSkills` — it never reads the project config's fences, and never writes to
`devcontainer.json` at all. That deletes the whole migration surface (fence
removal, a `devcontainer.json` writer, the double-mount warning) rather than
building it.

The consequence to be aware of when adopting this: a project that still has
populated fences in `devcontainer.json` will mount those folders _and_ whatever
the overlay adds. Where the targets match, `devcontainer up` fails with Docker's
`Duplicate mount point`; where they differ, the folder is simply mounted twice.
Either way the fix is to delete the fence blocks from `devcontainer.json` by
hand — see the one-time cleanup in Validation.

### Mount spec format

`serializeMount()` becomes the CLI-compatible form, in the CLI's required field
order, with nothing else appended:

```
type=bind,source=<source>,target=<target>
```

`MountRow.readonly` and `defaultReadonly()` are removed rather than left as
fields that silently do nothing. `parseEntry` keeps ignoring `readonly` /
`consistency` / unknown fields, so a spec written by an older devc (or by hand)
still parses and is normalized on the next write.

### Loud validation of overlay mount specs

The overlay's `mounts` array is hand-editable, so devc validates every entry at
load time against the same regex the CLI uses, and fails naming the file — in
keeping with `overlay.ts`'s existing "errors are loud" stance. This turns the
CLI's context-free `Unmatched argument format: mount must match …` into
something actionable, and it is what tells you why a `,readonly` was rejected.

Validation runs on the **raw** spec (pre-substitution): the substitutable tokens
(`${localEnv:VAR}`, `${containerWorkspaceFolder}`, …) never contain commas, so
raw validation catches every real case.

### New-file seed text

`ensureArray` requires a root `{`, so a created overlay is seeded with a real
object that already has the array, and `spliceBlock` opens up the `[]`:

```jsonc
{
  // Machine-specific devc overlay, managed by `devc config`.
  // Also supports "additionalFeatures" and "remoteEnv" — see devc's README.
  "mounts": []
}
```

### What the user sees

The review gains a line stating that overlay mounts are read-write, so the
limitation is visible at the point of decision rather than only in the README.
The apply message names the overlay file:

```
Configuring devc mounts at /p/.devcontainer/devc.jsonc
  (creating a new overlay)

Review:
  devc:source
    ${localEnv:HOME}/code/foo — this project (always mounted)
    type=bind,source=${localEnv:HOME}/code/bar,target=/workspaces/bar
  devc:skills
    type=bind,source=${localEnv:HOME}/skills/x,target=/home/vscode/.claude/skills/x
  Note: overlay mounts are read-write — `devcontainer up --mount` cannot express
  read-only. See devc's README.
Apply? [Y/n]

Created /p/.devcontainer/devc.jsonc
```

The existing changed/unchanged rebuild logic (`maybeRebuild`) is untouched, and
`changed` keeps its current meaning: byte-identical output writes nothing and
reports no rebuild needed.

## Checklist

- [x] `devc/mounts.ts` — `serializeMount` emits
      `type=bind,source=<s>,target=<t>` only; drop `MountRow.readonly` and
      `defaultReadonly`; `parseEntry` keeps ignoring `readonly`/`consistency`
- [x] `devc/overlay.ts` — export the CLI mount regex and validate each entry in
      `readMounts`, erroring with the file path, entry index, the spec, and the
      reason (call out `readonly`/`consistency` explicitly when present)
- [x] `devc/overlay.ts` — add `resolveProjectOverlayTarget(localFolder)`
      returning the path to write plus whether it must be created, built on
      `findProjectOverlayPath` and the `.devcontainer/`-exists fallback rule
- [x] `devc/wizard_apply.ts` — `applySelection` writes the two fences into the
      resolved overlay file (creating it from the seed text when absent) and
      does nothing else: no `.devcontainer/` creation, no `installBundledAssets`,
      no write to `devcontainer.json`; `ApplyResult` reports the overlay path;
      drop the now-unused `templatesDir` dep
- [x] `devc/tui/config_flow.ts` — seed rows from the overlay's fences, else from
      `recentSkills`; header and apply messages name the overlay; review gains
      the read-write note
- [x] `devc/README.md` — overlay section documents that `--mount` supports only
      `type`/`source`/`target`/`external` (no `readonly`, no `consistency`) and
      why; `devc config` section describes the new target file, the detection
      order, and that it no longer scaffolds
- [x] `.plans/design/devc-design.md` — update the fence-location and
      `devc config` write-behavior sections (lines ~85, ~448–510)
- [x] `devc/tests/mounts_row_test.ts` — serializer form, no readonly
- [x] `devc/tests/overlay_test.ts` — spec validation accept/reject cases and
      overlay-target resolution (all four existing files, plus both fallbacks)
- [x] `devc/tests/wizard_apply_test.ts` — overlay creation, in-place update
      preserving unowned keys/comments, byte-identical no-op, and that
      `.devcontainer/` is neither created nor modified
- [x] `devc/tests/config_flow_test.ts` — seeding precedence and the new messages

## Validation

- [x] `cd devc && deno task check` is clean
- [x] `cd devc && deno fmt --check && deno lint` is clean (the ~30 pre-existing
      `no-import-prefix` findings elsewhere in the repo are unchanged)
- [x] `cd devc && deno task test` passes
- [x] A test asserts `serializeMount` output matches the CLI's own regex
      `/^type=(bind|volume),source=([^,]+),target=([^,]+)(?:,external=(true|false))?$/`
- [x] Fresh project, no `.devcontainer/`: `devc config` creates
      `.devc/devc.jsonc` with both fences and creates **no** `.devcontainer/`
- [x] Project with `.devcontainer/` but no overlay: `devc config` creates
      `.devcontainer/devc.jsonc`, and `devcontainer.json` is unmodified
      (`git diff` empty)
- [x] Project with an existing `.devc/devc.json`: `devc config` writes to that
      file, does not create a `.jsonc` sibling, and leaves its
      `additionalFeatures`/`remoteEnv`/hand-written mounts/comments
      byte-identical
- [x] Round-trip: running `devc config` twice with the same picks reports
      `Unchanged` and does not rewrite the file
- [x] An overlay mount written by hand as
      `type=bind,source=/a,target=/b,readonly` fails the command with an error
      naming the file and the `readonly` field — not a `devcontainer up` error
- [ ] **One-time cleanup in this repo — left for a human.** Delete the
      `devc:source` and `devc:skills` fence blocks from
      `.devcontainer/devcontainer.json`, then re-pick via `devc config`. Note
      `.devc/devc.json` already mounts `~/code/thirdparty/agent-tools` at
      `/workspaces/agent-tools` while the old fence mounts it at
      `/workspaces/thirdparty/agent-tools` — pick one. Until then this repo's
      container mounts that folder twice (different targets, so it starts fine)
- [x] Live Docker: verified on a scratch project instead of this repo (whose
      cleanup is left to a human) — `devcontainer up` accepted the emitted spec,
      re-serialized it to `type=bind,src=…,dst=…`, `devc mounts` listed it `rw`,
      and the file was readable in the container

## Relevant Files

- `devc/mounts.ts` — `serializeMount`, `MountRow`, `defaultReadonly`,
  `parseEntry`
- `devc/overlay.ts` — `findProjectOverlayPath`, `readMounts`, new
  `resolveProjectOverlayTarget`, new spec validation
- `devc/wizard_apply.ts` — `applySelection`, `applyFences`, `ApplyResult`,
  `ApplyDeps`
- `devc/tui/config_flow.ts` — `seedRows`, `reviewLines`, `runProjectFlow`,
  `ProjectFlowOptions`, `runProjectConfigWizard`
- `devc/default_config.ts` — `installBundledAssets` /
  `loadBundledDevcontainerJson` lose their `wizard_apply` caller (still used by
  `init.ts`); doc comment at line 29 mentions the skills fence
- `devc/init.ts` — unchanged behavior; its doc comment references the fences
- `devc/README.md` — overlay section, `devc config` section, mount docs
- `.plans/design/devc-design.md` — fence location and write behavior
- `devc/tests/mounts_row_test.ts`, `devc/tests/overlay_test.ts`,
  `devc/tests/wizard_apply_test.ts`, `devc/tests/config_flow_test.ts`

## Non-goals

- Read-only overlay mounts. Ruled out above; revisit only if the devcontainer
  CLI relaxes its `--mount` regex or gains a docker-run passthrough.
- Migrating existing fences out of `devcontainer.json`. Done by hand, once.
- `jsonc_edit.ts` changes. `writeBlocks`/`ensureArray` already do everything
  needed; no fence-removal primitive is required.
- Gitignoring the overlay. `devc` writes the file and says nothing; committed
  and gitignored both stay valid, as the overlay already documents.
- Detecting overlay-vs-base target collisions. Still undetected, still surfaces
  as Docker's `Duplicate mount point`, which names the target.
- Any change to `devc init`, `devc up`/`build`, the folder pickers, worktree
  resolution, or the user-level `~/.config/devc/devc.jsonc` overlay.
