/**
 * @fileoverview Maia chat page, migrated from the vanilla web UI.
 * @module routes/Chat
 *
 * @note Messages and loading come from the chat store (useChatStore) so
 * history persists when navigating away. WebSocket listeners are set once
 * in useWebSocket; do not call setListeners here.
 */

import { useState, useRef, useEffect } from "preact/hooks";
import { wsClient } from "../lib/ws-client.js";
import { MessageBubble } from "../components/MessageBubble.js";
import { useChatStore } from "../hooks/use-chat-store.js";

interface ChatProps {
  path?: string;
}

/**
 * @brief Chat page for talking with Maia.
 */
export function Chat(_props: ChatProps) {
  const { messages, loading, addMessage, setLoading } = useChatStore();
  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const sendMessage = () => {
    const content = input.trim();
    if (!content || loading) return;

    const msgId = crypto.randomUUID();
    addMessage({
      id: msgId,
      content,
      senderType: "user",
      createdAt: new Date().toISOString(),
    });
    setInput("");
    setLoading(true);

    wsClient.sendChat(content, msgId);
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  return (
    <div class="flex flex-col h-screen">
      {/* Header */}
      <div class="px-6 py-4 border-b border-maia-border bg-maia-surface">
        <div class="flex items-center gap-2">
          <span class="text-xl">🌙</span>
          <h1 class="text-lg font-semibold text-maia-text">Chat with Maia</h1>
        </div>
      </div>

      {/* Messages */}
      <div class="flex-1 overflow-y-auto px-6 py-4">
        {messages.length === 0 && (
          <div class="flex items-center justify-center h-full">
            <p class="text-maia-text-dim text-sm">Start a conversation with Maia...</p>
          </div>
        )}
        {messages.map((msg) => (
          <MessageBubble
            key={msg.id}
            senderId={msg.senderType === "user" ? "user" : "maia"}
            senderType={msg.senderType}
            content={msg.content}
            createdAt={msg.createdAt}
            isUser={msg.senderType === "user"}
            remembered={msg.remembered}
            toolCallsSummary={msg.toolCallsSummary}
            responderId={msg.responderId}
          />
        ))}
        {loading && (
          <div class="flex items-start mb-3">
            <div class="bg-maia-surface-light rounded-xl px-4 py-2.5 text-sm text-maia-text-dim">
              <span class="animate-pulse">Maia is thinking...</span>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div class="px-6 py-4 border-t border-maia-border bg-maia-surface">
        <div class="flex gap-3">
          <input
            ref={inputRef}
            type="text"
            value={input}
            onInput={(e) => setInput((e.target as HTMLInputElement).value)}
            onKeyDown={handleKeyDown}
            placeholder="Type a message..."
            disabled={loading}
            class="flex-1 bg-maia-surface-light border border-maia-border rounded-xl px-4 py-2.5
                   text-sm text-maia-text placeholder-maia-text-dim
                   focus:outline-none focus:border-maia-accent focus:ring-1 focus:ring-maia-accent
                   disabled:opacity-50"
          />
          <button
            onClick={sendMessage}
            disabled={loading || !input.trim()}
            class="bg-maia-accent hover:bg-maia-accent-hover text-white px-6 py-2.5 rounded-xl
                   text-sm font-medium transition-colors
                   disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
