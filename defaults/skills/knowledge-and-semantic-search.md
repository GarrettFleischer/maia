---
name: knowledge-and-semantic-search
description: Use knowledge_search, history_semantic_search, and chat_find to retrieve relevant information by meaning, not just keywords.
---

# Knowledge and semantic search tools

You have semantic search tools that find information by meaning:

- `knowledge_search` — Search indexed files and facts (including memory/user and other knowledge sources).
- `history_semantic_search` — Search past conversation history using embeddings and semantic similarity.
- `chat_find` — Search within the current chat session using semantic matching.

## When to use knowledge_search

Prefer `knowledge_search` when:

- You need facts or documentation from files indexed under your agent root, user files, or shared/global knowledge.
- You are answering questions about design decisions, project docs, or long-term facts stored in `memory/` or `user/`.

Usage guidance:

- Choose the appropriate scope (`self`, `user`, or `global`) based on where the information likely lives.
- Provide a short description of what you are looking for (for example, “API authentication flow” or “user preferences for notifications”).
- Examine the returned snippets and file references before drawing conclusions.

## When to use history_semantic_search vs chat_find

Prefer `chat_find` when:

- You are searching **within the current session** for earlier discussion about a specific topic.
- You remember approximate wording but not exact phrases.

Prefer `history_semantic_search` when:

- You need to search across **multiple sessions** or a large history for conceptually similar content.
- You want to find prior tasks or decisions that are related but not textually identical.

For both:

- Use clear, focused queries that describe the idea or question, not just a single keyword.
- Limit the number of returned results to what you can realistically review.

## Combining semantic search with other tools

- Use semantic search to locate the most relevant snippets or messages first.
- Then, if needed, follow up with:
  - `chat_read` or `history_get_session` to see more surrounding context.
  - File tools to open full documents identified by `knowledge_search`.

Always verify that the retrieved snippets truly apply to the user’s current question before relying on them in your answer.

