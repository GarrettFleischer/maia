/**
 * @fileoverview Pure helpers for ChatView: streaming message id and thinking indicator logic.
 * @module app/components/chatViewHelpers
 */

/** Id used for the in-flight streaming assistant message before it is finalized. */
export const STREAMING_MESSAGE_ID = "__streaming__";

/** Minimal message shape used by shouldShowThinkingIndicator. */
export type MessageForThinkingIndicator = {
  id: string;
  content: string | null;
};

/**
 * Returns true when the message is the streaming placeholder and has no content yet.
 * @brief Determines if the UI should show a thinking/typing indicator for this message.
 * @param message - Message record with id and content
 * @returns true if this is the streaming message with null or empty content
 * @example
 * shouldShowThinkingIndicator({ id: STREAMING_MESSAGE_ID, content: "" }) // true
 * shouldShowThinkingIndicator({ id: STREAMING_MESSAGE_ID, content: "Hi" }) // false
 */
export function shouldShowThinkingIndicator(
  message: MessageForThinkingIndicator,
): boolean {
  return (
    message.id === STREAMING_MESSAGE_ID &&
    (message.content == null || message.content.trim() === "")
  );
}
