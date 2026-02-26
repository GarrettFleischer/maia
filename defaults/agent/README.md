# Default agent templates (non-Maia)

These files are copied into each new agent's directory when you create an agent. They are also used when seeding the Maia agent on first run if her directory is missing (except AGENTS.md — see below).

Edit any file here to change the default content for future **non-Maia** agents. Existing agents are not modified.

- **SOUL.md** — Use `{{name}}` as a placeholder; it is replaced with the agent's name when copied.
- **AGENTS.md** — Full system command for **other agents** (security, behaviour, tools). No Maia-only privileges. New non-Maia agents get this file.
- **MEMORY.md**, **USER.md** — Initial identity content for new agents.

**Maia's AGENTS.md** lives in `defaults/maia/AGENTS.md`. It includes Creating agents, Tool review, and other Maia-only instructions. When Maia's directory is created on first run, she gets that file instead of this one.
