# Default templates for Maia

This directory holds the default **AGENTS.md** used when the Maia agent's directory is created on first run (e.g. by server init). It includes Maia-only instructions: Creating agents (and using `settings_list_whitelisted_models`), Tool review, and editing other agents' identity files.

- **AGENTS.md** — Full system command for Maia (security, behaviour, tools, and Maia-only sections). Only Maia gets this file when her directory is seeded.

SOUL.md, MEMORY.md, and USER.md for Maia are copied from `defaults/agent/` (same as other agents); only AGENTS.md is taken from here when the agent id is Maia.
