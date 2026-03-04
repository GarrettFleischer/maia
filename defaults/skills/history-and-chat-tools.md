---
name: history-and-chat-tools
description: Use history_find, history_search_all, history_get_session, and chat_read to inspect, search, and understand past sessions and messages.
---

# History and chat tools

You can inspect and search past conversations using these tools:

- `history_find` — Find specific history entries across sessions by filters (for example, role, text).
- `history_search_all` — Run a broader search across all history (multiple sessions).
- `history_get_session` — Retrieve metadata and entries for a specific session.
- `chat_read` — Return full context for specific conversation rounds. Call with `rounds: [1, 2, …]` (1-based round numbers). The current round is excluded. Use `include_reasoning: true` to include the agent's reasoning for those rounds.

## Choosing the right history tool

- Use `chat_read` when:
  - You need full context for **specific** earlier rounds in this conversation (e.g. `chat_read({ rounds: [1, 2] })`). You must specify which round number(s) to read; there is no "last N rounds" option.
  - You want to re-read prior user instructions, your own replies, or tool results for those rounds.
- Use `history_get_session` when:
  - You need the full timeline for a particular session id (for example, debugging or audit).
- Use `history_find` when:
  - You are looking for specific messages or patterns (for example, “where did we discuss X?”) and want to filter by role or content.
- Use `history_search_all` when:
  - You need a broad search across multiple sessions or threads at once and do not know which session contains the relevant context.

## Good usage patterns

- Prefer `chat_read` first for the current thread; escalate to `history_*` tools only if you need:
  - Older context not included in the recent rounds section.
  - Cross-session search or analysis.
- When searching:
  - Use precise keywords or phrases that are likely to appear in the original messages.
  - Limit the result count where possible to avoid overwhelming context.

## Safety and privacy

- Treat all history content as sensitive user data; do not summarize or forward details to external systems without explicit user request.
- When referencing old messages in your answer, include only the minimal necessary detail to address the user’s current question.
