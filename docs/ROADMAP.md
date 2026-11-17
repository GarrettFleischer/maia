# Maia roadmap (short)

1. **Memory recall** — progressive disclosure + exact FTS (run74); secret redaction on saves, recall-by-path prompt, searchable session summaries (run75); next: (3) exploration memos keyed to file hashes, (4) decisions with reasons + fact history.
2. **Token hygiene** — keep `manager_system_prefix` byte-stable across turns; watch trailing recall/skills cost (prefix grows slightly with run75 path/summary prompt lines).
3. Leave known pre-existing test/clippy failures alone (sidebar 7 vs 6; three workspace contract tests; flaky model-list auth; workspace clippy `-D`).
