# Maia roadmap (short)

1. **Memory recall** — progressive disclosure (`search_memories` / `get_memories`) + exact FTS keyword arm shipped in run74; next: (3) exploration memos keyed to file hashes, (4) decisions with reasons + fact history, (5) secret redaction on saves, (6) recall by file path before editing, (7) searchable session summaries.
2. **Token hygiene** — keep `manager_system_prefix` byte-stable across turns; watch trailing recall/skills cost (`prefix≈2513` empty catalog after run74 memory prompt lines).
3. Leave known pre-existing test/clippy failures alone (sidebar 7 vs 6; three workspace contract tests; flaky model-list auth; workspace clippy `-D`).
