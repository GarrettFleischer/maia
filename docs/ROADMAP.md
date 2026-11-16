# Maia roadmap (short)

1. **Auto-activated skills** — see `docs/design/16-auto-skills.md`. Next feature after the Run 69 memory/cache audit.
2. **Reconsider Honcho slices 5–10** — in light of prompt-driven `remember` / `update_memory` / `retire_memory` and the cache-stable manager prefix. Prefer deleting unused extraction/digest paths over adding parallel memory systems unless live metrics show a gap.
3. Leave known pre-existing test/clippy failures alone (sidebar 7 vs 6; three workspace contract tests; flaky model-list auth; workspace clippy `-D`).
