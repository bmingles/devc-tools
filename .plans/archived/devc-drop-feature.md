# devc — drop the local Feature; deliver the baseline via Dockerfile + a top-level `scripts/`

## Goal

Remove the `devc` local devcontainer **Feature** entirely. The baseline (Claude CLI, shell
additions, the `~/.claude` seed/symlink runtime setup, nvm install) is delivered by the bundled
**Dockerfile** (build-time) plus a **top-level `postCreateCommand`** that runs
`scripts/post-create.sh` (create-time). Both the zero-config path and `devc config` projects use
the *identical* `.devcontainer/` shape — no more feature-strip transform, no Dockerfile reaching
into a feature directory.

Publishing the baseline as a standalone OCI feature is **explicitly not a goal**; remove every
assumption that it might be. Optimize for a developer reading the generated `.devcontainer/` and
understanding it with zero devc-specific knowledge.

### Why this is safe / correct

- The zero-config path (`materializeDefaultConfig`) **already** ships this exact model: it strips
  the local feature and runs the baseline via the Dockerfile + a top-level `postCreateCommand`. So
  "no feature" is a proven, shipping code path — this change makes project mode use it too and
  deletes the divergence.
- A local Feature's only real benefit was **additive** `postCreateCommand` (composing with a
  developer's own). That is preserved by a documented **user hook**: `post-create.sh` runs
  `${PROJECT_PATH}/.devcontainer/scripts/post-create.user.sh` if present. devc owns/regenerates
  `post-create.sh`; it never touches `post-create.user.sh`.
- `installsAfter: [node]` is not lost: a **top-level** `postCreateCommand` runs *after all features
  finish installing*, so the `nvm install` ordering is at least as strong as a feature hook.

## Target `.devcontainer/` layout (both source `default/` and what `devc config` writes)

```
.devcontainer/
  devcontainer.json      # top-level "postCreateCommand": "/usr/local/share/devc/scripts/post-create.sh"; no "./features/devc"
  Dockerfile             # COPY scripts/ -> image; bakes Claude CLI + .bashrc additions
  scripts/
    post-create.sh       # devc runtime setup (moved from features/devc/); ends by calling the user hook
    bashrc-additions.sh  # build-time shell additions (moved from features/devc/), cat'd into ~/.bashrc by the Dockerfile
    post-create.user.sh  # wizard-generated stub, first-creation only, NEVER regenerated (absent in the embedded default/)
```

`default/` (embedded) contains `scripts/post-create.sh` + `scripts/bashrc-additions.sh` only. The
`post-create.user.sh` stub is written by the `devc config` wizard on first creation, not embedded.

## Exact contract

- **`postCreateCommand`** (top-level, in the source `default/devcontainer.json`, verbatim in both
  paths): `"/usr/local/share/devc/scripts/post-create.sh"` — an absolute, image-baked path that
  resolves in zero-config (workspace has no `.devcontainer/`) and project mode alike.
- **Dockerfile**: `COPY scripts/ /usr/local/share/devc/scripts/`, then (as root) make them
  executable; the `.bashrc` append `cat`s `/usr/local/share/devc/scripts/bashrc-additions.sh`. Keep
  the marker-guarded append and the idempotent Claude-CLI install unchanged otherwise.
- **`post-create.sh` user-hook tail** (appended *after* the existing `cd "${PROJECT_PATH:-$PWD}"`
  and nvm block, so it stays outside the seed-block region that `seed_link_test.sh` extracts):
  ```bash
  # Project extension point. devc owns/regenerates this script but never touches
  # post-create.user.sh — put your own create-time setup there. Absent in zero-config.
  USER_HOOK="${PROJECT_PATH:-$PWD}/.devcontainer/scripts/post-create.user.sh"
  if [ -x "$USER_HOOK" ]; then
    echo "devc: running project post-create.user.sh"
    "$USER_HOOK"
  fi
  ```
  Preserve the exact anchor lines `SEED=/usr/local/share/devc/claude-seed` and
  `cd "${PROJECT_PATH:-$PWD}"` — `seed_link_test.sh` extracts the block between them with `awk`.
- **`post-create.user.sh` stub** (wizard writes on first creation, mode `0755`):
  ```bash
  #!/bin/bash
  # Project post-create hook — runs after devc's baseline setup on container create.
  # devc never regenerates this file, so anything added here survives `devc config`.
  # Edit + recreate the container (no rebuild needed) to apply changes. Example:
  #   cd "${PROJECT_PATH:-$PWD}"
  #   npm install
  set -e
  ```
- **`materializeDefaultConfig`**: copy the embedded `default/` tree to the cache verbatim and
  return `${cacheDir}/devcontainer.json`. **No JSON rewrite** — no feature deletion, no
  `postCreateCommand` injection (the source already carries it). The CLI accepts JSONC, so comments
  may remain. Still wipe any prior cache copy first (unchanged).
- **No `features/` anywhere**: `default/features/` is deleted; nothing in code, tests, or docs
  references `./features/devc`, `devcontainer-feature.json`, or `install.sh`.

## Implementation steps

1. **Move scripts.** Create `devc/default/scripts/`. Move `features/devc/post-create.sh` →
   `scripts/post-create.sh` and `features/devc/bashrc-additions.sh` → `scripts/bashrc-additions.sh`.
   Append the user-hook tail to `post-create.sh` (per contract). Delete
   `features/devc/install.sh`, `features/devc/devcontainer-feature.json`, and the now-empty
   `features/` tree.
2. **Dockerfile** (`devc/default/Dockerfile`): replace the `COPY features/devc/... /tmp/devc/` +
   `install`-to-`/usr/local/share/devc` dance with `COPY scripts/ /usr/local/share/devc/scripts/`
   and a root `chmod -R 0755 /usr/local/share/devc/scripts`. Point the `.bashrc` `cat` at
   `/usr/local/share/devc/scripts/bashrc-additions.sh`. Rewrite the header comment: build-time
   baseline here, runtime in `scripts/post-create.sh` via the top-level `postCreateCommand`; no
   feature involved.
3. **`devc/default/devcontainer.json`**: remove `"./features/devc": {}` from `features`; add
   top-level `"postCreateCommand": "/usr/local/share/devc/scripts/post-create.sh"`. Update the
   seed-mount comment (lines ~41–44) to say `post-create.sh symlinks ...` instead of "the devc
   Feature's postCreateCommand". Keep the `initializeCommand` and its comment (still top-level,
   still needed).
4. **`devc/default_config.ts`**:
   - `materializeDefaultConfig`: reduce to wipe + `copyDir` + return the config path; delete the
     `features` deletion and `postCreateCommand` assignment. Rewrite the doc comment to describe the
     unified, transform-free model. (`stripLineComments` stays — still used by
     `loadResolvedRemoteEnv`.)
   - Rename `copyBundledFeatures` → `copyBundledScripts`, copying the embedded `scripts/` subtree.
   - `BundledDefault.featuresDirUrl` → `scriptsDirUrl` (URL of `scripts/`); update `loadBundledDefault`.
   - Add and export `POST_CREATE_USER_STUB` (the stub text from the contract) for the wizard.
5. **`devc/wizard_apply.ts`**: import `copyBundledScripts`; in the `if (created)` block, write the
   `Dockerfile`, copy `scripts/`, then write `.devcontainer/scripts/post-create.user.sh` from
   `POST_CREATE_USER_STUB` with mode `0755` (`Deno.writeTextFile` then `Deno.chmod`). Update the
   header/`applySelection` doc comments to drop the Feature references and describe the `scripts/`
   copy + user stub.
6. **Tests** — `devc/tests/default_config_test.ts`:
   - "copies the embedded tree flat": expect `devcontainer.json`, `Dockerfile`,
     `scripts/post-create.sh`, `scripts/bashrc-additions.sh`; drop all `features/devc/*`.
   - Delete "materializes the devc Feature subtree (for the Dockerfile COPY)".
   - Rewrite "strips the local Feature and adds a top-level postCreateCommand" → assert the cache
     `devcontainer.json` has **no** `./features/devc`, keeps the ghcr node feature, and has
     `postCreateCommand === "/usr/local/share/devc/scripts/post-create.sh"`. Parse JSONC (inline
     comment-strip, as the "canonical" test already does) since the cache copy is now verbatim.
   - Rewrite "canonical default ... keeps the Feature and no top-level postCreateCommand" →
     "canonical default has no Feature and a top-level postCreateCommand" with flipped assertions.
   - "writes the embedded tree to real disk": sibling list → `Dockerfile`, `scripts/post-create.sh`,
     `scripts/bashrc-additions.sh`.
   - Leave `initializeCommand`, overwrite-idempotence, `ensureClaudeSeedDir`, `substituteVars`,
     `loadResolvedRemoteEnv` tests unchanged.
7. **Tests** — `devc/tests/wizard_apply_test.ts`, "first creation" test: assert `Dockerfile` and
   `scripts/post-create.sh` + `scripts/bashrc-additions.sh` were written, `post-create.user.sh`
   exists and is executable, **no** `features/` directory, the written `devcontainer.json` has a
   top-level `postCreateCommand` and no `./features/devc`. Rename the test title accordingly.
8. **`devc/README.md`**: line ~66 "the devc Feature symlinks each entry" → "`post-create.sh`
   symlinks each entry"; Development section invocation `default/features/devc/post-create.sh` →
   `default/scripts/post-create.sh`; drop any other "Feature" phrasing for the baseline.
9. **`.plans/design/devc-design.md`**: rewrite the "Bundled default and the `devc` Feature" section
   (≈44–67) to the featureless model — baseline via Dockerfile + top-level `postCreateCommand` →
   `scripts/post-create.sh`, composition via the `post-create.user.sh` hook, and note the
   `installsAfter`/ordering reasoning. Remove the OCI-vs-local **open decision** note (67) —
   resolved: no feature, so no distribution question. Fix line 31 (baseline "carried by a
   devcontainer Feature") and line 369 (embedded assets list mentioning "the `devc` Feature").
10. **Cross-plan note**: the in-progress `devc-claude-seed-dir` plan and any validation that runs
    `bash tests/seed_link_test.sh default/features/devc/post-create.sh` must use
    `default/scripts/post-create.sh` after this change. `seed_link_test.sh` itself needs no edit —
    it takes the path as an argument and the extracted block anchors are preserved.

## Checklist

- [x] `default/scripts/post-create.sh` and `default/scripts/bashrc-additions.sh` exist; user-hook tail appended
- [x] `default/features/` deleted (`install.sh`, `devcontainer-feature.json`, `post-create.sh`, `bashrc-additions.sh` gone)
- [x] Dockerfile `COPY scripts/ /usr/local/share/devc/scripts/`, chmod, and `cat` path updated; comments rewritten
- [x] `default/devcontainer.json`: no `./features/devc`; top-level `postCreateCommand` set; seed-mount comment updated
- [x] `materializeDefaultConfig` reduced to verbatim copy (no JSON transform); doc comment rewritten
- [x] `copyBundledFeatures`→`copyBundledScripts`; `featuresDirUrl`→`scriptsDirUrl`; `POST_CREATE_USER_STUB` exported
- [x] `wizard_apply.ts` copies `scripts/`, writes the `post-create.user.sh` stub (0755) on first creation; comments updated
- [x] `default_config_test.ts` updated/rewritten per step 6
- [x] `wizard_apply_test.ts` "first creation" test updated per step 7
- [x] `README.md` Feature references removed; seed-test path updated
- [x] `devc-design.md` Feature section rewritten; open-decision note removed; lines 31 & 369 fixed

## Validation

- [x] `cd devc && deno task check` — type-checks clean
- [x] `cd devc && deno task test` — all unit tests pass
- [x] `cd devc && deno task build` — binary compiles with the embedded `default/` (now `scripts/`, no `features/`)
- [x] `cd devc && bash tests/seed_link_test.sh default/scripts/post-create.sh` — seed prune+link block passes
- [x] `! test -e devc/default/features` — the feature tree is gone
- [x] `grep -rn "features/devc\|devcontainer-feature\|copyBundledFeatures\|featuresDirUrl" devc` returns nothing (only the three intentional `"./features/devc"` *negative-assertion* string literals in the tests remain — no live path/function refs)
- [x] `grep -c '"./features/devc"' devc/default/devcontainer.json` is `0`; the file has a top-level `"postCreateCommand"`
- [x] Manual: in a scratch dir, `deno task run -- config` (or drive `applySelection`) produces `.devcontainer/` with `Dockerfile`, `scripts/post-create.sh`, `scripts/bashrc-additions.sh`, an executable `scripts/post-create.user.sh`, a top-level `postCreateCommand`, and no `features/`
- [ ] Manual (docker): `deno task run -- up` in a project with no `.devcontainer/` creates a container; `~/.claude` seed links and nvm install still run (post-create.sh executed via top-level `postCreateCommand`) — NOT RUN: docker + devcontainer CLI unavailable in this environment

## Relevant Files

- `devc/default/devcontainer.json` — drop local feature; add top-level `postCreateCommand`; comment fix
- `devc/default/Dockerfile` — `COPY scripts/`; chmod; `cat` path; comment rewrite
- `devc/default/scripts/post-create.sh` — moved from `features/devc/`; user-hook tail appended
- `devc/default/scripts/bashrc-additions.sh` — moved from `features/devc/`
- `devc/default/features/devc/install.sh` — deleted
- `devc/default/features/devc/devcontainer-feature.json` — deleted
- `devc/default_config.ts` — `materializeDefaultConfig` simplified; `copyBundledScripts`; `scriptsDirUrl`; `POST_CREATE_USER_STUB`
- `devc/wizard_apply.ts` — copy `scripts/`; write user stub; comment updates
- `devc/tests/default_config_test.ts` — feature tests updated/removed/rewritten
- `devc/tests/wizard_apply_test.ts` — "first creation" test updated
- `devc/tests/seed_link_test.sh` — no edit; invocation path changes to `default/scripts/post-create.sh`
- `devc/README.md` — remove Feature phrasing; update seed-test invocation path
- `.plans/design/devc-design.md` — rewrite Feature section; remove OCI open-decision; fix lines 31 & 369
- `.plans/PLAN.md` — register this plan
