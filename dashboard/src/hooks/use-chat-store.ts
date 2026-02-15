/**
 * @fileoverview Hook to read and update the main chat store.
 * @module hooks/use-chat-store
 *
 * @brief Subscribes to the chat store so the component re-renders when
 * messages or loading change. Use for the Chat route so history persists
 * across navigation.
 */

import { useEffect, useState } from "preact/hooks";
import {
  getChatStoreState,
  subscribeChatStore,
  addChatMessage as storeAddMessage,
  setChatLoading as storeSetLoading,
  type ChatStoreMessage,
} from "../stores/chat-store.js";

/**
 * @brief Hook that subscribes to the chat store and returns current state + updaters.
 * @returns { messages, loading, addMessage, setLoading }
 */
export function useChatStore() {
  const [, setTick] = useState(0);

  useEffect(() => {
    return subscribeChatStore(() => setTick((n) => n + 1));
  }, []);

  const { messages, loading } = getChatStoreState();

  const addMessage = (message: ChatStoreMessage) => storeAddMessage(message);
  const setLoading = (loading: boolean) => storeSetLoading(loading);

  return { messages, loading, addMessage, setLoading };
}
