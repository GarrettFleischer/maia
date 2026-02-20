/**
 * @fileoverview In-memory broadcaster for conversation updates. Used to push new-message
 * events to SSE subscribers so the UI can refresh without polling.
 * @module lib/conversation-events
 */

type Listener = () => void;

const listenersByConversation = new Map<string, Set<Listener>>();

/**
 * Subscribe to updates for a conversation. When broadcast(conversationId) is called,
 * all listeners for that id are invoked.
 * @param conversationId - Conversation to subscribe to
 * @param onUpdate - Callback when an update is broadcast
 * @returns Unsubscribe function
 */
export function subscribe(
  conversationId: string,
  onUpdate: Listener
): () => void {
  let set = listenersByConversation.get(conversationId);
  if (!set) {
    set = new Set();
    listenersByConversation.set(conversationId, set);
  }
  set.add(onUpdate);
  return () => {
    set?.delete(onUpdate);
    if (set?.size === 0) listenersByConversation.delete(conversationId);
  };
}

/**
 * Notify all subscribers that a conversation has new messages.
 * Call this after appending to a conversation (e.g. heartbeat monologue, send route).
 * @param conversationId - Conversation that was updated
 */
export function broadcast(conversationId: string): void {
  const set = listenersByConversation.get(conversationId);
  if (!set) return;
  for (const fn of set) {
    try {
      fn();
    } catch {
      // ignore listener errors
    }
  }
}
