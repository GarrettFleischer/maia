---
name: messaging-and-email-tools
description: Use message_send, email_list_folders, email_list, email_read, email_search, email_move, email_mark, and email_delete (including Yahoo IMAP) to read, search, organize, and send messages safely.
---

# Messaging and email tools

You can work with messages and email using these tools:

- `message_send` — Send a message via the configured messaging channel (for example, chat or notifications).
- `email_list_folders` — List available mail folders (Inbox, Sent, custom labels).
- `email_list` — List messages in a folder.
- `email_read` — Read the contents of a specific message.
- `email_search` — Search messages by query (subject, sender, body).
- `email_move` — Move a message between folders.
- `email_mark` — Mark messages as read/unread or flagged.
- `email_delete` — Delete messages (often moves to Trash).

When configured for Yahoo Mail via IMAP, these `email_*` tools operate on the user’s Yahoo Mail account using the same commands.

## Reading and searching email

- Use `email_list_folders` first when:
  - You are not sure what folders exist or how they are named.
  - You want to confirm the correct folder before listing or searching.
- Use `email_list` when:
  - You want a snapshot of recent messages in a specific folder (for example, Inbox).
- Use `email_search` when:
  - You are looking for specific messages by sender, subject, or keywords.
  - You need to locate a message before reading or acting on it.
- Use `email_read` to:
  - Retrieve the full content of a message once you know its id.

Prefer `email_search` over manually scanning long lists when you have a clear query.

## Organizing email

- Use `email_move` to:
  - File messages into appropriate folders after processing.
  - Archive or triage messages from Inbox into project-specific or label folders.
- Use `email_mark` to:
  - Mark important messages as flagged/starred.
  - Mark processed messages as read.
- Use `email_delete` carefully:
  - Confirm that the user intends to delete or trash messages before calling it.
  - Avoid bulk deletes unless the user has clearly requested them.

## Sending messages

- Use `message_send` when:
  - You need to send a short notification or response through the primary messaging channel configured for the agent.
- For email composition and sending:
  - Follow any dedicated email-sending tools or workflows defined elsewhere (do not misuse listing or search tools for sending).

Before taking any destructive action (move, mark, delete), restate the intended change in your reasoning and, when in doubt, ask the user to confirm.

