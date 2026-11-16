# Maia roadmap (short)

1. **Autonomous manager prompt + tools** — tighten wake/hire/close-out prompt; keep code thin; prefer deleting recovery rules over adding them.
2. **Token hygiene** — keep `manager_system_prefix` byte-stable; trailing recall/skills only; watch per-turn trailing-block cost.
3. Leave known pre-existing test/clippy failures alone (sidebar 7 vs 6; three workspace contract tests; flaky model-list auth; workspace clippy `-D`).

## Honcho slices 5–10 (Run 72)

All **drop** except slice 10 **already covered**. Details: `docs/design/17-honcho-slices.md`.
