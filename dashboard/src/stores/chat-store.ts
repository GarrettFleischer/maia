/**
 * @fileoverview Global chat store for the main Maia chat. Persists messages
 * across route changes so chat history is not lost when navigating away.
 * @module stores/chat-store
 *
 * @note The store lives above the router; Chat reads from it and onChatResponse
 * (set in useWebSocket) updates it. Do not call setListeners from Chat so
 * other WS listeners (DMs, approvals) are not overwritten.
 */

/**
 * @brief A single message in the main chat.
 */
export interface ChatStoreMessage {
  id: string;
  content: string;
  senderType: "user" | "maia";
  createdAt: string;
  /** When set, show "[Name] will remember that" below the message */
  remembered?: Record<string, string>;
  /** When set, show tool call summaries (e.g. "Created agent wally") below the message, like "will remember that" */
  toolCallsSummary?: string[];
  responderId?: string;
}

interface ChatStoreState {
  messages: ChatStoreMessage[];
  loading: boolean;
}

type Listener = () => void;

let state: ChatStoreState = {
  messages: [],
  loading: false,
};

const listeners = new Set<Listener>();

/**
 * @brief Returns the current chat store state.
 */
export function getChatStoreState(): ChatStoreState {
  return state;
}

/**
 * @brief Updates state and notifies subscribers.
 * @param updater - Function that receives current state and returns new state
 */
function setState(updater: (prev: ChatStoreState) => ChatStoreState): void {
  state = updater(state);
  listeners.forEach((l) => l());
}

/**
 * @brief Subscribes to store changes. Call the returned function to unsubscribe.
 * @param listener - Callback invoked when state changes
 * @returns Unsubscribe function
 */
export function subscribeChatStore(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * @brief Appends a message to the chat (user or Maia).
 * @param message - Message to append
 */
export function addChatMessage(message: ChatStoreMessage): void {
  setState((prev) => ({
    ...prev,
    messages: [...prev.messages, message],
  }));
}

/**
 * @brief Sets the loading flag (e.g. while waiting for Maia's response).
 * @param loading - New loading value
 */
export function setChatLoading(loading: boolean): void {
  setState((prev) => ({ ...prev, loading }));
}
