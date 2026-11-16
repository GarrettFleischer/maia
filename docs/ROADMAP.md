# Maia roadmap (short)

1. **Auto-activated skills** — see `docs/design/16-auto-skills.md`. Next after Run 70 (prompt-only memory; extraction switch removed).
2. **Reconsider Honcho slices 5–10** — in light of prompt-driven `remember` / `update_memory` / `retire_memory`, the cache-stable manager prefix, and the Run 70 live comparison (prompt ≥ extract on quality, cheaper). Prefer deleting unused digest paths unless live recall regresses.
3. Leave known pre-existing test/clippy failures alone (sidebar 7 vs 6; three workspace contract tests; flaky model-list auth; workspace clippy `-D`).
