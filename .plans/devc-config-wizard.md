# devc config wizard — project `.devcontainer/` via managed fences

## Context

See `.plans/design/devc-design.md` → "`config` (TUI)" and "No hidden abstraction → Managed mount
blocks". This phase turns `devc config [PATH]` into the full four-step project wizard, building on
the wizard TUI shell + global config from `devc-global-config`. It reuses the kept
`devc/jsonc_edit.ts` (fence surgery on JSONC arrays) — the wizard writes only two comment-fenced
mount blocks and preserves everything else byte-for-byte.

The wizard owns exactly two regions of the project `devcontainer.json`'s `mounts` array:

- `// devc:source` … `// /devc:source` — extra source-code mounts.
- `// devc:skills` … `// /devc:skills` — skills mounts.

Infra mounts (claude-config volume, CLAUDE.md/settings/statusline binds, cache volumes) and the
`Dockerfile` are written **once, at first creation**, from the bundled default and are never
re-asserted. On reconfigure, only the two fences are rewritten.

### Base resolution + first-creation vs. update

- Resolve project dir (`PATH` or cwd). If `${CONFIG_DIR}/config.json` is missing and stdin is a
  TTY, run the Global config step first (from `devc-global-config`).
- **Base:** if `PATH/.devcontainer/devcontainer.json` exists, it is the base (update-in-place);
  else the bundled default is the base (first-creation).
- Seed the steps: source/skills from the base's `devc:source`/`devc:skills` fences via
  `parseFenceEntries`. If the base has no such fences (bundled default, or a hand-written config),
  source starts empty and **skills is pre-seeded from the remembered list** (`recentSkills` in the
  global config, filtered to host paths that still exist) — see design Step 3.

### Mount serialization (contract)

Each row serializes to a standard devcontainer bind-mount string:

```
type=bind,source=<HOST>,target=<CONTAINER>,consistency=cached[,readonly]
```

- **Host path (`source`)**: if under `$HOME`, write `${localEnv:HOME}/<rest>` (matches the bundled
  default's style and the existing home-path convention); otherwise the absolute host path.
- **Container path (`target`) defaults**: source → `/workspaces/<basename>`; skills →
  `${SKILLS_CONTAINER_ROOT}/<basename>`. Define `SOURCE_CONTAINER_ROOT = "/workspaces"` and
  `SKILLS_CONTAINER_ROOT = "/home/vscode/.claude/skills"` as single consts (design writes this as
  `~/.claude/skills/<basename>`, where the in-container agent discovers skills).
- **Read-only**: append `,readonly` when set. Default **off** for source, **on** for skills.
- Duplicate `target` within a step is rejected (design).

### Apply (contract)

1. `mkdir -p PATH/.devcontainer/`.
2. **First creation:** take the bundled default `devcontainer.json` text, ensure the two fences
   exist in the `mounts` array (`ensureArray` + `writeBlocks`/`findFence` from `jsonc_edit`),
   populate them from the source/skills rows, write the file. Copy the bundled `Dockerfile`
   verbatim. **Copy the bundled `features/` subtree** into `PATH/.devcontainer/features/` so the
   `"./features/devc"` relative reference resolves for the project (the bundled devcontainer.json
   references the local Feature — see `devc-container-feature`).
3. **Update in place:** rewrite only the two fences (`writeBlocks`) on the existing file text;
   leave the `Dockerfile` and `features/` untouched. If the existing file lacks the fences, insert
   them into its `mounts` array (creating `mounts` via `ensureArray` if absent).
4. Persist the applied skills list to `recentSkills` in the global config.
5. Print a success message naming the file(s) written.

Cancel/quit writes nothing.

### Directory picker

`Add` in Step 2/3 picks from the configured roots (codeRoots / skillsRoots respectively): if more
than one root, first choose a root; then a minimal directory browser rooted there (`Deno.readDir`,
directories only; `Enter` descends, a select key chooses the current directory as the mount host
path). New rows get the default container path + default read-only for that step.

### Gotchas

- **Fences live inside the `mounts` array**, not at top level: operate via
  `findArraySpan(src, "mounts")` then the fence helpers. `jsonc_edit` already refuses a
  half-written fence (`UnterminatedFenceError`) — surface it naming the file.
- **First-creation must insert fences** into the bundled default (which ships without them); do not
  assume they exist.
- **Local Feature reference needs the subtree in the project** — copying `features/` on first
  creation is required or `devcontainer up` fails to resolve `./features/devc`.
- **Skills mount target is `~/.claude/skills/<name>`** — where the in-container agent already looks
  for skills, so no symlink/Feature wiring is needed for discovery. Note the `.claude` dir is a
  volume mount in the default; per-folder skill binds land underneath it.
- **term.ts restore** — never bypass the terminal restore path on any wizard exit.
- **`recentSkills` load/expand:** stored raw (with `${localEnv:HOME}`/`~` as entered); expand for
  the existence-filter when seeding a new project.

## Checklist

- [ ] Extend `devc/tui/wizard_state.ts` with the four project steps (overview, source, skills,
      review) as additional steps after the global step; per-step mount tables with add/remove,
      container-path edit, read-only toggle; text-input + directory-picker sub-modes.
- [ ] Extend `devc/tui/wizard_render.ts` — render mount tables, the picker, and the review preview
      (show the two fences' would-be contents + new/update status).
- [ ] `devc/mounts.ts` (new) — pure helpers: serialize a mount row → spec string; parse a fence
      entry → row; defaults + duplicate-target validation; `SOURCE_CONTAINER_ROOT`,
      `SKILLS_CONTAINER_ROOT` consts; host-path `${localEnv:HOME}` folding.
- [ ] `devc/wizard_apply.ts` (new) — first-creation vs update-in-place logic over `jsonc_edit`
      (`findArraySpan`, `ensureArray`, `findFence`, `parseFenceEntries`, `writeBlocks`), Dockerfile
      + `features/` copy on creation, `recentSkills` persistence.
- [ ] `devc/config.ts` — add `recentSkills: string[]` to the schema (load/save, unknown-key
      preserving); raw storage + expanded accessor.
- [ ] `devc/main.ts` — `config [PATH]` opens the full project wizard (global step first when
      config missing + TTY). Resolve base per precedence.
- [ ] `devc/default_config.ts` — expose a helper returning the bundled default `devcontainer.json`
      text + `Dockerfile` bytes + `features/` dir URL for the wizard (reads embedded assets).
- [ ] Tests: `devc/tests/mounts_row_test.ts` (serialize/parse round-trip, home folding, defaults,
      dup rejection); `devc/tests/wizard_apply_test.ts` (first-creation inserts populated fences +
      copies Dockerfile/features; update rewrites only fences and preserves infra + a hand-added
      mount + a comment byte-for-byte; reconfigure recovers selection from fences; remembered-list
      seeding for a new project); `devc/tests/wizard_project_state_test.ts` (scripted key flows:
      add/remove/toggle/dup-reject/apply/cancel).
- [ ] `devc/deno.json` — add new modules to `check`.

## Validation

- [ ] `cd devc && deno task test` — all wizard/mounts/apply tests pass.
- [ ] `cd devc && deno task check` clean.
- [ ] First-creation test: bundled default → `.devcontainer/devcontainer.json` contains both fences
      populated with the configured mounts, infra mounts intact, `Dockerfile` + `features/devc/`
      copied.
- [ ] Idempotence: apply the same selection twice → the second write is byte-identical.
- [ ] Preservation: hand-add a mount and a comment outside the fences, reconfigure + apply → those
      survive byte-for-byte and infra mounts are **not** re-asserted after being removed by hand.
- [ ] Remembered list: apply skills `[A,B]` in project 1; a fresh project's Skills step is
      pre-seeded with `[A,B]` (minus any whose host path no longer exists); source starts empty.
- [ ] Dup rejection: adding a second mount with an existing container `target` is refused.
- [ ] (user) `devc config` in a real repo produces a `.devcontainer/` that `devc up` builds, with
      the selected source folders at `/workspaces/<name>` and skills at `~/.claude/skills/<name>`,
      discovered by the in-container agent.

## Relevant Files

- `devc/tui/wizard_state.ts` — extended: four project steps + sub-modes.
- `devc/tui/wizard_render.ts` — extended: mount tables, picker, review preview.
- `devc/mounts.ts` — new: mount row serialize/parse + consts + validation.
- `devc/wizard_apply.ts` — new: fence-based apply (create vs update) + asset copy + remembered list.
- `devc/config.ts` — extended: `recentSkills`.
- `devc/default_config.ts` — extended: bundled-asset accessors for the wizard.
- `devc/main.ts` — `config [PATH]` → full project wizard.
- `devc/jsonc_edit.ts` — reused unchanged (fence surgery).
- `devc/tests/{mounts_row,wizard_apply,wizard_project_state}_test.ts` — new tests.
- `devc/deno.json` — `check` list update.
