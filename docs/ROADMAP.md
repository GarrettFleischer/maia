# Maia roadmap (short)

1. **Autonomous manager quality** — recover→Done CEO chatter is already 0; close-out latency stays ~35s (wake scheduling, not chatter). Watch same-wake Done when evidence is already present.
2. **Token / cache hygiene** — first wake after process start often `cached=0`/`na` (cold provider cache); following wakes ~34–79%. Request shape is stable; no shape fix needed.
3. Leave known pre-existing test/clippy failures alone (sidebar 7 vs 6; three workspace contract tests; flaky model-list auth; workspace clippy `-D`).
