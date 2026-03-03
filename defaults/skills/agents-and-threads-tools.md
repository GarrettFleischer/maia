---
name: agents-and-threads-tools
description: Use agent_create, agent_delete, agent_list, agent_get, thread_list, thread_create, thread_update, thread_delete, thread_get_active, and thread_set_active (Maia-only) to manage sub-agents and conversation threads.
---

# Agents and threads tools (Maia-only)

As Maia, you can orchestrate other agents and manage conversation threads using:

- `agent_create` — Create a new sub-agent with a given name and model.
- `agent_delete` — Soft-delete an agent (mark as deleted).
- `agent_list` — List existing agents.
- `agent_get` — Get an agent’s definition and identity files.
- `thread_list` — List threads (conversation groupings).
- `thread_create` — Create a new thread.
- `thread_update` — Update thread metadata (for example, title).
- `thread_delete` — Delete a thread.
- `thread_get_active` — Get the active thread for a context.
- `thread_set_active` — Change which thread is active.

These tools are **Maia-only**; sub-agents should not call them.

## Managing agents

- Use `agent_list` first to:
  - See which agents already exist and avoid unnecessary duplicates.
- Use `agent_create` when:
  - The user needs a specialized helper (for example, a reviewer, a planner, or a domain-specific expert).
  - You have a clear idea of the agent’s role and preferred model.
- After creating an agent:
  - Consider updating its identity files (SOUL, MEMORY, USER, AGENTS) via the appropriate tools so it is aligned with its role.
- Use `agent_get` when:
  - You need to inspect an agent’s configuration before modifying it or sending it work.
- Use `agent_delete` cautiously:
  - Only when an agent is no longer needed.
  - Communicate clearly to the user which agent id is being deleted.

## Managing threads

- Use `thread_list` to:
  - Discover existing threads and their metadata.
- Use `thread_create` when:
  - You want to start a new logical conversation or project context.
- Use `thread_set_active` to:
  - Switch the active thread for a given participant or context, so subsequent messages and history are associated with the right thread.
- Use `thread_update` to:
  - Rename or annotate threads for clarity.
- Use `thread_delete` sparingly:
  - Only when you are sure the thread is no longer needed or has been archived elsewhere.

When orchestrating agents and threads, always keep the user’s intent and security rules in mind, and avoid opaque changes that the user would not expect.

