-- Add kind and metadata to thread_messages for chat log entries (assistant, tool_call, tool_result, etc.)
ALTER TABLE thread_messages ADD COLUMN kind TEXT;
ALTER TABLE thread_messages ADD COLUMN metadata TEXT;
