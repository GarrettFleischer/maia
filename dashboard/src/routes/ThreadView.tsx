/**
 * @fileoverview Thread conversation view with real-time updates.
 * @module routes/ThreadView
 */

import { useRef, useEffect, useState } from "preact/hooks";
import { useThread } from "../hooks/use-threads.js";
import { wsClient } from "../lib/ws-client.js";
import { postThreadMessage } from "../lib/api-client.js";
import { MessageBubble } from "../components/MessageBubble.js";
import type { ThreadMessage } from "../lib/types.js";

interface ThreadViewProps {
  path?: string;
  id?: string;
}

/**
 * @brief Full conversation view for a thread, with real-time message updates.
 */
export function ThreadView({ id }: ThreadViewProps) {
  if (!id) return <p class="p-6 text-maia-error">Thread ID required.</p>;

  const { thread, setThread, loading, error } = useThread(id);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Subscribe to thread updates via WebSocket
  useEffect(() => {
    wsClient.subscribeThread(id);

    const originalListeners = { ...wsClient };
    const prevOnThreadUpdate = wsClient;

    wsClient.setListeners({
      onThreadUpdate: (update) => {
        if (update.threadId === id) {
          setThread((prev) => {
            if (!prev) return prev;
            const newMsg: ThreadMessage = {
              id: crypto.randomUUID(),
              threadId: id,
              senderId: update.message.senderId,
              senderType: update.message.senderType as "user" | "agent" | "maia",
              content: update.message.content,
              createdAt: update.message.createdAt,
            };
            return { ...prev, messages: [...prev.messages, newMsg] };
          });
        }
      },
      onConnected: () => {},
      onDisconnected: () => {},
    });

    return () => {
      wsClient.unsubscribeThread(id);
    };
  }, [id]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [thread?.messages]);

  const sendMessage = async () => {
    const content = input.trim();
    if (!content || sending || !thread) return;

    setSending(true);
    setInput("");

    try {
      const msg = await postThreadMessage(id, content);
      setThread((prev) => {
        if (!prev) return prev;
        return { ...prev, messages: [...prev.messages, msg] };
      });
    } catch (err) {
      console.error("Failed to send message:", err);
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  if (loading) {
    return (
      <div class="p-6">
        <p class="text-maia-text-dim">Loading thread...</p>
      </div>
    );
  }

  if (error || !thread) {
    return (
      <div class="p-6">
        <p class="text-maia-error">{error ?? "Thread not found"}</p>
      </div>
    );
  }

  return (
    <div class="flex flex-col h-screen">
      {/* Header */}
      <div class="px-6 py-4 border-b border-maia-border bg-maia-surface">
        <h1 class="text-lg font-semibold text-maia-text">
          {thread.title ?? `Thread ${thread.id.slice(0, 8)}`}
        </h1>
        <div class="flex items-center gap-3 mt-1 text-xs text-maia-text-dim">
          <span class="px-2 py-0.5 bg-maia-bg rounded-full">{thread.type}</span>
          <span>👥 {thread.participants.join(", ")}</span>
        </div>
      </div>

      {/* Messages */}
      <div class="flex-1 overflow-y-auto px-6 py-4">
        {thread.messages.length === 0 ? (
          <div class="flex items-center justify-center h-full">
            <p class="text-maia-text-dim text-sm">No messages in this thread yet.</p>
          </div>
        ) : (
          thread.messages.map((msg) => (
            <MessageBubble
              key={msg.id}
              senderId={msg.senderId}
              senderType={msg.senderType}
              content={msg.content}
              createdAt={msg.createdAt}
              isUser={msg.senderType === "user"}
            />
          ))
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input (only for user-facing threads) */}
      {thread.participants.includes("user") && (
        <div class="px-6 py-4 border-t border-maia-border bg-maia-surface">
          <div class="flex gap-3">
            <input
              type="text"
              value={input}
              onInput={(e) => setInput((e.target as HTMLInputElement).value)}
              onKeyDown={handleKeyDown}
              placeholder="Type a message..."
              disabled={sending}
              class="flex-1 bg-maia-surface-light border border-maia-border rounded-xl px-4 py-2.5
                     text-sm text-maia-text placeholder-maia-text-dim
                     focus:outline-none focus:border-maia-accent focus:ring-1 focus:ring-maia-accent
                     disabled:opacity-50"
            />
            <button
              onClick={sendMessage}
              disabled={sending || !input.trim()}
              class="bg-maia-accent hover:bg-maia-accent-hover text-white px-6 py-2.5 rounded-xl
                     text-sm font-medium transition-colors
                     disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Send
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
