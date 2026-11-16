# Auto-activated skills

**Status:** shipped (Run 71). Prompt-first catalog + `save_skill` / `load_skill`.

## Goal

Attach small, reusable skill packs to a turn without the owner asking and without stuffing the whole library into every prompt. Skills hold procedures and project coding rules that today crowd chat or get re-discovered each hire.

## Storage

- One skill = `skill_id`, `title`, `when_to_use`, `body`, optional `project`, `max_tokens`, `updated_at`, soft `retired`.
- SQLite `skills` table (migration 21). Agents create/update via `save_skill`; owner can view/delete under Brain → Skills.
- Soft body cap ~400 tokens (~1600 chars); refuse load when over budget.

## Matching

- Prompt-first: the manager/worker sees a **short catalog** in the **trailing** non-cached block (same place as recall), never in the byte-stable system prefix.
- Format: `## skills` + `` `id` — when to use `` lines (~20 tokens each, hard cap ~300 tokens / 1200 chars).
- The model calls `load_skill(skill_id)` when a task matches; host returns the body in the tool result (trailing context for that turn).
- No hard-coded recovery state machine or code-side keyword matcher.

## Catalog placement (chosen)

**Trailing append** via `recall_for` → `append_also_happening`, so `manager_system_prefix` stays byte-identical across consecutive builds. The catalog changes often and must not bust the cached prefix.

## Agents creating/updating

- After a successful novel procedure or project coding rule, call `save_skill` (title + when_to_use + body).
- Facts stay on `remember`; how-to / multi-step rules go to skills.
- Updates replace body (same `skill_id`); retire via owner delete or a later soft-delete path.
- Never put secrets into skills.

## Fit with memory

- Brain claims = facts. Skills = how-to. Session summary = rolling narrative.
- Honcho-style digests (slices 5–10) should be reconsidered only if skills + remember leave a gap.
