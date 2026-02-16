/**
 * @fileoverview Shared prompt strings for Maia system-triggered runs.
 * @module agent/prompts
 *
 * @brief Centralizes brain, thinking, and startup prompts so they can be
 * tested and updated in one place.
 */

/**
 * @brief Prompt for Maia's periodic "thinking" run: reflect and optionally share with user or agents.
 * @note When the thinking handler runs, Maia receives this; she may call message(recipientId, content) or reply with text only.
 */
export const MAIA_THINKING_PROMPT =
  "Briefly: what are you focusing on right now? If there's something the user or an agent should know (a plan, a question, a decision), use message(recipientId: 'user', 'maia', or an agent id, content: '...') to share it. Keep it short.";
