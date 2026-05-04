---
name: agents-and-threads-tools
description: Use persona_list, persona_get, persona_run, persona_catalog_upsert, persona_override_write (Maia-only) plus thread_list, thread_create, thread_update, thread_delete, thread_get_active, and thread_set_active to orchestrate delegated personas and conversation threads.
---

# Personas and threads tools (Maia-only)

Maia orchestrates delegated personas (prompt templates stored as Codex-style `.toml` plus optional markdown overrides) and manages threads using:

## Persona orchestration

- `persona_list` — Enumerate persona ids bundled under `defaults/personas/catalog` plus anything registered in `data/personas/catalog`.
- `persona_get` — Inspect instructions/metadata before delegating.
- `persona_run` — Execute a delegated persona turn inside the **current** session with a whitelisted model.
- `persona_catalog_upsert` — Create/replace `data/personas/catalog/<slug>.toml` when you need a brand-new delegated persona entry.
- `persona_override_write` — Replace layered markdown at `data/personas/overrides/<slug>.md` without editing vendor defaults.

Maia’s own evolving CEO persona lives in **`data/agents/maia/PERSONA.md`** — edit via **`file_write`** (`PERSONA.md`) following security guidance.

## Thread helpers

- `thread_list` — Discover threads + metadata.
- `thread_create` — Start a new logical grouping when isolation helps.
- `thread_update` — Rename or annotate threads.
- `thread_delete` — Remove threads only when confident they are obsolete.
- `thread_get_active` / `thread_set_active` — Inspect or switch the active thread.

Keep persona/catalog edits deliberate and communicate impactful template changes to the user.
