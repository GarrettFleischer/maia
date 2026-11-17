# Maia roadmap (short)

1. **Autonomous manager quality** — close-out latency is ~12s after last pass (run80 long2) with 0 re-hires; keep watching multi-goal recover chatter delaying Done. No outcome keyword classifiers.
2. **Token / cache hygiene** — idle wakes stay model-free; attention `wake_usage` now reports real `cached` / `cache_pct` (often ~34–81% after warm). Watch first-wake cold `cached=0`.
3. **Windows worker file encoding** — workers must write UTF-8 (no BOM); watch for UTF-16 from default PowerShell `Set-Content`.
4. Leave known pre-existing test/clippy failures alone (sidebar 7 vs 6; three workspace contract tests; flaky model-list auth; workspace clippy `-D`).
