---
name: dex-orchestrating
description: Authors implementation plans as dex tasks (contracts, touchpoints, concept boundaries) and orchestrates their execution — single plan directly, multiple plans via sequential subagent delegation with commit-on-success/stop-on-failure — using the dex CLI as the task-tracking surface. Use when a user asks to "create a plan", "write a plan", "run plans", "implement plans", "execute pending plans", or "orchestrate plan execution" in a project that tracks work with dex.
---

Plans are tracked as **dex tasks**. dex owns status, ordering, and completion
records; this skill owns how a plan is written and how its execution is
orchestrated. For dex CLI details beyond what is used here, defer to dex's own
`dex` skill or `dex --help`.

## Command Invocation

Use `dex` directly. If it is not on PATH, use `npx @zeeg/dex` instead. Check
once at the start:

```bash
command -v dex &>/dev/null && echo "use: dex" || echo "use: npx @zeeg/dex"
```

Tasks are stored in `.dex/` at the git root. Commit `.dex/` along with the work
it tracks — do not add it to `.gitignore`.

## Coexisting with a Markdown Plan Index

If the project also has a markdown plan index (`.plans/plan.md`, `PLAN.md`) or
`pending/` / `implemented/` folders, this skill **replaces** their bookkeeping:
do not move plan files, edit index tables, or tick markdown checklists for work
tracked in dex. Long-form design documents (research, decisions, rationale)
stay as markdown — reference them from tasks by **file path**.

## Mapping Plans onto dex

| Plan concept                | dex                                                      |
| --------------------------- | -------------------------------------------------------- |
| Group of related plans      | Epic (L0)                                                |
| One plan                    | Task (L1), or a root task if it stands alone             |
| Checklist item              | Subtask (`--parent <plan-id>`)                           |
| "Do A before B"             | Blocker (`--blocked-by <id>` / `--add-blocker <id>`)     |
| Ready to Implement          | Unblocked — `dex list --ready`                           |
| Not Ready (spec incomplete) | Blocked by a `Spec: <plan name>` task (see below)        |
| Completed row               | `dex complete` with a result                             |

dex's "ready" means **unblocked**, not "fully specified". To keep
`dex list --ready` meaning "implementable now", a plan whose spec is not yet
complete is blocked by a `Spec: <plan name>` task. Completing that task — with
the contract questions below answered in the plan task's description — is what
makes the plan ready.

## Writing Plans

Plans describe **what** needs to exist at boundaries, not **how** to build it. A
task agent reads the plan alongside the codebase and uses its own judgment on
implementation. A plan is ready when its task description answers:

- **Existing touchpoints** — which files (with paths) are modified or extended,
  and what role each plays.
- **Contracts** — the precise interface at every boundary the task crosses:
  function signatures, HTTP endpoint shapes, message/event names and payloads,
  file formats. Be exact; a cold agent cannot guess a name or shape.
- **Concept boundaries** — names or patterns in the codebase that could be
  confused with new ones introduced by this plan. Call these out explicitly.
- **.gitignore** — if the plan produces build artifacts, generated files, or
  local data, note what should be added to `.gitignore`.
- **Done when** — the validation that proves the plan is complete: commands to
  run, behavior to observe.

Avoid over-specifying internal details — variable names, loop structure,
algorithmic approach — unless a specific approach is required by a constraint
the agent wouldn't otherwise know about. If two valid implementations satisfy
the contracts, either is acceptable.

Write the description as markdown with those headings:

```bash
dex create "Add X" --description "$(cat <<'EOF'
## Goal
...

## Existing touchpoints
- `path/to/file.ts` — ...

## Contracts
...

## Concept boundaries
...

## Done when
- ...
EOF
)"
```

Then add one subtask per checklist item (`dex create --parent <id> ...`), each
with enough context to be completed and verified on its own. Aim for 3–7
subtasks; a plan that needs more is usually two plans.

**dex task IDs are ephemeral.** Never put them in commits, PRs, code comments,
or markdown docs. Reference durable things instead: file paths, plan names,
commit SHAs.

## Orchestrating Implementation

Run `dex list --ready` to see implementable plans. The user's prompt will
specify which plans to orchestrate.

If `DEX_NTFY_TOPIC` is set, send a terse notification when starting and
completing each plan:

```bash
[ -n "$DEX_NTFY_TOPIC" ] && curl -s -d "Started: <plan name>" "ntfy.sh/$DEX_NTFY_TOPIC"
```

Skip notifications silently when it is unset.

### Per-Plan Instructions

For each plan:

1. Gather context: `dex show <id> --full`, plus the parent and any completed
   blockers, plus any design document the description references.
2. Implement the plan subtask by subtask. Complete each subtask with
   `dex complete <subtask-id> --result "..."` **as soon as it is implemented and
   verified** — do not batch completions at the end. Each result must carry
   evidence: test counts, build status, what was manually checked.
3. If successful, commit the implementation, including `.dex/`.
4. Complete the plan task with `--commit <sha>`, a result summarizing what was
   built, decisions made, and deviations from the plan.
5. Report whether the implementation succeeded, and if not, what the error was.

**Verification that cannot run here** (needs Docker, specific hardware, a
human) is not a reason to leave the plan open or to mark it verified. Create a
separate task, `Verify: <what>`, whose description lists the exact steps, and
say in the plan's result that it is outstanding. The plan completes; the
verification stays visible in `dex list`.

### Single Plan vs. Multiple Plans

**Single plan** — implement it directly yourself. Do not delegate to a
subagent.

**Multiple plans** — delegate each plan to a new foreground subagent in
sequence. Instruct each subagent to follow the Per-Plan Instructions above.
Wait for each subagent to complete before starting the next, and re-run
`dex list --ready` between plans — a completed plan may unblock the next. If
any subagent fails, stop immediately and report the failure.
