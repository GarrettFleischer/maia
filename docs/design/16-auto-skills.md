# Auto-activated skills (design only)

**Status:** next feature after the Run 69 memory/cache audit. Do not build yet.

## Goal

Attach small, reusable skill packs to a turn without the owner asking and without stuffing the whole library into every prompt. Skills hold procedures and project coding rules that today crowd chat or get re-discovered each hire.

## Storage

- One skill = markdown body + front matter (`id`, `title`, `triggers[]`, `project?`, `max_tokens`, `updated_at`).
- Store beside the brain (SQLite row + optional file mirror under `data/skills/`), not in the durable thread-cache prefix.
- Agents may create/update skills via tools later (`save_skill` / `revise_skill`); owner can edit/retire in Settings.

## Matching

- Prompt-first: the manager sees a **short catalog** (id + one-line purpose, ~20 tokens each, hard cap ~300 tokens).
- The model calls `activate_skill(id)` when a task matches; host injects the skill body into the **trailing** non-cached block (same place as recall), never into the stable system prefix.
- Optional cheap keyword prefilter can hide obviously irrelevant ids from the catalog; no hard-coded recovery state machine.

## Keeping them small

- Soft cap ~400 tokens per skill; refuse activate when over budget; prefer linking out (“see skill X”) over nesting.
- At most 1–2 skills active per turn; packer drops oldest if the trailing budget is tight.
- Project coding rules and “what we tried / failed” procedures live here when they outgrow a single brain claim.

## Agents creating/updating

- After a successful novel procedure, the worker or manager may `save_skill` with a tight summary (mirrors prompt-driven `remember`).
- Updates replace body; old version retained for dream/audit later.
- Never put secrets into skills.

## Fit with memory

- Brain claims = facts. Skills = how-to. Session summary = rolling narrative.
- Auto-skills come after prompt-driven memory is stable; Honcho-style digests (slices 5–10) should be reconsidered only if skills + remember leave a gap.
