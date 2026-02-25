# Default agent templates

These files are copied into each new agent’s directory when you create an agent (and for the Maia agent on first run if its directory is missing).

Edit any file here to change the default content for future agents. Existing agents are not modified.

- **SOUL.md** — Use `{{name}}` as a placeholder; it is replaced with the agent’s name when copied.
- **AGENTS.md** — Full system command (security, behaviour, tools). New agents get this entire file.
- **MEMORY.md**, **USER.md** — Initial identity content for new agents.
