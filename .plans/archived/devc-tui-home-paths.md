# devc-tui — home directory support

Two changes, in opposite directions, for two different readers:

1. **Config in, expanded by devc-tui.** `~/.config/devc-tui/config.json` may write `~`, `$HOME`
   or `${HOME}` in host-side path values; devc-tui expands them when it loads the file.
2. **devcontainer.json out, expanded by Dev Containers.** Mount `source=` paths under the
   user's home are written as `${localEnv:HOME}/...` instead of an absolute
   `/Users/<name>/...`, matching what this repo's own `.devc/devc.json` already does.

They deliberately use different syntaxes: `$HOME` is what devc-tui reads, `${localEnv:HOME}`
is what the Dev Containers extension resolves on the host. Neither tool understands the
other's form.

## Decisions

### Config expansion

- **Syntax:** a leading `~` or `~/` (only at the start, as in a shell), plus `$VAR` and
  `${VAR}` anywhere in the value. `VAR` matches `[A-Za-z_][A-Za-z0-9_]*`.
- **Which keys:** the host-side path keys only — `root`, `skillsRoot`, `devcontainerPath`,
  `workspaceFile`.
- **Not `containerRoot` or `skillsContainerRoot`.** Those are container-side, and the
  container's `$HOME` is not the host's — expanding them with the host environment would
  quietly produce a wrong target. They are written through literally, as today.
- **Unset is an error**, exit 2, naming the key, the variable and the config file:
  `devc-tui: config "root": $SRC is not set (~/.config/devc-tui/config.json)`
  A variable set to the empty string counts as unset, consistent with how `configPath`
  already treats `DEVC_TUI_CONFIG`.
- **`~` with no `HOME`** is the same error, reported as `$HOME`.
- No escape syntax. A literal `$` followed by a name is always a variable reference.
- `config show` prints the **expanded** values — it is documented as the resolved config, and
  it is how you check that an expansion did what you meant. Nothing writes the loaded config
  back to disk (`serializeConfig` only feeds stdout), so the raw file is never at risk.

### `${localEnv:HOME}` in mounts

- Applies to `source=` in **both** the `devc-tui:projects` and `devc-tui:skills` fences.
- A host path equal to `$HOME` becomes `${localEnv:HOME}`; one under `$HOME/` becomes
  `${localEnv:HOME}/<rest>`. Anything else is written absolute, exactly as today.
- When `HOME` is unset or empty, every path is written absolute — no failure.
- `target=` is untouched: it is a container path built from `containerRoot`.
- **The `.code-workspace` `folders` array is untouched.** VS Code does not expand
  `${localEnv:...}` in workspace folder paths, and those entries are relative to the workspace
  file anyway.
- Read-back is unaffected: the projects fence is read through `target=`, and the skills fence
  takes only `basename(source)`, which `${localEnv:HOME}/.claude/skills/alpha` still yields
  `alpha` for.
- Existing devcontainer files hold absolute sources; the next `apply` rewrites them. That is a
  one-time diff, and `--dry-run` shows it.

## Checklist

### config.ts

- [x] Add expansion: leading `~`, `$VAR`, `${VAR}`, over a single string.
- [x] `loadConfig` expands `root`, `skillsRoot`, `devcontainerPath` and `workspaceFile`, and
      leaves `containerRoot` and `skillsContainerRoot` alone.
- [x] An unset or empty variable raises `UsageError` with the message shape above.
- [x] `DEFAULT_CONFIG` is unchanged — empty strings expand to themselves.

### model.ts

- [x] A helper turning a host path into its mount `source=` form, substituting
      `${localEnv:HOME}` when the path is `$HOME` or under it.
- [x] `mountLines` and `skillMountLines` both write sources through it.
- [x] `Mount.source` keeps the real absolute host path — only the emitted line is substituted,
      so `list`/`status` and the warnings keep naming real paths.

### README.md

- [x] Config section: the accepted syntax, which keys expand, which deliberately do not, and
      the unset-variable error.
- [x] Fence section: mount sources use `${localEnv:HOME}` when under home; workspace folders
      do not and why.

## Validation

- [x] `cd devc-tui && deno task check` passes.
- [x] `cd devc-tui && deno task test` passes.
- [x] config: `"root": "~/src"` with `HOME=/home/x` loads as `/home/x/src`; so do `"$HOME/src"`
      and `"${HOME}/src"`.
- [x] config: `~` mid-value (`"/a/~/b"`) is left alone — only a leading `~` expands.
- [x] config: `"root": "$SRC/repos"` with `SRC` unset exits 2, and the message names both
      `"root"` and `$SRC`.
- [x] config: `SRC` set to `""` is treated as unset (same exit 2).
- [x] config: `"containerRoot": "$HOME/x"` is **not** expanded — it stays the literal
      `$HOME/x` in the mount target.
- [x] config: `"skillsRoot": "~/.claude/skills"` expands, and `skills list` finds the dirs
      under it.
- [x] model: with `HOME=<tmp>` and a project at `<tmp>/src/projecta`, the projects fence line
      is `"type=bind,source=${localEnv:HOME}/src/projecta,target=/workspaces/projecta"`.
- [x] model: a project outside `$HOME` keeps its absolute source.
- [x] model: with `HOME` unset, sources are absolute.
- [x] model: the skills fence gets the same substitution.
- [x] model: `readSkills` still recovers the skill name from a `${localEnv:HOME}` source.
- [x] `select` then `apply` is idempotent with substitution active — the second run reports no
      changes.
- [x] The `.code-workspace` `folders` entries contain no `${localEnv:` and stay relative.

## Relevant Files

| File | Change |
| --- | --- |
| `devc-tui/config.ts` | expansion helper, `loadConfig` wiring, unset-variable error |
| `devc-tui/model.ts` | mount `source=` substitution for both fences |
| `devc-tui/README.md` | config syntax, and which paths get `${localEnv:HOME}` |
| `devc-tui/tests/config_test.ts` *(new)* | expansion cases, unset-variable error, key selection |
| `devc-tui/tests/cli_test.ts` | *no change needed — covered by the new `config_test.ts`* |
| `devc-tui/tests/model_test.ts` | mount line substitution, skills round-trip |
| `.plans/PLAN.md` | register, then close out |

`devc-tui/scan.ts`, `devc-tui/skills.ts`, `devc-tui/jsonc_edit.ts` and `devc-tui/tui/*` are
untouched, as is every `target=` and the workspace `folders` array.
