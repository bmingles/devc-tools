# shell-dirs (devcontainer Feature)

Sources every `*.sh` in one or two directories from **every interactive shell**, in
a defined order. Drop a file in, open a new terminal, and it is there — the files
are sourced from `~/.bashrc`, not appended into it, so nothing is rebuilt and
nothing is baked.

```jsonc
"features": { "ghcr.io/bmingles/devc-tools/shell-dirs:0": {} },
"remoteEnv": { "PROJECT_PATH": "${containerWorkspaceFolder}" }
```

That is the whole setup for the layer most people want: every `*.sh` in your repo's
own `.devcontainer/shell/`. No mounts, no options, nothing host-side.

```sh
# .devcontainer/shell/10-project.sh
alias t='deno task test'
export DATABASE_URL=postgres://localhost/dev
```

> The tag tracks **this Feature's** version line, not the repo's — Features version
> independently of the devc-tools release tag. It is `:0` while this Feature is
> pre-1.0; it becomes `:1` at its first 1.x release.

> **Do not enable this in a [devc](../../devc/README.md) container yet.** devc's own
> baseline already sources both layers, and until that is removed you would get the
> project layer twice. See [Relationship to devc](#relationship-to-devc).

## `PROJECT_PATH` is a prerequisite, not a nicety

`projectDir` is **workspace-relative**, and it is resolved at shell time against
`$PROJECT_PATH`. If that variable is not set in the container, the project layer
sources nothing and the Feature looks broken. Hence the `remoteEnv` line above —
it is half of the two-line install, not a footnote.

There is deliberately **no fallback to `$PWD`**: a shell that happens to open in
some directory should not source whatever `*.sh` it finds there.

`PROJECT_PATH` is a plain environment variable, so anything that sets it works —
`remoteEnv`, `containerEnv`, your image. devc sets it already and re-passes it on
`exec` and `attach`.

If you would rather not set it, give `projectDir` an **absolute** container path
instead. Absolute values are used as-is and never consult `PROJECT_PATH`.

## The second layer: personal scripts from your host

The optional `userDir` layer is your own preferences, applied in every project.
It is an **absolute container path**, and this Feature neither creates it nor
mounts anything into it — a Feature cannot declare an `initializeCommand`, and the
published Feature schema's `Mount` cannot express `readonly`
([why](../../.plans/design/devc-feature-split.md)). So the bind belongs to your
`devcontainer.json`, which is three lines you own:

```jsonc
"initializeCommand": "mkdir -p ${localEnv:HOME}/.config/myshell",
"mounts": [
  "type=bind,source=${localEnv:HOME}/.config/myshell,target=/usr/local/share/myshell,readonly"
],
"features": {
  "ghcr.io/bmingles/devc-tools/shell-dirs:0": { "userDir": "/usr/local/share/myshell" }
}
```

The host path is **yours** — pick anything. This Feature will never default
`userDir` to a devc path, or to any path at all: a default there would look like
plumbing that works while quietly binding nothing for everyone who is not devc.

The `initializeCommand` is what makes the mount source exist. A bind mount with a
missing source is a hard error, not an auto-created directory.

Mount it `readonly` if you can. Written as a **string** (as above) the devcontainer
CLI passes the spec through to `docker --mount` verbatim, so `readonly` survives;
the object form is re-serialized and drops it.

## Ordering

**User layer first, project layer second**, so a project's committed settings win
on conflict — the same `system → global → local` order git uses. A project file
that _assigns_ rather than appends to a shared variable (`PS1`, `PATH`) therefore
overrides your personal one.

**Within a layer**, glob (name) order. Prefix with `10-`, `20-`, … to control it.

Only `*.sh` is sourced. A `README.md` or a `notes.txt` alongside is ignored, and so
is a subdirectory, even one named `something.sh`. A missing or empty directory is a
silent no-op — the Feature is safe to leave enabled in a repo that ships no scripts.

| Option       | Default               | Meaning                                                                                                              |
| ------------ | --------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `projectDir` | `.devcontainer/shell` | Workspace-relative directory, resolved against `$PROJECT_PATH`. An absolute value is used as-is. Empty disables it.  |
| `userDir`    | _(empty)_             | Absolute container path, sourced **before** the project layer. Empty disables it. Nothing here creates or mounts it. |

The asymmetry is on purpose: one directory is found _through_ the workspace, the
other is a fixed container path with a mount behind it.

## Four things one word apart

Worth naming in full once, because they are easy to confuse:

- **`shell-dirs`** — this Feature, published at
  `ghcr.io/bmingles/devc-tools/shell-dirs`.
- **`devc:shell-dirs`** — the comment fence around the block this Feature writes
  into `~/.bashrc`. It keeps the `devc:` prefix even here, because
  `devc/tests/shell_dirs_test.sh` finds the block by those markers and runs against
  both copies unmodified — that is what stops the two drifting apart.
- **`.devcontainer/shell/`** — the default **project** directory, in your workspace.
- **`~/.config/devc/shell/`** — the **host** directory devc happens to bind for its
  own containers. It is not a default here and this Feature does not know about it.

## What it does

At **build time** (as root) it appends one marker-guarded block to the remote user's
`~/.bashrc`, between `# >>> shell-dirs >>>` and `# <<< shell-dirs <<<`, with the two
options substituted into its two directory assignments. That is all it does: no
lifecycle command, no mounts, nothing created, nothing fetched. The guard is the
opening marker, so a rebuild does not double-append.

At **shell time** the block sources each layer, resolving both directories fresh
every time. That is what makes it live: a file added after the container was built
is picked up by the next shell, and deleting one stops it being read.

An option containing `"`, `` ` ``, `$` or `\` **fails the build**, naming the option.
The values are pasted into a shell assignment, and a silently mangled block would
source something other than what you asked for.

### bash only

`install.sh` writes `~/.bashrc`. zsh and fish get nothing — deliberately unwritten
rather than half-written. If your container's default shell is not bash, this
Feature does nothing for it.

### It runs last, which is usually what you want

Features install **after** the image's own Dockerfile, so this block lands at the
end of `~/.bashrc`, after anything the base image or another Feature put there.
A layer can therefore override a prompt, a `cd` wrapper or an alias set earlier.

The one thing to avoid is **assigning `PROMPT_COMMAND` outright** — append to it
instead. Anything installed there before this block runs is dropped. In a devc
container that is not hypothetical: devc's `DEVC_ATTACH` block snapshots
`PROMPT_COMMAND` to restore it after the first prompt, and it sits _before_ this
Feature's block, so a layer that assigns `PROMPT_COMMAND` would clobber
`devc attach`'s first-prompt clear. `~/.bashrc` append order is not this Feature's
to change; see [Relationship to devc](#relationship-to-devc).

## Relationship to devc

The block here was copied out of [devc](../../devc/README.md)'s baseline — the
`devc:shell-dirs` fence in `devc/default/scripts/bashrc-additions.sh` — with only
the two directory assignments substituted. **devc's copy still runs unchanged**;
swapping devc onto this published Feature is a separate change.

Until that happens, enabling this Feature in a devc container is **redundant and
mildly harmful**: devc already sources both layers, so the project layer would be
sourced twice. That is idempotent for aliases and `export`, and not for
`PATH="…:$PATH"`.

This Feature's copy guards against it as far as one side can. The block records
what it sourced in `_DEVC_SHELL_DIRS_DONE` (a `:`-separated list of paths, one per
shell, deliberately **not** exported so a subshell that legitimately re-sources
`~/.bashrc` starts clean) and skips a directory already listed. devc's copy has no
such guard yet, and it runs first — so it sources, and this one skips. That happens
to work, but it is one-sided by construction. Do not rely on it; wait for the swap.

One difference from devc's copy beyond the guard: **nothing here defaults to a devc
path.** devc's `USER_SHELL_DIR` is `/usr/local/share/devc/shell`, which is where its
own mount lands. Here `userDir` is empty until you say otherwise.

## Tests

No Docker needed. The shared block, extracted from the real `install.sh` — this is
the harness that pins the copy to devc's, and it must pass **unmodified** against
both files:

```sh
bash devc/tests/shell_dirs_test.sh features/shell-dirs/install.sh
bash devc/tests/shell_dirs_test.sh devc/default/scripts/bashrc-additions.sh
```

If the first one needs changes to pass, this Feature's copy has drifted.

The two things that harness deliberately does not cover, each in its own file
because that one must stay runnable against both copies:

```sh
bash features/shell-dirs/test/shell_dirs_guard_test.sh   # the _DEVC_SHELL_DIRS_DONE guard
bash features/shell-dirs/test/install_options_test.sh    # options → assignments, and the append
```

The guard harness is a sibling rather than a case in `shell_dirs_test.sh` for the
obvious reason: devc's copy has no guard, so a case added there would fail by
design.

Needs Docker and a network. The default scenario is the bare `{}` case — no
options, no mounts, no devc — and `test/scenarios.json` adds the workspace,
the second layer, and the off switch:

```sh
bash features/shell-dirs/test/run-features-test.sh
```

| Scenario           | What it pins                                                      |
| ------------------ | ----------------------------------------------------------------- |
| _(default)_        | A bare `{}` installs cleanly and sources a project layer.         |
| `project_layer`    | `remoteEnv.PROJECT_PATH` + a real workspace; live add and delete. |
| `both_layers`      | User layer first, project layer second; project wins on conflict. |
| `no_project_layer` | `"projectDir": ""` disables the layer instead of falling back.    |

Each scenario writes its `*.sh` fixtures from its own `onCreateCommand`, which runs
before every `postCreateCommand`, because `devcontainer features test` generates the
workspace folder itself — there is no committed fixture that could already be there.

## Publishing

`.github/workflows/publish-feature.yml` publishes this folder to
`ghcr.io/bmingles/devc-tools/shell-dirs` on a push to `main` that touches
`features/`, in its own matrix job. `version` is this Feature's own — bump it in the
commit that changes this Feature, and nothing else in the repo has to move; leave it
and the publish is a no-op, since the CLI skips a version already in the registry.
There is no `DEVC_TOOLS_RELEASE` in `install.sh` — this Feature downloads no release
asset, so it pins none.
