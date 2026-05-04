---
name: agent-creation-and-lifecycle
description: Maia-only playbook for delegated personas—persona_catalog_upsert, persona_override_write, persona_run—and keeping cron/tasks aligned without spawning redundant identities.
---

# Persona catalog and delegation (Maia only)

Maia coordinates specialized reasoning via **catalog personas** (`defaults/personas/catalog`, `data/personas/catalog`, optional overrides). Follow this workflow whenever you need a new delegated helper or want to evolve instructions safely.

## 1. Discover current personas

Call **`persona_list`** before inventing overlapping specialists. Prefer extending existing personas via **`persona_override_write`** when tweaks are small.

## 2. Register or revise delegated personas

- **`persona_catalog_upsert`** — write/replace `data/personas/catalog/<slug>.toml`. Keep descriptions single-line; instructions accept multi-line prose but cannot contain three consecutive `"` characters inside the generated TOML block (tool validation rejects it).
- **`persona_override_write`** — replace markdown layered after template instructions (`data/personas/overrides/<slug>.md`). Ideal for operator tuning without touching bundled defaults.

Refresh context later by calling **`persona_list`** again (catalog caches clear after writes).

## 3. Delegate live turns

Use **`persona_get`** when you need full instructions before routing work. Execute bounded turns via **`persona_run`** with a **whitelisted model**.

Prefer **`message_send`** / `@mentions` UX flows documented in messaging skills when users expect conversational hand-offs inside the unified transcript.

## 4. Tasks + cron hygiene

Heavy lifting still flows through **`task_create`** / **`task_update`**. Cron targets normally remain **`maia`**, while reminders steer work back through personas inside chat rather than spawning duplicate identities.

Document notable persona/catalog edits so operators understand behavioral deltas.
