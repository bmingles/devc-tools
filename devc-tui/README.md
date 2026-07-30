# devc-tui

Selectively bind-mount **sibling projects** (and agent skill folders) into the devcontainer
of the repo you are working in, and mirror the selection into its VS Code workspace file.

You keep all your repos and worktrees under one directory. devc-tui scans that directory,
lets you pick what the current container should see, and rewrites exactly three
comment-fenced blocks:

| Fence | File | Array |
| --- | --- | --- |
| `devc-tui:projects` | `.devcontainer/devcontainer.json` | `mounts` |
| `devc-tui:skills` | `.devcontainer/devcontainer.json` | `mounts` |
| `devc-tui:folders` | `<name>.code-workspace` | `folders` |

```jsonc
{
  "mounts": [
    // my ssh agent, nothing to do with devc-tui   ← untouched, comments included
    "type=bind,source=/run/host-services/ssh-auth.sock,target=/ssh-agent",
    // >>> devc-tui:projects (managed - do not edit)
    "type=bind,source=/Users/me/src/projectb,target=/workspaces/projectb",
    "type=bind,source=/Users/me/src/projectb.worktrees/some-other,target=/workspaces/projectb.worktrees/some-other"
    // <<< devc-tui:projects
  ]
}
```

**Trust note.** devc-tui writes to files in the current workspace dir — the devcontainer
file and the `.code-workspace`. Everything outside its fences (comments, formatting, keys it
knows nothing about) is preserved byte-for-byte, and `--dry-run` shows the exact diff before
you commit to it. It never touches anything under the scanned root.

This phase is headless: a CLI plus tests. The interactive checkbox tree comes next and drives
the same apply path.

## Install

Run it from source via the repo's shell integration (no build step):

```sh
source /path/to/devc-tools/scripts/bash_aliases.sh   # from your ~/.bashrc
devc-tui config init      # writes ~/.config/devc-tui/config.json
$EDITOR "$(devc-tui config path)"   # set "root" (and "skillsRoot", if you want skills)
```

Or compile a standalone binary: `cd devc-tui && deno task build` → `./devc-tui`.

**It runs on the host, not inside the container.** Mount `source` paths are host paths and
the scanned root is a host directory, so invoke devc-tui from the same shell where you
`source scripts/bash_aliases.sh`. `containerRoot` and `skillsContainerRoot` are strings it
writes, not paths it resolves.

## Prerequisite: relative worktrees

Mounting a Git worktree only works if its `.git` pointer is **relative**, because the
absolute host path does not exist inside the container. Requires Git ≥ 2.48:

```sh
git config --global worktree.useRelativePaths true      # for new worktrees
git -C <worktree> worktree repair --relative-paths      # for worktrees you already have
```

Then `<worktree>/.git` reads `gitdir: ../../projecta/.git/worktrees/feat`, and devc-tui keeps
that offset intact in the container by mounting each project at
`containerRoot + "/" + <path relative to root>` — never a flattened basename. That is also
why **selecting a worktree automatically mounts its primary repo** (shown as `[~]`, and left
out of the workspace folder list).

`devc-tui list --json` reports `relativeGitdir` per worktree, so you can spot the ones that
still need `worktree repair`.

## Layout it expects

```
<root>/projecta/.git                     → projecta
<root>/projecta.worktrees/some-feature   → projecta.worktrees/some-feature   (child of projecta)
<root>/projectb/.git                     → projectb
<root>/projectb.worktrees/some-other     → projectb.worktrees/some-other
<root>/org/tools/.git                    → org/tools                        (under group "org")
<root>/noise/                            → pruned: nothing selectable beneath it
```

- A directory containing `.git` (file or dir) is a **project**; devc-tui does not descend
  into it.
- `<base>.worktrees/` is a **worktree group** bound to the sibling `<base>` project; each
  immediate subdirectory is a worktree, displayed under `<base>`.
- Anything else is a **group** — not selectable, pruned when nothing selectable is beneath it.
- A `<base>.worktrees` with no sibling `<base>` shows as `<base> (missing primary)` and its
  worktrees are not selectable: without the primary's mount, git inside them would not work.
- The **id** of a project or worktree is its path relative to `root`. Ids are what the CLI
  takes and what the fences round-trip.

## Config — `~/.config/devc-tui/config.json`

Created with these defaults on first run. Unknown keys are preserved.

```json
{
  "root": "",
  "containerRoot": "/workspaces",
  "maxDepth": 3,
  "skillsRoot": "",
  "skillsContainerRoot": "/home/vscode/.claude/skills",
  "devcontainerPath": ".devcontainer/devcontainer.json",
  "workspaceFile": null
}
```

| Key | Meaning |
| --- | --- |
| `root` | Host dir scanned for projects. Unset ⇒ scanning commands exit 2. |
| `containerRoot` | Container-side parent for mounted projects. |
| `maxDepth` | Levels below `root` to descend looking for projects. |
| `skillsRoot` | Host dir whose immediate subdirectories are individually mountable skills. Unset ⇒ `skills` subcommands exit 2, and an existing `devc-tui:skills` fence is left as-is. |
| `skillsContainerRoot` | Container-side parent for mounted skills. |
| `devcontainerPath` | Devcontainer file, relative to the workspace dir. |
| `workspaceFile` | Workspace file relative to the workspace dir; `null` auto-detects. |

`DEVC_TUI_CONFIG` (or `--config <path>`) overrides the config file path.

The **workspace dir** is the cwd (or `--workspace-dir <path>`) — the repo being configured.
It is independent of `root`: it may sit inside it, outside it, or *be* it. If it falls inside
`root` its own node is marked `current workspace` and is not selectable, since the container
already mounts it.

With `workspaceFile: null` the workspace file is the single `*.code-workspace` in the
workspace dir, or `<basename>.code-workspace` if there is none. Two or more candidates is
ambiguous — devc-tui exits 2 and asks you to set the key.

## CLI

```
devc-tui list                        show the projects under the configured root
devc-tui status                      resolved config, target files, fence entry counts
devc-tui select <id>...              add projects/worktrees to the selection, then apply
devc-tui deselect <id>...            remove projects from the selection, then apply
devc-tui apply                       rewrite all three fences (idempotent)
devc-tui skills list                 show the skill dirs under skillsRoot
devc-tui skills enable <name>...     mount skill dirs, then apply
devc-tui skills disable <name>...    unmount skill dirs, then apply
devc-tui config show|path|init       print the resolved config / its path / create it
```

Global flags: `--workspace-dir <path>`, `--root <path>`, `--config <path>`, `--create`,
`--dry-run`, `--json`, `--no-color`.

`list` markers: `[x]` selected, `[ ]` selectable, `[~]` mounted only because a selected
worktree needs it, and blank for nodes you cannot select (groups, the current workspace, an
orphaned worktree).

Exit codes: **0** success, **1** runtime error, **2** usage/config error.

- The workspace file is created when missing. A missing **devcontainer** file is an error
  unless you pass `--create`, which writes a minimal one (set the image to taste afterwards).
- `--dry-run` prints a unified diff per changed file and writes nothing.
- `--json` makes `list`/`status`/`skills list` emit an object; write commands emit
  `{"changed":["<path>",...]}`.

There is no selection state file: the selection **is** the `devc-tui:folders` block (falling
back to `devc-tui:projects` when the workspace file has no fence), so the tool and the repo
can never drift. Entries that no longer match anything under `root` are dropped with a
warning on stderr.

## Fence contract

```
// >>> devc-tui:<id> (managed - do not edit)
<entries, one per line>
// <<< devc-tui:<id>
```

- Fences are matched by regex, so trailing text may drift without breaking round-trips.
- A fence you move elsewhere inside the same array is rewritten **in place** — devc-tui only
  appends a block when it cannot find one.
- An open fence with no matching close is an error: devc-tui exits 1 and writes nothing.
- Editing is text surgery, never parse-and-reserialize. Commas are normalized per array so
  the result is valid **strict** JSON (no trailing comma) as well as JSONC.
- A project whose host path contains `,` or `=` cannot be expressed as a mount string and is
  skipped with a warning.

## Development

```sh
cd devc-tui
deno task check   # type-check
deno task test    # unit + CLI tests (no terminal, no host needed)
deno task run --  # e.g. deno task run list
deno task build   # standalone ./devc-tui binary
```

Tests build every root, workspace dir, and skills dir under `Deno.makeTempDir()` — they never
read or write anything inside this repo. `tests/fixtures/` holds hand-written JSONC cases
(fences between user elements, a pre-existing trailing comma, `],` and `//` inside a string
literal, an unterminated fence) that pin the file-surgery behavior.

| File | Role |
| --- | --- |
| `main.ts` | argv parsing, global flags, dispatch, usage |
| `cli.ts` | subcommand implementations, text/JSON output, dry-run diff |
| `config.ts` | config load/init, target-file resolution |
| `scan.ts` | root → project/worktree tree with stable ids |
| `model.ts` | selection → mounts/folders, worktree closure, read-back |
| `jsonc_edit.ts` | JSONC scanner, fence splice, comma normalization |
| `devcontainer.ts` / `workspace.ts` | per-file read/create/write |
| `skills.ts` | skills discovery and toggle |
| `diff.ts` | unified diff for `--dry-run` |
