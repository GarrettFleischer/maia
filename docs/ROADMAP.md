# Maia roadmap (short)

1. **Autonomous manager quality** — Pass→Done close-out improved via wake-nudge keep/re-arm (run82: recover ~18s vs prior ~35s). Watch same-wake Done when evidence is already present; restore re-nudge after daemon restart.
2. **Token / cache hygiene** — first wake after process start often `cached=0`/`na` (cold provider cache); following wakes warm. Keep prefix/tools byte-stable.
3. Leave known pre-existing test/clippy failures alone (sidebar 7 vs 6; three workspace contract tests; flaky model-list auth; workspace clippy `-D`).
