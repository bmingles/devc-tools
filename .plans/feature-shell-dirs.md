# `shell-dirs` Feature — source a project's `*.sh` in every interactive shell

## Goal

Publish `ghcr.io/bmingles/devc-tools/shell-dirs`: every `*.sh` in one or more
directories is sourced by every interactive container shell, in a defined order,
live (sourced from `~/.bashrc`, not appended into it).

**This one splits — but it is whole standalone.** `"shell-dirs": {}` with no
options, no mounts and no devc gives you the **project layer**: every `*.sh` in
the repo's own `.devcontainer/shell/`, which is the layer most consumers want.

The optional second layer is _personal, host-machine_ scripts, and it needs a
bind mount whose source exists — neither of which a Feature can declare (see
[devc-feature-split](design/devc-feature-split.md)). That mount belongs to the
**consumer's `devcontainer.json`**, exactly like the devc-bridge token mount:
any project can write it, this plan's README gives them the two lines, and devc
is simply a consumer that writes them automatically and points `userDir` at
where they landed. Nothing here is devc-only.

**Copy, don't move.** `devc:shell-dirs` in `bashrc-additions.sh` keeps running
as-is.

## Existing touchpoints

- `devc/default/scripts/bashrc-additions.sh`, the `devc:shell-dirs` fenced block
  (lines 39–82) — source material, verbatim where possible. Note its position:
  after everything devc sets (so a layer can override `PS1`/`cd`/`precmd`) and
  **before** the `DEVC_ATTACH` block that snapshots `PROMPT_COMMAND`.
- `devc/tests/shell_dirs_test.sh` — takes the script path as `$1`, extracts
  everything between the `devc:shell-dirs` markers, and rewrites the lines
  matching `^USER_SHELL_DIR=` and `^PROJECT_SHELL_DIR=` to point at temp dirs.
  **This plan reuses that harness against the Feature's copy**, which pins the
  contract below.
- `devc/README.md` "Shell setup: `shell/` folders" — the documented behavior the
  Feature must not change.
- `devc/default/devcontainer.json` (the user-layer mount) and
  `initialize-command.sh` (the `mkdir`) — cited, not edited.

## Contracts

### `features/shell-dirs/devcontainer-feature.json`

```jsonc
{
  "id": "shell-dirs",
  "version": "<repo version>",
  "name": "Shell script directories",
  "options": {
    "projectDir": { "type": "string", "default": ".devcontainer/shell" },
    "userDir": { "type": "string", "default": "" }
  }
}
```

- **`projectDir` is workspace-relative**, resolved at shell time against
  `$PROJECT_PATH` (empty disables the layer). Relative because the Feature does
  not know the container workspace path at build time and
  `${containerWorkspaceFolder}` substitution inside Feature metadata is unverified
  (`devc-feature-split`, open question 2). An absolute value is used as-is.
- **`userDir` is an absolute container path**, empty by default. This is the slot
  devc fills with `/usr/local/share/devc/shell` when it swaps over; a non-devc
  consumer can point it at anything already in the image.
- No lifecycle command and no mounts. Everything happens at build time in
  `install.sh` plus at shell time in `~/.bashrc`.

### The `~/.bashrc` block — same markers, same variable names

`install.sh` appends a marker-guarded block (`# >>> shell-dirs >>>` … `# <<< shell-dirs <<<`,
`grep -qF` guarded) to `$_REMOTE_USER_HOME/.bashrc`, containing the
`devc:shell-dirs` fenced block **copied from `bashrc-additions.sh`** with only
the two assignments substituted:

```sh
# devc:shell-dirs (start)
USER_SHELL_DIR=<userDir, or empty>
PROJECT_SHELL_DIR="${PROJECT_PATH:+$PROJECT_PATH/<projectDir>}"
_devc_source_shell_dir() { ... }        # unchanged
_devc_source_shell_dir "$USER_SHELL_DIR"
_devc_source_shell_dir "$PROJECT_SHELL_DIR"
unset -f _devc_source_shell_dir
unset USER_SHELL_DIR PROJECT_SHELL_DIR
# devc:shell-dirs (end)
```

Hard requirements, because `devc/tests/shell_dirs_test.sh` is the test:

- the fence markers stay **`# devc:shell-dirs (start)` / `(end)`**;
- the two assignments stay on their own lines starting `USER_SHELL_DIR=` and
  `PROJECT_SHELL_DIR=` (the harness rewrites them with `sed`);
- the function stays named `_devc_source_shell_dir`, and both it and the two
  variables are still unset at the end (the harness asserts no leaks);
- user layer first, project layer second; `*.sh` only; glob order within a layer;
  a missing or empty directory is a silent no-op.

### Standalone — what a non-devc project pastes

The README must carry both halves, ready to copy. Layer one needs nothing but
the Feature and `PROJECT_PATH`:

```jsonc
"features": { "ghcr.io/bmingles/devc-tools/shell-dirs:0": {} },
"remoteEnv": { "PROJECT_PATH": "${containerWorkspaceFolder}" }
```

Layer two is three lines the consumer owns, with no devc anywhere in them:

```jsonc
"initializeCommand": "mkdir -p ${localEnv:HOME}/.config/myshell",
"mounts": [
  "type=bind,source=${localEnv:HOME}/.config/myshell,target=/usr/local/share/myshell,readonly"
],
"features": {
  "ghcr.io/bmingles/devc-tools/shell-dirs:0": { "userDir": "/usr/local/share/myshell" }
}
```

Note the host path is **theirs**, not `~/.config/devc/shell`. The Feature must
never default `userDir` to a devc path — that would make it look like devc
plumbing and quietly bind nothing for everyone else.

### Co-existence with devc's own block

During the interim, a devc container that opts into this Feature via
`additionalFeatures` has **both** blocks, and the project layer is sourced twice.
Idempotent for aliases and `export`, **not** for `PATH=...:$PATH`. So:

- The block records what it sourced in a shell variable
  (`_DEVC_SHELL_DIRS_DONE`, a `:`-separated list of absolute paths) and skips a
  directory already listed. Both copies gain this guard — but devc's copy is
  touched **only** by the swap plan, not here, so the interim protection is
  one-sided and the Feature's README says plainly: _devc already does this; do
  not enable this Feature in a devc container until devc's own block is gone._
- The guard variable is deliberately not exported: it must reset per shell, not
  inherit into subshells that legitimately re-source.

### Ordering hazard — write it down, do not paper over it

Features install **after** the Dockerfile runs, so the Feature's `~/.bashrc`
block lands **after** devc's `bashrc-additions` block — i.e. after the
`DEVC_ATTACH` block that snapshots `PROMPT_COMMAND` into `_DEVC_BASE_PC`. A
sourced file that _assigns_ `PROMPT_COMMAND` (already documented as
discouraged) would then clobber `devc attach`'s first-prompt clear, where today
it is merely overwritten before the snapshot is taken.

- Not fixable from the Feature (`~/.bashrc` append order is not ours).
- Not a regression for non-devc consumers, who have no `DEVC_ATTACH` block.
- Record it in the Feature README **and** in this plan's Notes; the swap plan
  must move devc's `DEVC_ATTACH` block after the Feature's append (or make it
  re-assert itself at first prompt). Flagged here so that plan does not
  rediscover it in a container.

## Concept boundaries

- **`shell-dirs` (Feature) vs `devc:shell-dirs` (fence) vs `~/.config/devc/shell`
  (host dir) vs `.devcontainer/shell/` (project dir).** Four things one word
  away from each other. The README should name all four in one paragraph.
- **`projectDir` relative, `userDir` absolute.** Asymmetric on purpose: one is
  found through the workspace, the other is a fixed container path with a mount
  behind it. An absolute `projectDir` is accepted but bypasses the
  `$PROJECT_PATH` guard.
- **`PROJECT_PATH` is devc's `remoteEnv`.** For a non-devc consumer it is unset
  and the project layer silently does nothing — the same "interactive shells
  only, `PROJECT_PATH` required" caveat `devc/README.md` documents. The Feature
  README must say how to set it (`remoteEnv` in their `devcontainer.json`), or
  the Feature looks broken out of the box. **This is the Feature's sharpest
  usability edge; consider a `workspaceEnvVar` option defaulting to
  `PROJECT_PATH` only if a second variable name is actually needed — do not add
  it speculatively.**

## Checklist

- [ ] `features/shell-dirs/devcontainer-feature.json` — id/version/name, two
      options
- [ ] `features/shell-dirs/install.sh` — marker-guarded `~/.bashrc` append for
      `$_REMOTE_USER`, option substitution into the two assignments, fence
      markers preserved
- [ ] `_DEVC_SHELL_DIRS_DONE` skip-guard in the Feature's copy of the block
- [ ] `features/shell-dirs/README.md` — the two layers, ordering, `PROJECT_PATH`
      prerequisite, the "not inside devc yet" warning, the `PROMPT_COMMAND`
      caveat
- [ ] `features/shell-dirs/test/test.sh` — `devcontainer features test` scenario
- [ ] `features/shell-dirs/test/run-features-test.sh` — wrapper
- [ ] `features/README.md` — row
- [ ] `devc/README.md` — Development section lists the new harness invocation
- [ ] `.plans/PLAN.md` — register

## Validation

- [ ] `bash devc/tests/shell_dirs_test.sh features/shell-dirs/install.sh`
      passes **unmodified** — the existing harness, pointed at the Feature. If it
      needs changes to pass, the copy has drifted and the contract above is broken
- [ ] `bash devc/tests/shell_dirs_test.sh devc/default/scripts/bashrc-additions.sh`
      still passes (devc's copy untouched)
- [ ] A case added to the harness (or a sibling harness) for the
      `_DEVC_SHELL_DIRS_DONE` guard: sourcing the block twice sources each file
      once
- [ ] (needs Docker) `bash features/shell-dirs/test/run-features-test.sh` —
      scenario with `remoteEnv.PROJECT_PATH` and a `.devcontainer/shell/10-a.sh`
      that exports a marker: a fresh interactive shell has it; ordering with a
      `userDir` layer is user-then-project; an empty `projectDir` disables it
- [ ] (needs Docker) **the bare `{}` scenario** — no options, no mounts: installs
      cleanly and sources the project layer. The Feature is not allowed to be
      inert without devc, and this is what proves it
- [ ] `deno fmt --check` clean

## Not in this plan

- Any edit to `devc/default/` — the mount, `initialize-command.sh`, and the
  `devc:shell-dirs` block all stay. The `DEVC_ATTACH` reordering belongs to the
  swap plan.
- `zsh`/`fish` support. `install.sh` writes bash only; note it as a limitation
  rather than half-implementing it.
