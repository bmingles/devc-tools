# Agent skills

Agent skills devc-tools ships for use in **other** projects' containers. Each
`skills/<name>/` is one skill: a folder with a `SKILL.md` at its root, copied or
mounted as a unit.

This is not where skills for working on devc-tools itself go — those would live
in `.claude/skills/`. Keep the two apart: `/home/vscode/.claude/skills` is also
the in-container path devc mounts picked skills onto
(`SKILLS_CONTAINER_ROOT` in [`devc-core/mounts.ts`](../devc-core/mounts.ts)).

## Skills

| Skill                                           | What it does                                                                                                                                    |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| [dex-orchestrating](dex-orchestrating/SKILL.md) | Writes implementation plans as [dex](https://github.com/dcramer/dex) tasks and orchestrates their execution. Needs the `dex` CLI (`@zeeg/dex`). |

## Using them with devc

Add this folder as a skills root in devc's global config (`devc config
--global`). Its skills then appear in the per-project skills picker, and each
one picked is bind-mounted to `/home/vscode/.claude/skills/<name>`.
