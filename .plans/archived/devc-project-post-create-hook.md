# devc — restore the project post-create hook as `devc-post-create.sh`

## Goal

Give a project a create-time extension point again, under the name
`devc-post-create.sh` (the standard `post-create.sh` with a `devc-` prefix).
`post-create.sh` runs it last, after the baseline steps, discovering it at
`.devc/devc-post-create.sh` then `.devcontainer/devc-post-create.sh` —
first-hit-wins, the same order and both-locations-are-first-class rule the
`devc.json` overlay already uses (`overlay.ts` `PROJECT_CANDIDATES`).

### Why this is needed

The hook was removed in `6418d63` (`devc-container-feature`) on the rationale
that repackaging the baseline as a Feature left the top-level
`postCreateCommand` free for projects to use. `devc-drop-feature` then reverted
the Feature and gave that slot back to devc's own baseline, which invalidated
the rationale. Its replacement — a `post-create.user.sh` hook — was dropped
before it shipped (`PLAN.md:139`), so **no create-time extension point exists
today**.

This bites hardest in **zero-config** mode, which is the case that has no
recourse at all: there is no project `.devcontainer/` to own, and
`post-create.sh` is image-baked at `/usr/local/share/devc/`. The
`devc.json` overlay covers mounts/features/env for a zero-config project but
cannot express a command — only three keys have a `devcontainer up` flag
(`devc/README.md:177`), and there is no `--post-create-command`. Adding one to
the overlay would force devc to rewrite the project's `devcontainer.json`,
breaking the overlay's governing invariant (`overlay.ts:4-8`). A script the
baseline _calls_ is the only mechanism that stays inside that invariant, and it
composes additively by construction — there is no "does this override
`devcontainer.json`'s `postCreateCommand`?" ambiguity, because it is not a
`postCreateCommand`.

This repo is the first consumer: `devc-bridge`'s container client is installed
at create time and has been silently missing since the hook was removed.

## Decisions

1. **Name** — `devc-post-create.sh`. The pre-removal name was
   `devc-postcreate.sh`; **no back-compat shim.** It never shipped outside this
   repo, and a silently-still-working old name is worse than a loud absence.
2. **A step script, not inline** — `scripts/project-hook.sh`, invoked as the
   last line of `post-create.sh`. Matches that file's stated contract ("This
   file only orchestrates; each step is its own script under `scripts/`").
3. **`cd` into the project first.** Pre-removal, the hook ran with cwd =
   `$PROJECT_PATH` because an earlier `cd` in the _same_ process had put it
   there. Steps are now separate `bash` invocations, so that cwd no longer
   carries over — `project-hook.sh` must `cd` itself to preserve the old
   behavior.
4. **`${PROJECT_PATH:-$PWD}`, not bare `$PROJECT_PATH`.** The old hook block
   used it bare while every other consumer used the fallback; with `PROJECT_PATH`
   unset the paths collapse to `/.devc/...`. Normalize on the fallback.
5. **A non-executable hook is a hard error.** Pre-removal behavior was a silent
   skip under `-x`. Instead, **existence** selects the hook and **executability**
   is then required: the first candidate that exists wins, and if it is not
   executable the step exits nonzero, failing container create. It does **not**
   fall through to the next location — a present-but-unrunnable hook is a
   mistake to surface, not a reason to silently run a different file. This is a
   deliberate deviation from pre-removal behavior: a hook that exists but never
   runs is exactly the failure this plan exists to fix.
6. **A failing hook fails create.** `set -e` is in effect and the hook is
   invoked directly, so a nonzero exit propagates — unchanged from pre-removal.
7. **Fence markers** `# devc:project-hook (start)` / `(end)` around the
   discovery block, so `tests/project_hook_test.sh` extracts the real
   implementation rather than a copy (the `seed_link_test.sh` convention).

## Implementation

### `devc/default/scripts/project-hook.sh` (new)

**The fence encloses the whole script body** — `set -e` and the `cd` included.
Both were originally outside it, and the test caught why that is wrong: the
extracted block ran without `set -e`, so a failing hook did not fail the block
(case 7), and without the `cd`, cwd could not be asserted (case 8). A fence that
omits the shell options is a fence that lets the implementation drift from the
test in exactly the way the fence exists to prevent.

```bash
#!/bin/bash
# Project extension point: run the project's own create-time script, if it has one.
# devc owns this file; it never touches the project's hook. Both locations are
# first-class and first-hit-wins, matching the devc.json overlay's search order.

# devc:project-hook (start)
set -e
PROJECT_ROOT="${PROJECT_PATH:-$PWD}"
# Each step of post-create.sh is its own `bash` invocation, so the project cwd is
# not inherited from the orchestrator — establish it here, for the hook's benefit.
cd "$PROJECT_ROOT"
for candidate in \
  "$PROJECT_ROOT/.devc/devc-post-create.sh" \
  "$PROJECT_ROOT/.devcontainer/devc-post-create.sh"; do
  # `-e` is false for a dangling symlink, so `-L` catches that case too and lets it
  # fall into the not-executable error rather than being skipped as absent.
  [ -e "$candidate" ] || [ -L "$candidate" ] || continue
  if [ ! -x "$candidate" ]; then
    echo "devc: $candidate is not executable — chmod +x it, or remove it" >&2
    exit 1
  fi
  echo "devc: running $candidate"
  "$candidate"
  break
done
# devc:project-hook (end)
```

Existence selects, executability is enforced: the loop `continue`s only past a
candidate that is genuinely absent. Once a candidate exists, it either runs or
the step fails — there is no path on which a present hook is skipped.

### `devc/default/post-create.sh`

Append as the final step, after `git-setup.sh`:

```bash
bash "$scripts/project-hook.sh"   # project's own .devc/devc-post-create.sh, if present
```

### `devc/tests/project_hook_test.sh` (new)

Follow `seed_link_test.sh`: take the script path as `$1`, `awk` the block out
between the fences, run it against temp dirs with `PROJECT_ROOT` re-pointed via
`sed`, and `check` each assertion. Cases:

- `.devc/` hook, executable → runs (marker file created)
- `.devcontainer/` hook, executable, no `.devc/` → runs
- both present and executable → **only** `.devc/` runs
- `.devc/` present but not executable, `.devcontainer/` executable → block exits
  nonzero, names the offending path, and `.devcontainer/`'s hook does **not**
  run (no fall-through)
- `.devc/` a dangling symlink → same nonzero failure, not treated as absent
- neither present → no-op, exit 0
- hook itself exits 1 → block exits nonzero
- the hook runs with cwd = project root (assert via a hook that writes
  `$PWD` to a marker)

## Checklist

- [x] `devc/default/scripts/project-hook.sh` created with the fenced discovery
      block, mode 0755 to match its invoked siblings
- [x] `devc/default/post-create.sh` invokes it as the last step
- [x] `devc/tests/project_hook_test.sh` created, covering the eight cases above
- [x] `devc/tests/default_config_test.ts` — add `scripts/project-hook.sh` to the
      two expected-file lists (zero-config materialize ~line 280, canonical
      default ~line 359). `scripts/git-setup.sh` was missing from both lists as
      well and was added alongside — an incomplete expected-file list is what
      lets a missing script go unnoticed.
- [x] `devc/README.md` — document the hook: both locations, first-hit-wins, that
      it runs last, that it runs with cwd = project root (so relative paths
      work), that a nonzero exit fails create, and that a present-but-
      non-executable hook is a hard error rather than a skip. Correct the "A
      project needing `containerEnv`… should run `devc init`" bullet to point at
      this hook for create-time commands.
- [x] `.devc/devc-postcreate.sh` renamed to `.devc/devc-post-create.sh` (done by
      the user; exec bit intact, content unchanged)
- [x] `devc-bridge/README.md` — update the container-wiring paragraph (~line
      126) and the `Layout` table's `../.devc/` row to the new hook name; drop
      the `containerEnv` claim, since the client's defaults already match and
      the overlay has no such key. Also notes that `.devc/` is gitignored here,
      so a fresh clone has no bridge wiring.

## Validation

- [x] `cd devc && deno task check` passes
- [x] `cd devc && deno task test` passes — 266 passed, 1 failed, the failure being
      the **pre-existing** `jsonc_edit_test.ts:111` (`UnterminatedFenceError` on a
      `devc:projects` fence) already recorded in `PLAN.md` under
      `devc-mounts-to-overlay`. `jsonc_edit.ts` and its test are untouched by this
      work. `tests/default_config_test.ts` alone: 40 passed, 0 failed.
- [x] `bash devc/tests/project_hook_test.sh devc/default/scripts/project-hook.sh`
      reports all cases ok, exit 0
- [x] `bash devc/tests/seed_link_test.sh devc/default/scripts/agents-setup.sh`
      still passes (untouched, guards against collateral damage). `shell_dirs_test.sh`
      also re-run: ALL PASS.
- [x] `deno fmt --check` clean at repo root (97 files)
- [x] `grep -rn 'devc-postcreate' devc/ devc-bridge/ .devc/` returns nothing
      (old name fully retired)
- [x] `grep -c 'project-hook' devc/default/post-create.sh` returns 1
- [x] End-to-end against this repo, without a rebuild:
      `PROJECT_PATH=/workspaces/devc-tools bash devc/default/scripts/project-hook.sh`
      printed `devc: running /workspaces/devc-tools/.devc/devc-post-create.sh`,
      built and installed the client, and `devc-bridge ping test` then returned
      `pong`. This proves discovery against the real repo layout **and** that the
      client reaches the host on its built-in defaults with no env vars — the
      `containerEnv` deletion is confirmed safe.
- [x] (user) `devc build` in this repo, then in the container:
      `command -v devc-bridge` resolves to `/usr/local/bin/devc-bridge` and
      `devc-bridge ping test` prints `pong` — the hook ran in **zero-config**
      mode with no project `.devcontainer/` present. **Verified on a real
      rebuild.** Timestamps establish the client was installed by the hook rather
      than left over from the direct run: baked `scripts/*` 16:38 (image build),
      PID 1 started 16:42:46 (fresh container), `/usr/local/bin/devc-bridge`
      16:42 — after container start, and in a container the 16:35 manual install
      did not survive. The image also carries the new code: `project-hook.sh` is
      baked into `/usr/local/share/devc/scripts/` and the baked `post-create.sh`
      ends with the new step line.
- [x] (user) `ls /workspaces/devc-tools/.devcontainer` still does not exist
      after that build (zero-config preserved). Verified on the same rebuild.

## Relevant Files

- `devc/default/scripts/project-hook.sh` — new: fenced discovery + invocation
- `devc/default/post-create.sh` — add the final step line
- `devc/tests/project_hook_test.sh` — new: shell-level behavior test
- `devc/tests/default_config_test.ts` — expected-file lists
- `devc/README.md` — document the hook; fix the "only three keys" follow-on
  advice
- `.devc/devc-post-create.sh` — this repo's own hook (already renamed).
  **`.devc/` is entirely gitignored here** (`.devc/.gitignore` is `*`), so
  nothing in it is tracked: the rename is a working-tree change only, no `git mv`
  applies, and none of this repo's bridge wiring is committed. That is the
  overlay's intended "gitignored, per-developer" shape (`overlay.ts:12-15`) — but
  it does mean a fresh clone gets no bridge client until the developer creates
  `.devc/` themselves, which `devc-bridge/README.md` should say plainly.
- `devc-bridge/README.md` — container-wiring paragraph + `Layout` table row
- `.plans/PLAN.md` — register this plan

No change needed to `devc/default/Dockerfile` (`COPY scripts/` is wholesale,
followed by `chmod -R 0755`) or to `installBundledAssets` in
`devc/default_config.ts` (it exec-bits every `scripts/*.sh` via `readDir`).
