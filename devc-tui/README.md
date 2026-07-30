# devc-tui

Selectively bind-mount **sibling projects** (and agent skill folders) into the devcontainer
of the repo you are working in, and mirror the selection into its VS Code workspace file.

You keep all your repos and worktrees under one directory. devc-tui scans that directory,
lets you pick what the current container should see, and rewrites exactly three
comment-fenced blocks:

| Fence | File | Array | Paths |
| --- | --- | --- | --- |
| `devc-tui:projects` | `.devcontainer/devcontainer.json` | `mounts` | `source=` host, `target=` container |
| `devc-tui:skills` | `.devcontainer/devcontainer.json` | `mounts` | `source=` host, `target=` container |
| `devc-tui:folders` | `<name>.code-workspace` | `folders` | host, relative to the workspace file |

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

The `.code-workspace` is opened by VS Code **on the host**, so its `folders` entries are host
paths — written relative to the workspace file, the same way you would write them by hand:

```jsonc
{
  "folders": [
    { "path": "." },                          // ← yours, untouched
    // >>> devc-tui:folders (managed - do not edit)
    { "path": "../projectb.worktrees/some-other", "name": "projectb.worktrees/some-other" }
    // <<< devc-tui:folders
  ]
}
```

The `name` is the id (the path relative to `root`), which is what survives the round-trip;
only the `path` is relative. An entry that does not resolve to something under `root` is left
for you and dropped from the selection with a warning.

**Trust note.** devc-tui writes to files in the current workspace dir — the devcontainer
file and the `.code-workspace`. Everything outside its fences (comments, formatting, keys it
knows nothing about) is preserved byte-for-byte, and `--dry-run` shows the exact diff before
you commit to it. It never touches anything under the scanned root.

Run `devc-tui` with no arguments for the interactive tree; every subcommand below does the
same work headlessly, through the same write path.

## The interactive tree

The tree mirrors the directory layout under the scanned root: every folder sits where it does
on disk, and folders open and close.

```
 devc-tui  ~/src -> /workspaces               5 mounts  4 folders  1 skills   *unsaved
 PROJECTS
        myapp  (workspace)
  v [-] org
>     [x] lib
      [ ] tools
    [~] projecta  (required by worktree)
  v [x] projecta.worktrees
      [x] some-feature
  > [ ] projectb.worktrees

 SKILLS  ~/.claude/skills -> /home/vscode/.claude/skills
      [x] deephaven-docs
      [ ] marp-writing

 wrote .devcontainer/devcontainer.json, myapp.code-workspace
 arrows move  space toggle  / filter  a/n all/none  w write  ? help  q quit
```

Folders **start collapsed** — except along the path to whatever is already mounted, so the
current selection is on screen from the first frame. `right`/`l` opens one, `left`/`h` closes
it.

The header names the scanned root, where it lands in the container, live counts derived from
the current selection, and `*unsaved` when the selection differs from what is on disk. The
last two lines are the result of the last action and the keys. When the list is taller than the
window the right-hand column becomes a scrollbar (`|` track, `#` thumb). Nothing is written
until you press `w`.

| Marker | Meaning |
| --- | --- |
| `[ ]` | not selected |
| `[x]` | selected |
| `[~]` | mounted only because a selected worktree needs its primary repo |
| `[-]` | folder with some, but not all, of its projects selected |
| no checkbox | not selectable — a plain folder with nothing selectable in it, an orphaned worktree, or the current workspace. The note or warning on the row says which |
| `v` / `>` | folder open / closed — fold state only, nothing else |
| `>` in the first column | the cursor (also drawn in reverse video, unless colour is off) |
| `! ...` | a warning: `absolute gitdir`, `primary repo not found`, ... |

| Key | Action |
| --- | --- |
| `up`/`down`, `k`/`j` | move the cursor (headings are skipped) |
| `PgUp`/`PgDn` | move one screen |
| `Home`/`End`, `g`/`G` | first / last row |
| `space`, `Enter` | toggle the row under the cursor |
| `right`/`l` | expand |
| `left`/`h` | collapse, or jump to the parent |
| `Tab` | jump to the next section |
| `/` | filter by id; `Enter` keeps the filter, `Esc` clears it |
| `a` / `n` | select / deselect what is on screen — with a filter, its matches only |
| `r` | rescan the root, keeping the selection |
| `w` | write both files |
| `?` | keybindings |
| `q` | quit (asks first when there are unsaved changes) |
| `Ctrl-C` | quit immediately, writing nothing |

Toggling a **folder** selects all of the projects inside it, or clears them if they were all
selected — including a `.worktrees` folder, which toggles every worktree in it. Toggling a
`[~]` primary makes it explicit (`[x]`); toggling it again returns it to `[~]` rather than
`[ ]`, because a selected worktree still needs its mount.

`a` / `n` only reach rows that are actually on screen, so a fold is also a way to keep a bulk
select off the parts of the root you are not interested in.

The tree needs at least a 40x10 window and a real terminal: with stdin redirected it exits 2
and points you at `devc-tui list` / `devc-tui select` instead. `--no-color` and `NO_COLOR`
drop every escape sequence without changing the layout.

## Install

Run it from source via the repo's shell integration (no build step):

```sh
source /path/to/devc-tools/scripts/bash_aliases.sh   # from your ~/.bashrc
devc-tui config init      # writes ~/.config/devc-tui/config.json
$EDITOR "$(devc-tui config path)"   # set "root" (and "skillsRoot", if you want skills)
```

Or compile a standalone binary: `cd devc-tui && deno task build` → `./devc-tui`.

**It runs on the host, not inside the container.** Mount `source` paths, workspace folder
paths and the scanned root are all host-side, so invoke devc-tui from the same shell where you
`source scripts/bash_aliases.sh`. `containerRoot` and `skillsContainerRoot` are strings it
writes into mount targets, not paths it resolves — they are the only container-side values it
deals in.

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
why **selecting a worktree automatically mounts its primary repo**, shown as `[~]` on the
primary's own row and left out of the workspace folder list. The two stay where they are in
the tree; the `[~]` is the only thing that links them on screen.

`devc-tui list --json` reports `relativeGitdir` per worktree, so you can spot the ones that
still need `worktree repair`.

## Layout it expects

```
<root>/projecta/.git                     → projecta
<root>/projecta.worktrees/                → projecta.worktrees               (folder, beside projecta)
<root>/projecta.worktrees/some-feature   → projecta.worktrees/some-feature
<root>/projectb/.git                     → projectb
<root>/projectb.worktrees/some-other     → projectb.worktrees/some-other
<root>/org/tools/.git                    → org/tools                        (under folder "org")
<root>/noise/                            → pruned: nothing selectable beneath it
```

- A directory containing `.git` (file or dir) is a **project**; devc-tui does not descend
  into it, so a project is always a leaf.
- `<base>.worktrees/` is a **worktree folder** whose immediate subdirectories are worktrees.
  It is drawn beside `<base>`, not inside it — the tree matches the filesystem. What binds the
  two is the mount, not the layout: selecting a worktree mounts `<base>` as well.
- Anything else is a plain **folder** — not selectable itself, and pruned when nothing
  selectable is beneath it.
- A `<base>.worktrees` with no sibling `<base>` is still shown, marked
  `! primary repo not found`, and its worktrees are not selectable: without the primary's
  mount, git inside them would not work.
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
devc-tui                             open the interactive tree (see above)
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
worktree needs it, and blank for nodes you cannot select (plain folders, the current
workspace, an orphaned worktree). `list` shows the whole tree — it has no folds.

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
deno task test    # unit, CLI and TUI tests (no terminal, no host needed)
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
| `tui/state.ts` | `UiState`, `visibleRows`, `reduce` — the whole UI as a pure state machine |
| `tui/render.ts` | `render(state, size)` → exactly `size.rows` lines |
| `tui/keys.ts` | bytes → keys, buffering across reads |
| `tui/term.ts` | raw mode, alternate screen, size, paint, guaranteed restore |
| `tui/app.ts` | `runApp(deps)`: injectable IO, the input loop, and the three effects |

The UI splits into a pure core (`state.ts`, `render.ts`, `keys.ts`) and a thin shell
(`term.ts`, `app.ts`), so navigation, toggling, filtering and layout are all covered by
`deno test` — `tests/tui_app_test.ts` even scripts a whole session and asserts the files come
out byte-identical to the equivalent `devc-tui select`. Only the visual polish needs a human.
