---
name: building-skills
description: Describes how to create and place new skills in this project—both global (all agents) and per-agent (local) skills.
---

# Building new skills

Use this skill when you need to create, edit, or place a new skill so agents can discover and use it. Skills are markdown files with YAML frontmatter and a body of instructions.

## Format

Each skill is a **single `.md` file** (no directory-per-skill). The file must have:

1. **YAML frontmatter** between `---` lines with:
   - `name` — short slug (e.g. `commit-style`, `my-workflow`)
   - `description` — one line describing what the skill does and when to use it (used for matching)

2. **Body** — markdown instructions for the agent. This is what gets injected into context when the skill is matched.

Example:

```markdown
---
name: my-skill
description: Use when the user wants X; do Y and Z.
---

# My skill

## Steps

1. First do this.
2. Then that.
```

## Where to put skills

- **Global skills** — `data/skills/`  
  Available to **all agents**. Use for cross-cutting workflows (e.g. commit style, fix workflow, shared conventions). Create or edit files under the `skills/` path (resolved to `data/skills/` in the data directory).

- **Per-agent (local) skills** — `data/agents/<agent_id>/skills/`  
  Available **only to that agent**. Use for agent-specific workflows (e.g. Maia-only agent creation). Create or edit files under the path for that agent’s skills directory.

Use the **file tools** (e.g. `file_write`, `file_read`) to create or edit skill files. Paths are relative to the project data directory or agent directory as appropriate.

## Discovery

Smart context and skill matching use `getAvailableSkillsMetadata(ctx, agentId)`: they only see **global skills** plus **that agent’s local skills**. So a skill in `data/agents/maia/skills/` is only offered when the current agent is Maia. Keep this in mind when choosing global vs local placement.

## Good practices

- Use a clear, unique `name` (slug) and a specific `description` so the matcher can select the skill when relevant.
- Keep the body focused: step-by-step instructions, examples, and when to use (or not use) the skill.
- Prefer global for workflows that any agent might need; use per-agent only when the workflow is specific to one agent.
