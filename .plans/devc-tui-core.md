# devc-tui core — scan, model, and fenced-region file surgery

## Context

New tool in this repo: `devc-tui/`, a Deno TUI that selectively bind-mounts sibling projects
(and agent skill folders) into the current devcontainer and mirrors the selection into the
VS Code workspace file.

**This repo is not the target.** devc-tui is a general-purpose tool run against *arbitrary*
repos: the user `cd`s into whatever project they want to configure and runs `devc-tui` there.
Nothing about devc-tools' own layout (`.devc/devc.json`, its `.code-workspace`) may be
assumed, hardcoded, or special-cased. Every test therefore builds its own throwaway workspace
dir under `Deno.makeTempDir()` — no test may read or write anything inside this repo.

**It runs on the host, not inside a container.** Mount `source` paths are host paths and the
configured root is a host directory, so devc-tui is invoked from the host shell (the same
place `scripts/bash_aliases.sh` is sourced). It never needs to see the container filesystem;
`containerRoot` and `skillsContainerRoot` are strings it writes, not paths it resolves.

This plan builds everything **except** the interactive terminal UI: config, the project scan,
the selection model, the JSONC fenced-block editor, and a headless CLI that drives it all.
Splitting it this way keeps the risky part — editing files the tool does *not* own — fully
testable with `deno test`, no terminal required. [devc-tui-ui](devc-tui-ui.md) adds the TUI
on top and introduces no new file-writing logic.

**Key constraint — relative worktrees.** Selected worktrees rely on Git ≥ 2.48
`worktree.useRelativePaths` (or `git worktree repair --relative-paths`), so a worktree's
`.git` file holds `gitdir: ../../projecta/.git/worktrees/feat`. Container mount targets must
therefore preserve each project's path *relative to the configured root*, so the offset
between a worktree and its primary repo is identical inside the container. That is why a
selected worktree force-includes its primary repo's mount, and why the mapping is
`target = containerRoot + "/" + relative(root, hostPath)` rather than a flat basename.

## Design

### Config — `~/.config/devc-tui/config.json`

Created with these defaults on first run (`devc-tui config init`, or implicitly by any
command when the file is absent). Unknown keys are preserved on rewrite.

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

- `root` — host dir scanned for projects. Empty ⇒ every command that needs it exits 2 with
  `devc-tui: config "root" is not set (edit ~/.config/devc-tui/config.json)`.
- `containerRoot` — container-side parent for mounted projects.
- `maxDepth` — how many levels below `root` to descend looking for projects.
- `skillsRoot` — host dir whose immediate subdirectories are individually mountable skills.
  Empty ⇒ the skills section is empty and `skills` subcommands exit 2 with a similar message.
- `workspaceFile` — path relative to the workspace dir. `null` ⇒ auto-detect (below).
- `DEVC_TUI_CONFIG` overrides the config file path (used by tests).

### Workspace dir and target files

The "workspace dir" is `Deno.cwd()` — the arbitrary repo being configured — overridable with
`--workspace-dir <path>`. It is **independent of `root`**: it may sit inside the configured
root, elsewhere on disk, or be the root itself. All three must work.

- devcontainer file: `<workspaceDir>/<devcontainerPath>`.
- workspace file: `config.workspaceFile` if set; else the single `*.code-workspace` in
  `<workspaceDir>`; else `<workspaceDir>/<basename(workspaceDir)>.code-workspace`. If more
  than one `*.code-workspace` exists and `workspaceFile` is unset, exit 2 listing them.

### Scan — `root` → project tree

Walk `root` breadth-first to `maxDepth` levels.

- A directory containing `.git` (file **or** dir) is a **project**; do not descend into it.
- A directory named `<base>.worktrees` is a **worktree group** bound to the sibling project
  `<base>` at the same level. Each immediate subdirectory of it is a **worktree** node,
  displayed as a child of `<base>`. Do not descend further.
- Any other directory is a **group** node (not selectable); prune it if no project or
  worktree exists anywhere beneath it.
- A `<base>.worktrees` dir with no sibling `<base>` project yields its worktrees under a
  group node labelled `<base> (missing primary)`; those worktrees are **not selectable** and
  carry the warning `primary repo not found`.
- Skip dot-directories other than the `.git` check, and skip symlinks that escape `root`.
- Each worktree node records `relativeGitdir: boolean` — read its `.git` file, `true` when
  the `gitdir:` value does not start with `/`. Missing/unreadable ⇒ `false`.

Every project/worktree node has a stable **id**: its path relative to `root`
(POSIX separators, no leading `./`). Ids are what the CLI accepts and what selection state
round-trips through.

### Derivation — selection → mounts and folders

Given the explicit selection set `S` (ids):

- **Workspace folders** = `S`, in scan order. The current workspace dir is never emitted
  (it is already the workspace root) — if it falls inside `root` its node is flagged
  `isWorkspace` and is not selectable. If the workspace dir is outside `root`, no node is
  flagged and every project is selectable.
- **Self-mount collision.** The devcontainer already mounts the workspace dir itself, by
  convention at `/workspaces/<basename(workspaceDir)>`. Any derived target equal to that path
  — reachable when the workspace dir is *outside* `root` but some scanned project shares its
  basename — is skipped with the warning
  `target <path> collides with the workspace mount; set "containerRoot" to something other than /workspaces`.
  Two scanned projects can never collide with each other, since ids are unique paths.
- **Project mounts** = `S` ∪ `{ primary(w) | w ∈ S, w is a worktree }`. A primary pulled in
  only by the closure is flagged **auto** — it is mounted but not added to the workspace
  folders.
- **Target path** for id `i` is `join(containerRoot, i)`.
- **Mount string**: `type=bind,source=<hostAbsolutePath>,target=<containerAbsolutePath>`
- **Skill mount string**:
  `type=bind,source=<skillsRoot>/<name>,target=<skillsContainerRoot>/<name>`
- **Workspace folder object**: `{ "path": "<containerAbsolutePath>", "name": "<id>" }`
- Any id whose host path contains `,` or `=` is skipped with the warning
  `path contains a comma or equals sign; cannot be expressed as a mount string`.

Emission order is scan order for both arrays, so repeated `apply` runs are byte-identical.

### Fenced managed blocks

devc-tui owns exactly three blocks, each delimited by comment fences and nothing else in the
file. Written form:

```
// >>> devc-tui:<id> (managed - do not edit)
<entries, one per line>
// <<< devc-tui:<id>
```

| Fence id | File | Array |
| --- | --- | --- |
| `devc-tui:projects` | devcontainer file | `mounts` |
| `devc-tui:skills` | devcontainer file | `mounts` |
| `devc-tui:folders` | workspace file | `folders` |

Detection is by regex so trailing text may drift without breaking round-trips:
open `/^[ \t]*\/\/[ \t]*>>>[ \t]*devc-tui:<id>\b/m`, close
`/^[ \t]*\/\/[ \t]*<<<[ \t]*devc-tui:<id>[ \t]*$/m`. An open fence with no matching close
after it (within the array) is an error — exit 1, write nothing:
`devc-tui: unterminated devc-tui:<id> fence in <file>`.

Block placement when absent: appended just inside the array's `]`, in the order
projects-then-skills. When present, it is rewritten **in place** — a fence a user moved
elsewhere in the array stays where they put it.

Indentation of emitted lines: copied from the first existing element in the array; else the
array key's own indentation + 2 spaces; else 4 spaces.

### JSONC editing — `jsonc_edit.ts`

devcontainer.json and `.code-workspace` are JSONC and contain user content that must survive
byte-for-byte. Editing is text surgery, never parse-and-reserialize. A small scanner that
tracks string literals (with escapes), `//` and `/* */` comments, and bracket depth provides:

- `findArraySpan(src, key)` → `{ open, close } | null` — offsets of the `[` and `]` for a
  **top-level** key in the root object.
- `splitElements(src, span)` → `Array<{ start, end }>` — depth-1 element spans inside the
  array, excluding separating commas and all trivia (whitespace and comments).
- `spliceBlock(src, span, fenceId, lines, indent)` → new source — replaces the fenced range
  (or inserts before `]`), leaving everything else untouched.
- `normalizeArrayCommas(src, span)` → new source — recomputes element spans, then applies
  edits **right-to-left by offset**: insert `,` immediately after any element not followed by
  one before the next element; delete any comma that follows the final element. Comments and
  whitespace are never moved, only commas are inserted/removed.
- `ensureArray(src, key, indent)` → new source — when the key is absent, insert
  `"<key>": [\n<indent>]` immediately after the root object's opening `{`, with a trailing
  comma if the object already had members.

Every write is `spliceBlock` then `normalizeArrayCommas`, so comma placement is always valid
**strict** JSON regardless of whether the fence lands first, last, or in the middle, and
regardless of whether user elements span multiple lines.

Gotcha: JSONC permits trailing commas but strict `JSON.parse` does not. `normalizeArrayCommas`
always removes the trailing comma so the output stays parseable by both. Validation asserts
this by stripping comments and running `JSON.parse`.

### Reading current state back

There is no selection state file — state is derived from the files, so the tool and the repo
can never drift.

- Explicit selection = the `devc-tui:folders` block's `path` values, mapped back to ids via
  `containerRoot`. Entries that map to no scanned node are dropped with a warning.
- If the workspace file or its fence is absent but the devcontainer `devc-tui:projects` fence
  is present, fall back to treating every project entry there as explicit.
- Skills selection = the `devc-tui:skills` block's `source` basenames.

### CLI contract — `devc-tui <subcommand>`

Global flags (accepted by every subcommand): `--workspace-dir <path>`, `--root <path>`,
`--config <path>`, `--dry-run`, `--json`, `--no-color`.

| Command | Behavior |
| --- | --- |
| `list` | Print the scanned tree with `[x]`/`[ ]`/`[~]` (auto) markers and per-node warnings. |
| `status` | Print resolved config, both target file paths, whether each exists, and the entry count of each of the three fences. |
| `select <id>...` | Add ids to the selection, then apply. |
| `deselect <id>...` | Remove ids from the selection, then apply. |
| `apply` | Rewrite all three fences from the current derived selection. Idempotent. |
| `skills list` | Print skill dirs with `[x]`/`[ ]`. |
| `skills enable <name>...` / `skills disable <name>...` | Toggle, then apply. |
| `config show` / `config path` / `config init` | Print the resolved config as JSON / print the file path / create the file with defaults if absent. |
| (no args) | Print usage, exit 2. Replaced by the TUI in [devc-tui-ui](devc-tui-ui.md). |

- Unknown ids exit 2 with `devc-tui: unknown project id "<id>"` and write nothing.
- `--dry-run` prints a unified diff per changed file to stdout and writes nothing.
- `--json` makes `list`/`status`/`skills list` emit a JSON object instead of text; write
  commands emit `{"changed":["<path>",...]}`.
- The workspace file is auto-created when missing. A missing **devcontainer** file exits 1
  with `devc-tui: <path> does not exist (pass --create to create it)` unless `--create` is
  given; with `--create` it is written as:

```jsonc
{
  // Created by devc-tui. Set the image/build and everything else to taste;
  // devc-tui only ever rewrites the fenced blocks below.
  "name": "<basename(workspaceDir)>",
  "image": "mcr.microsoft.com/devcontainers/base:ubuntu",
  "mounts": [
    // >>> devc-tui:projects (managed - do not edit)
    // <<< devc-tui:projects
    // >>> devc-tui:skills (managed - do not edit)
    // <<< devc-tui:skills
  ]
}
```

New workspace file template (the `.` entry sits **outside** the fence, so devc-tui never
emits the current workspace as a folder):

```jsonc
{
  "folders": [
    { "path": "." }
    // >>> devc-tui:folders (managed - do not edit)
    // <<< devc-tui:folders
  ]
}
```

Exit codes: `0` success, `1` runtime error, `2` usage/config error.

## Checklist

- [ ] `devc-tui/deno.json` — `tasks`: `run` (`deno run --allow-read --allow-write --allow-env
      main.ts`), `check`, `test` (`deno test --allow-read --allow-write --allow-env`),
      `build` (`deno compile --output devc-tui … main.ts`); `imports` for
      `jsr:@std/path@^1` and `jsr:@std/assert@^1`, matching devc-bridge's import-map style.
- [ ] `devc-tui/config.ts` — `Config` interface, `loadConfig()` (defaults + `DEVC_TUI_CONFIG`
      + `--config`), `initConfig()` writing the default file, `resolveTargets()` returning the
      devcontainer + workspace file paths per the auto-detect rules.
- [ ] `devc-tui/scan.ts` — `scanRoot(root, maxDepth)` → tree of group/project/worktree nodes
      with stable ids, `isWorkspace` flag, `relativeGitdir` on worktrees, and per-node
      warnings (missing primary, comma in path).
- [ ] `devc-tui/model.ts` — `deriveMounts(tree, selection, cfg)` and
      `deriveFolders(tree, selection, cfg)`; worktree→primary closure with the `auto` flag;
      `readSelection(devcontainerSrc, workspaceSrc, tree, cfg)` implementing the
      read-back-from-fences rules.
- [ ] `devc-tui/jsonc_edit.ts` — the scanner plus `findArraySpan`, `splitElements`,
      `spliceBlock`, `normalizeArrayCommas`, `ensureArray`, and `parseFenceEntries` (returns
      the raw text of each element inside a fence).
- [ ] `devc-tui/devcontainer.ts` — read/create the devcontainer file; write the
      `devc-tui:projects` and `devc-tui:skills` fences into `mounts`.
- [ ] `devc-tui/workspace.ts` — read/create the workspace file; write the `devc-tui:folders`
      fence into `folders`.
- [ ] `devc-tui/skills.ts` — list immediate subdirectories of `skillsRoot`; enable/disable.
- [ ] `devc-tui/cli.ts` — subcommand implementations, text and `--json` output, `--dry-run`
      unified diff, exit-code discipline.
- [ ] `devc-tui/main.ts` — argv parsing, global flags, dispatch, usage text.
- [ ] `devc-tui/tests/` — `jsonc_edit_test.ts`, `scan_test.ts`, `model_test.ts`,
      `cli_test.ts`, plus `fixtures/` holding the hand-written JSONC cases below.
- [ ] `scripts/bash_aliases.sh` — export `DEVC_TUI_MAIN="$DEVC_TOOLS_ROOT/devc-tui/main.ts"`
      and add `devc-tui() { _devc_tools_run devc-tui "${DEVC_TUI_MAIN:-}" "$@"; }`, replacing
      the "Adding a tool" example comment at the bottom.
- [ ] `devc-tui/README.md` — what it does, config reference, the relative-worktrees
      prerequisite (`git config --global worktree.useRelativePaths true`, and
      `git worktree repair --relative-paths` for existing worktrees), fence contract, CLI
      reference, trust note that it edits files in the current workspace.
- [ ] `devc-tui/.gitignore` — `/devc-tui` (the compiled binary).
- [ ] Root `README.md` — add a `devc-tui/` row to the Tools table and to the Repo layout table.

## Validation

- [ ] `deno check devc-tui/*.ts` is clean (the repo-wide `no-import-prefix` lint note in
      devc-bridge is pre-existing style, not a failure).
- [ ] `deno task test` in `devc-tui/` — all green, covering at minimum:
  - [ ] **jsonc_edit, no-fence insert.** A `mounts` array with two existing multi-line object
        elements gains both fences at the end; the two originals are byte-identical; comment
        stripping + `JSON.parse` succeeds; `mounts.length === 2`.
  - [ ] **jsonc_edit, in-place rewrite.** A fence placed *between* two user elements is
        rewritten in place with new entries; commas around it are correct; user elements and
        their attached `//` comments survive byte-for-byte.
  - [ ] **jsonc_edit, empty fence.** Emptying a fence that was the last element removes the
        now-trailing comma from the preceding element; result is strict-JSON parseable.
  - [ ] **jsonc_edit, comma-hostile input.** Input with a pre-existing trailing comma, a
        `/* */` comment inside the array, and a string element containing `],` and `//`
        round-trips without corruption.
  - [ ] **jsonc_edit, missing array.** `ensureArray` on a root object with existing members
        inserts `"mounts": []` and a correct comma; on an empty `{}` it inserts without one.
  - [ ] **jsonc_edit, unterminated fence.** Open fence with no close → throws; caller writes
        nothing.
  - [ ] **scan.** A temp tree matching the prompt's example (`projecta/.git`,
        `projecta.worktrees/some-feature`, `projectb/.git`, `projectb.worktrees/some-other`,
        `projectb.worktrees/yet-another`, plus `org/tools/.git` at depth 2 and an empty
        `noise/` dir) yields exactly those ids, `noise/` pruned, worktrees nested under their
        primaries, and `org` a non-selectable group.
  - [ ] **scan, orphan worktrees.** `orphan.worktrees/x` with no `orphan/` yields a
        non-selectable node carrying the `primary repo not found` warning.
  - [ ] **scan, relativeGitdir.** A worktree whose `.git` reads `gitdir: ../../projecta/...`
        → `true`; one reading `gitdir: /abs/...` → `false`.
  - [ ] **model, closure.** Selecting only `projectb.worktrees/some-other` produces mounts for
        both it and `projectb` (the latter flagged `auto`) and workspace folders for only the
        worktree.
  - [ ] **model, targets.** With `containerRoot: "/workspaces"`, ids `projecta` and
        `projecta.worktrees/some-feature` map to `/workspaces/projecta` and
        `/workspaces/projecta.worktrees/some-feature` — i.e. `relative()` from the worktree
        target to the primary target is `../projecta`, matching the host, which is what keeps
        a relative `gitdir` resolvable.
  - [ ] **model, read-back.** `deriveFolders` output fed back through `readSelection`
        reproduces the original selection set exactly.
  - [ ] **model, workspace dir inside root.** With the workspace dir set to `<root>/projecta`,
        that node is flagged `isWorkspace`, is not selectable, and never appears in either
        derived list — while `projecta.worktrees/some-feature` remains selectable and still
        force-includes `projecta` as an `auto` **mount** (needed for its relative gitdir).
  - [ ] **model, workspace dir outside root.** With the workspace dir in an unrelated temp
        dir, no node is flagged and every project is selectable.
  - [ ] **model, self-mount collision.** Workspace dir named `projecta` but located outside
        `root`, with `containerRoot: "/workspaces"` and a scanned `projecta` — the scanned one
        is skipped with the collision warning and emitted in neither array; changing
        `containerRoot` to `/mnt/src` emits it normally.
- [ ] **CLI round-trip** against a temp workspace dir with a hand-written devcontainer.json
      that already has an unrelated mount, an unrelated top-level key, and comments:
  - [ ] `devc-tui select projectb.worktrees/some-other` → both files written; devcontainer
        `mounts` gains 2 entries inside `devc-tui:projects`; workspace `folders` gains 1.
  - [ ] Running the same `apply` again produces a **byte-identical** file (idempotence).
  - [ ] `devc-tui deselect projectb.worktrees/some-other` → both fences empty again and the
        file is byte-identical to the pre-`select` original.
  - [ ] `devc-tui list` marks `projectb` `[~]` while its worktree is selected.
  - [ ] `devc-tui skills enable <name>` adds exactly one entry to `devc-tui:skills` and leaves
        `devc-tui:projects` untouched.
  - [ ] `--dry-run` on a would-change command prints a diff and leaves both files unmodified.
  - [ ] Unknown id exits 2 and writes nothing; missing devcontainer file exits 1 without
        `--create` and is created with it.
  - [ ] Two `*.code-workspace` files in the workspace dir with `workspaceFile` unset exits 2.
- [ ] **Tests are self-contained.** Every test builds its root, workspace dir, and skills dir
      under `Deno.makeTempDir()` and removes them afterwards; `git status` in this repo is
      clean after `deno task test`.
- [ ] `source scripts/bash_aliases.sh && devc-tui status` runs from an arbitrary cwd and
      prints the resolved paths.
- [ ] (user, host) With a real root configured, `devc-tui select <a worktree>` then rebuilding
      the devcontainer: `git -C <mounted worktree> status` and a commit both work inside the
      container, confirming the relative-gitdir mapping.

## Relevant Files

- `devc-tui/deno.json` — new: tasks + imports
- `devc-tui/main.ts` — new: argv dispatch + usage
- `devc-tui/cli.ts` — new: subcommand implementations, output, diff
- `devc-tui/config.ts` — new: config load/init + target file resolution
- `devc-tui/scan.ts` — new: root → project/worktree tree
- `devc-tui/model.ts` — new: selection, closure, mount/folder derivation, read-back
- `devc-tui/jsonc_edit.ts` — new: JSONC scanner, fence splice, comma normalization
- `devc-tui/devcontainer.ts` — new: devcontainer file read/create/write
- `devc-tui/workspace.ts` — new: `.code-workspace` read/create/write
- `devc-tui/skills.ts` — new: skills discovery + toggle
- `devc-tui/tests/jsonc_edit_test.ts`, `tests/scan_test.ts`, `tests/model_test.ts`,
  `tests/cli_test.ts`, `tests/fixtures/*` — new
- `devc-tui/README.md` — new: tool docs
- `devc-tui/.gitignore` — new: ignore the compiled binary
- `scripts/bash_aliases.sh` — add the `devc-tui` shell function
- `README.md` — add devc-tui to the Tools and Repo layout tables
- `.plans/PLAN.md` — status index entry
