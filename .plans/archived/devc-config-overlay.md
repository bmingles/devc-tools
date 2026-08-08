# devc config overlay + user template layer

Reintroduce a `devc.json` overlay — improved over the reference implementation
in `/workspaces/thirdparty/agent-tools/devc` — and add a user-level template
layer that overrides the bundled default per file.

Two independent layers, deliberately kept separate:

- **Base config** — exactly one `devcontainer.json` is passed to
  `devcontainer up`. Replacement chain, no merging: a base config carries
  `build`/`image`, which cannot sensibly merge.
- **Overlay** — `devc.json`, translated to `devcontainer up` CLI args. Merges
  onto whichever base won, in _both_ project mode and the zero-config path.

### The governing invariant

**Whatever lands in `.devcontainer/` must run without `devc` installed at all.**
`devc.json` never compromises the standalone contract of the folder it sits next
to.

The overlay serves two equally valid shapes, and the design must not favor one:

- **Committed** — the repo has adopted `devc` as a tool it depends on, and
  `devc.json` is checked in alongside the config.
- **Local override, gitignored** — an individual dev adds bind mounts for their
  own machine, in a repo that need not know `devc` exists. Nothing is committed;
  teammates are unaffected.

The second shape is the reason the standalone invariant is airtight rather than
merely polite: a gitignored overlay is invisible to the repo, so the
`.devcontainer/` everyone else checks out is untouched by definition.

This is why the overlay is applied as **CLI args and never as a file rewrite**.
The mechanism is not merely the simpler option — it is what makes the invariant
structurally true rather than a convention someone has to remember. The
project's `devcontainer.json` is read but never written, so a checkout without
`devc` still builds and runs from the standard config; it just does not get the
overlay's extra mounts, features and env. Un-augmented, not broken.

Two consequences the implementation must respect:

- No code path in this feature may write to, reformat, or re-assert anything in
  a project's `.devcontainer/devcontainer.json`. `devc config` remains the only
  writer.
- **Both locations are first-class.** `.devcontainer/devc.json` is often the
  better fit for a gitignored local override — one file to ignore, sitting
  beside the config it overlays — while `.devc/` suits a repo that wants
  `devc`'s files grouped. Document both neutrally with the use case each serves;
  do not present either as canonical.
- **`devc init` is untouched.** Its empty-directory guard stays as-is, including
  for a pre-existing `devc.json` — see Non-goals.

## Background: what changes vs. the reference

The reference only consulted `devc.json` when the project had **no**
`devcontainer.json` (`container.ts:535`,
`if (!(await hasOwnDevcontainerConfig(localFolder)))`). A project with its own
config silently ignored the file. This plan runs the overlay unconditionally.

Carried over unchanged: the four-path project discovery order, and the three
overlay keys.

Fixed or improved here:

| Reference behavior                                                                                                                                            | Here                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `devc.json` ignored in project mode                                                                                                                           | Applies in both modes                                                                                 |
| Templates seeded once — a devc upgrade shipped none of its new defaults                                                                                       | Sparse per-file overlay, re-applied every run; upgrades always flow through                           |
| Cache copy never pruned — a file deleted from templates lingered forever                                                                                      | Already fixed in `materializeDefaultConfig` (`Deno.remove(cacheDir)` first); preserved                |
| `stripLineComments` regex, only whole-line `//`                                                                                                               | `parseJsonc` from `jsr:@std/jsonc` — real JSONC, trailing commas included                             |
| Only `${localEnv:VAR}` + `${containerWorkspaceFolder}` substituted; README warned others would reach Docker literally and fail                                | Shared `substituteVars` also resolves `${localWorkspaceFolder}` and `${localWorkspaceFolderBasename}` |
| `--remote-env` values passed **unsubstituted** while devc's own exec path substituted them — same var resolved in `devc exec`, literal in `devcontainer exec` | Substituted on both paths                                                                             |
| No user-level overlay — user customization could not reach a project-mode container at all                                                                    | `~/.config/devc/devc.jsonc\|json` applies to every project                                            |

## Design

### Base config resolution (replacement — first hit wins)

1. `<localFolder>/.devcontainer/devcontainer.json`
2. `<localFolder>/.devcontainer.json`
3. Materialized default → `~/.cache/devc/default/devcontainer.json`

Unchanged from today; `findOwnDevcontainerConfig` already covers 1 and 2,
including the root-level form. Only case 3 passes `--config`.

### Materialized default = bundled ⊕ user templates

`materializeDefaultConfig(cacheDir)` gains one step. Order matters:

1. `Deno.remove(cacheDir, { recursive: true })` — existing prune, keep it.
2. Copy embedded `devc/default/` → `cacheDir`.
3. **New:** if `~/.config/devc/templates/` exists, copy its tree over
   `cacheDir`, overwriting per file and recursing into subdirectories. A missing
   templates dir is a silent no-op.
4. Apply the two existing path rewrites (`initializeCommand`,
   `postCreateCommand`).

Step 4 **must** run after step 3, so a user-supplied
`templates/devcontainer.json` gets the same rewrites. The rewrites are
`replaceAll` of exact tokens, so a template that changed those lines simply
no-ops.

The templates dir is **never seeded**. It stays absent until the user creates
it, and holds only the files they want to change. Deleting a template file
restores the bundled version on the next run.

### Overlay discovery (first hit wins, per level)

Project level:

1. `<localFolder>/.devc/devc.jsonc`
2. `<localFolder>/.devc/devc.json`
3. `<localFolder>/.devcontainer/devc.jsonc`
4. `<localFolder>/.devcontainer/devc.json`

User level:

1. `~/.config/devc/devc.jsonc`
2. `~/.config/devc/devc.json`

Only the first hit at each level is read; the losers are **not** merged. Both
files are parsed as JSONC regardless of extension, so `.json` vs `.jsonc` is
naming convention only.

### Overlay schema

```jsonc
{
  "mounts": [
    "type=bind,source=${localEnv:HOME}/notes,target=${containerWorkspaceFolder}/../notes"
  ],
  "additionalFeatures": {
    "ghcr.io/devcontainers/features/rust:1": { "version": "latest" }
  },
  "remoteEnv": { "MY_VAR": "value" }
}
```

All three keys optional; the file itself optional. Any other top-level key is
ignored, with a one-line warning to stderr naming the key — a typo like
`"mount"` must not silently do nothing.

### Overlay merge (user ⊕ project, project wins)

- `mounts` — concatenate, user entries first.
- `remoteEnv` — `{...user, ...project}`, per key.
- `additionalFeatures` — `{...user, ...project}`, per feature id. Whole-value
  replace; options objects are not deep-merged.

### Emitted `devcontainer up` args

Appended after the existing args, in this order:

1. `--mount <spec>` — one per merged mount entry, in merged order.
2. `--additional-features <json>` — single arg, `JSON.stringify` of the merged
   object. Omitted entirely when the merged object is empty.
3. `--remote-env KEY=value` — one per merged `remoteEnv` entry.

How each lands on the base config: mounts **append** to the base's `mounts[]`;
`remoteEnv` **overrides** the base's per key; `additionalFeatures` is merged
into the base's `features` by the devcontainer CLI itself.

### Variable substitution

Apply `substituteVars(value, containerWorkspaceFolder, localFolder)` to **mount
specs** and **`remoteEnv` values**. Both reach Docker without passing through
the CLI's own substitution.

Do **not** substitute inside `additionalFeatures` — that JSON is merged into the
config by the CLI and goes through its substitution pipeline. Pre-resolving
would double-resolve.

### Gotcha: two sources of `containerWorkspaceFolder`

`--mount` and `--remote-env` args must be built **before** `devcontainer up`
runs, but `result.remoteWorkspaceFolder` only exists **after**. So:

- **Pre-`up`** (building CLI args): use
  `await computeContainerWorkspaceFolder(localFolder)` — the local replication
  in `container.ts:256`, verified against CLI 0.87.0.
- **Post-`up`** (re-deriving `remoteEnv` for exec/attach): keep using
  `result.remoteWorkspaceFolder`, as today.

Do not "simplify" these to one call. The post-`up` value is authoritative and
the existing code comment says so; the pre-`up` path has no access to it.

### `remoteEnv` for `exec`/`attach`

`docker exec` never sees `remoteEnv`, so devc re-derives it. That derivation
must now include the overlay. Effective precedence, lowest to highest:

1. base config `remoteEnv`
2. user `devc.json` `remoteEnv`
3. project `devc.json` `remoteEnv`

All values substituted with the post-`up` `result.remoteWorkspaceFolder`.

### Parse failures

- **Base config** unreadable/unparseable → current forgiving behavior stands:
  warn, yield `{}` `remoteEnv`, continue.
- **`devc.json`** unparseable → **throw**, naming the file path, failing the
  command. It exists only for devc and is small and hand-written; silently
  starting a container missing the user's mounts is worse than a hard error.

### Templates also apply to `init` / `config`

`devc init` and `devc config` materialize a project `.devcontainer/` from the
bundled assets. They must honor templates too, or a user's `Dockerfile`
customization would apply to zero-config projects and vanish the moment they ran
`devc config`.

- `loadBundledDevcontainerJson()` → returns
  `~/.config/devc/templates/devcontainer.json` when it exists, else the embedded
  one.
- `copyBundledAssets(destDir)` → copy embedded (excluding `devcontainer.json`),
  then overlay templates (excluding `devcontainer.json`).

`installBundledAssets` chmods `post-create.sh`, `initialize-command.sh`, and
`scripts/*.sh`. Both lifecycle hooks are invoked as `bash "<path>"` (see
`default/devcontainer.json:32-33`), so the exec bit is cosmetic and a new
top-level `*.sh` added by a template not being chmod'd is acceptable — leave the
chmod list as-is.

The wizard inserts its two mount fences into the base text's `mounts` array. A
template `devcontainer.json` with no `mounts` array must still work —
`jsonc_edit.ts` exports `ensureArray(src, key, indent)` for exactly this.

### Doc changes: resolving the design-doc contradiction

`.plans/design/devc-design.md` currently asserts a principle this feature
breaks. The contradiction is confined to two places — line 33 ("Managed mount
blocks") and line 248 ("Reconfiguring a project") are about the wizard's mount
fences and stay true unchanged.

**1. §"No hidden abstraction" (line 31).** Delete the clause
`There is no overlay file, no`.devc/`layer, and no launch-time merge step —` and
replace the sentence it opened with:

> `devc config` writes a plain `devcontainer.json` + `Dockerfile`, and from that
> point on the project is a normal dev container that any devcontainer-aware
> tool (VS Code, the CLI, CI) understands. **Whatever lands in `.devcontainer/`
> runs without `devc` installed at all.** That invariant is unconditional:
> `devc` never writes a `devc`-specific key into that folder, and the
> launch-time overlay never mutates it.
>
> The optional `devc.json` overlay sits outside that contract rather than
> weakening it, and serves two shapes. **Committed**, it declares that the repo
> has adopted `devc` as a tool it depends on, much as it might depend on a
> Makefile or a task runner. **Gitignored**, it is a purely local override — an
> individual dev adding bind mounts for their own machine, in a repo that need
> not know `devc` exists and whose `.devcontainer/` no one else sees changed.
>
> Either way a checkout without `devc` still builds and runs from the standard
> config, merely without the overlay's extra mounts, features and env. Nothing
> is broken, only un-augmented.

Keep the rest of the paragraph (the guiding-principle sentence and the
`Dockerfile` + `postCreateCommand` sentence) byte-for-byte.

**2. §"Configuration precedence" (lines 35-42).** Replace the section body with:

> Two layers resolve independently.
>
> **Base config** — exactly one `devcontainer.json` is handed to
> `devcontainer up`. First hit wins; these do not merge, because a base config
> carries `build`/`image`.
>
> 1. `PATH/.devcontainer/devcontainer.json`
> 2. `PATH/.devcontainer.json`
> 3. The materialized default — the bundled `devcontainer.json` + `Dockerfile`,
>    with any same-named file from `~/.config/devc/templates/` overriding it per
>    file.
>
> Once a user applies a project-specific config via `devc config`, subsequent
> commands automatically use it (case 1).
>
> **Overlay** — an optional `devc.json` contributing `mounts`,
> `additionalFeatures` and `remoteEnv` on top of whichever base won, in project
> mode as well as the zero-config path. Merged lowest to highest:
>
> 1. `~/.config/devc/devc.jsonc`, else `~/.config/devc/devc.json`
> 2. `PATH/.devc/devc.jsonc`, `.devc/devc.json`, `.devcontainer/devc.jsonc`,
>    `.devcontainer/devc.json` — first hit only, the rest are not consulted
>
> `mounts` append, `remoteEnv` overrides per key, `additionalFeatures` merges
> per feature id.
>
> Both project locations are first-class and behave identically.
> `.devcontainer/devc.json` often suits a gitignored local override — one file
> to ignore, beside the config it overlays — and `.devc/` suits a repo that
> prefers `devc`'s files grouped in one place.

Do these edits in the same change as the code. A design doc that still claims
"no overlay file" after the overlay ships is worse than one that never mentioned
it.

### Non-goals

- **Duplicate mount targets.** An overlay mount colliding with a base mount
  produces two specs; Docker fails with `Duplicate mount point`. Not detected or
  deduped — the error is clear enough and the fix is the user's. Do not add
  dedup logic.
- **Relaxing `devc init`'s empty-directory guard.** `initProject` refuses to
  scaffold unless `.devcontainer/` is missing or completely empty
  (`init.ts:72-80`), and that includes a lone pre-existing `devc.json`.
  Deliberate: `init` is a clean-slate operation, and requiring an empty
  directory is what guarantees its output is exactly the bundle with nothing
  carried over. A user with a local overlay moves it aside, runs `init`, and
  moves it back — the existing error message already advises exactly that ("Move
  its contents aside and re-run"). Do **not** add an overlay exemption; this was
  considered and rejected.
- **Keys beyond the three.** `containerEnv`, `forwardPorts`, `runArgs`,
  `customizations` etc. have no `devcontainer up` flag. Out of scope; a project
  needing them runs `devc config`.
- **Merging user template `devcontainer.json` into a project's.** The template
  only participates in the zero-config base; it never merges into a project's
  own config.

### Framework gotchas

- `deno.json`'s `check` task lists every module by name. A new module must be
  added there or `deno task check` silently skips it.
- `Deno.readDir` + `Deno.writeFile` (the existing `copyDir`) does not preserve
  the exec bit; `Deno.copyFile` does. The cache path has never needed exec bits
  — do not add chmod there.
- `parseJsonc` returns `null` for an empty file, not `{}`. Guard before property
  access.

## Checklist

- [x] Add `TEMPLATES_DIR` (`${CONFIG_DIR}/templates`) alongside the existing
      `CONFIG_DIR` export
- [x] `materializeDefaultConfig` overlays `TEMPLATES_DIR` onto the cache dir
      after the bundled copy and before the two path rewrites; missing dir is a
      no-op
- [x] `loadBundledDevcontainerJson` prefers `${TEMPLATES_DIR}/devcontainer.json`
      when present
- [x] `copyBundledAssets` overlays template files (excluding
      `devcontainer.json`) after the embedded copy
- [x] Overlay discovery: project four-path order, then user two-path order,
      first hit wins per level, parsed with `parseJsonc`
- [x] Overlay merge: `mounts` concat (user first), `remoteEnv` and
      `additionalFeatures` per-key with project winning
- [x] Unknown top-level overlay keys warn to stderr naming the key, without
      failing
- [x] Unparseable `devc.json` throws, naming the file path
- [x] Emit `--mount` / `--additional-features` / `--remote-env` args in the
      specified order; `--additional-features` omitted when empty
- [x] `substituteVars` applied to mount specs and `remoteEnv` values, not to
      `additionalFeatures`
- [x] Pre-`up` args use `computeContainerWorkspaceFolder`; post-`up` `remoteEnv`
      re-derivation keeps `result.remoteWorkspaceFolder`
- [x] `startContainer` runs the overlay in **both** modes — no
      `if (ownConfig === null)` guard
- [x] `exec`/`attach` `remoteEnv` = base ⊕ user overlay ⊕ project overlay,
      project winning
- [x] Add any new module to the `check` task in `devc/deno.json`
- [x] Tests in `devc/tests/` covering the behaviors in `## Validation`
- [x] `devc/README.md`: document the overlay file, its three keys, discovery
      order, and the templates dir — both project locations presented neutrally
      with the use case each serves (including the gitignored local-override
      pattern), and the invariant that `.devcontainer/` runs without `devc`
      installed
- [x] `.plans/design/devc-design.md` §"No hidden abstraction": apply edit 1 from
      §"Doc changes" verbatim — the doc currently asserts "no overlay file, no
      `.devc/` layer, and no launch-time merge step", which this reverses
- [x] `.plans/design/devc-design.md` §"Configuration precedence": apply edit 2
      from §"Doc changes" verbatim
- [x] Leave `devc-design.md` lines 33 and 248 (managed mount fences) unchanged —
      they are about the wizard, not the overlay, and remain true

## Validation

Run from `/workspaces/devc-tools/devc`.

- [x] `deno task check` passes
- [x] `deno task test` passes
- [ ] `deno fmt --check` passes — **pre-existing failure**, unchanged by this
      plan: 17 files it does not touch were already unformatted on `main`
      (`help.ts`, `main.ts`, `jsonc_edit.ts`, `tui/*`, several `tests/*`). Every
      file this change touches is fmt-clean.
- [ ] `deno lint` passes — **pre-existing failure**, unchanged by this plan:
      every module and test imports `jsr:@std/...` inline, which trips
      `no-import-prefix` / `no-unversioned-import` repo-wide. `overlay.ts` uses
      the same specifier as `default_config.ts` deliberately. Fixing it means an
      import-map refactor across ~20 files — out of scope here.

Behavior, each an automated test:

- [x] No `devc.json` anywhere → emitted args are byte-identical to today's
- [x] Project with `.devcontainer/devcontainer.json` **and** `.devc/devc.json` →
      overlay args are emitted (the reference's bug: this produced none)
- [x] `.devc/devc.jsonc` beats `.devc/devc.json` beats
      `.devcontainer/devc.jsonc` beats `.devcontainer/devc.json`; a unique key
      in a losing file does **not** appear
- [x] `~/.config/devc/devc.jsonc` beats `~/.config/devc/devc.json`
- [x] User + project overlays: `mounts` concatenated user-first; conflicting
      `remoteEnv` key resolves to the project's; a user-only key survives
- [x] Conflicting `additionalFeatures` feature id resolves to the project's
      whole value, options not deep-merged
- [x] Mount spec containing `${localEnv:HOME}`, `${containerWorkspaceFolder}`,
      `${localWorkspaceFolder}` and `${localWorkspaceFolderBasename}` is fully
      substituted in the emitted `--mount`
- [x] A `${containerWorkspaceFolder}` in overlay `remoteEnv` is substituted in
      the emitted `--remote-env` (the reference left this literal)
- [x] `additionalFeatures` values are **not** substituted
- [x] Empty merged `additionalFeatures` emits no `--additional-features` arg
- [x] Unparseable `devc.json` throws with the path in the message
- [x] Empty `devc.json` file (`parseJsonc` → `null`) is treated as no overlay,
      no throw
- [x] Unknown top-level key warns and is otherwise ignored
- [x] Effective `exec` `remoteEnv` orders base < user overlay < project overlay
- [x] **Invariant:** a project `.devcontainer/devcontainer.json` is
      byte-identical before and after a `startContainer` run with a `devc.json`
      present — the overlay reads it, never writes it
- [x] `materializeDefaultConfig` with no templates dir → cache is byte-identical
      to the bundled tree plus the two rewrites
- [x] Templates dir containing only `Dockerfile` → that file overridden, every
      other bundled file present and unchanged
- [x] Templates `devcontainer.json` still receives the `initializeCommand` /
      `postCreateCommand` rewrites
- [x] Removing a file from the templates dir restores the bundled version on the
      next call
- [x] A file present in a previous cache but in neither bundled nor templates is
      gone after the next call (prune)
- [x] `devc init` into a temp dir with a templates `Dockerfile` writes the
      template's version
- [x] `devc init` refuses a `.devcontainer/` containing only `devc.json`, naming
      it in the not-empty message — pins the deliberate decision so a later
      change does not "helpfully" exempt the overlay
- [x] Wizard apply against a template `devcontainer.json` with no `mounts` array
      creates the array and writes both fences

Docs — run from the repo root, each must print nothing:

- [x] `grep -n "no overlay file\|no launch-time merge step" .plans/design/devc-design.md`
      (stale assertion removed)
- [x] `grep -n "^1\. \`PATH/\.devcontainer/devcontainer\.json\`$"
      .plans/design/devc-design.md || echo MISSING` prints nothing (precedence
      section rewritten, not just deleted)

And each must print at least one line:

- [x] `grep -n "devc\.json" .plans/design/devc-design.md` (overlay documented in
      the design doc)
- [x] `grep -n "templates" .plans/design/devc-design.md` (template layer
      documented)
- [x] `grep -n "devc\.json" devc/README.md` (overlay documented for users)

Manual:

- [ ] `devc up` on a zero-config project with a `.devc/devc.json` mount →
      `devc mounts` lists it
- [ ] `devc up` on a project that has its own `.devcontainer/devcontainer.json`
      plus a `.devc/devc.json` mount → `devc mounts` lists it, and the project's
      own mounts survive
- [ ] Overlay mount whose target collides with a base mount → `devcontainer up`
      fails with Docker's `Duplicate mount point`, unmodified by devc

## Relevant Files

Source:

- `devc/default_config.ts` — `CONFIG_DIR`; new `TEMPLATES_DIR`;
  `materializeDefaultConfig`, `loadBundledDevcontainerJson`,
  `copyBundledAssets`, `copyDir`, `substituteVars`, `loadResolvedRemoteEnv`,
  `findOwnDevcontainerConfig`
- `devc/container.ts` — `startContainer` (arg assembly, both modes),
  `computeContainerWorkspaceFolder`, post-`up` `remoteEnv` derivation
- `devc/deno.json` — add any new module to the `check` task
- `devc/jsonc_edit.ts` — `ensureArray`, used when a template `devcontainer.json`
  has no `mounts`
- `devc/init.ts` — consumes `loadBundledDevcontainerJson` +
  `installBundledAssets`
- `devc/wizard_apply.ts` — same two consumers
- `devc/tui/config_flow.ts` — consumes `loadBundledDevcontainerJson`

Tests:

- `devc/tests/default_config_test.ts` — materialize, templates, overlay
  discovery and merge
- `devc/tests/init_test.ts` — `devc init` under a templates dir
- `devc/tests/wizard_apply_test.ts` — template base text with no `mounts` array
- `devc/tests/helpers.ts` — `withTemp`, `fixture`
- `devc/tests/fixtures/` — new JSONC overlay fixtures

Docs:

- `devc/README.md` — §"How it works" bullets on config resolution and
  `remoteEnv`; new overlay and templates sections
- `.plans/design/devc-design.md` — §"No hidden abstraction", §"Configuration
  precedence"
- `.plans/PLAN.md` — status entry and phase row
