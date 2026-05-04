/**
 * @fileoverview Parses a leading `@persona-slug` mention from user chat input.
 * @module lib/personas/mentions
 */

/**
 * @brief If the message starts with `@word`, returns the slug and the remainder; otherwise personaId is null.
 * @param text - Raw user message
 */
export function parseLeadingPersonaMention(text: string): {
  personaId: string | null;
  rest: string;
} {
  const trimmed = text.trim();
  const m = trimmed.match(/^@([\w-]+)\s*/);
  if (!m) return { personaId: null, rest: text };
  return { personaId: m[1], rest: trimmed.slice(m[0].length).trim() };
}
