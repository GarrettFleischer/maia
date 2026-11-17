# Maia roadmap (short)

1. **Autonomous manager quality** — prompt-first recover/Done is green (run79); watch unnecessary re-hires after pass and long multi-goal close-out latency. No outcome keyword classifiers.
2. **Token hygiene** — idle/waiting-already-asked wakes stay model-free; log `wake_usage`; attention wakes ~4.2–4.5k input.
3. **Windows worker file encoding** — workers must write UTF-8 (no BOM); watch for UTF-16 from default PowerShell `Set-Content`.
4. Leave known pre-existing test/clippy failures alone (sidebar 7 vs 6; three workspace contract tests; flaky model-list auth; workspace clippy `-D`).
