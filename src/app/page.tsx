"use client";

/**
 * @fileoverview Home chat page: message list, input, send; subscribes to /api/events
 * so server-driven (async) agent messages update the UI without user interaction.
 * @module app/page
 */

import { useState, useRef, useEffect, useCallback } from "react";
import type { SSEEvent } from "@/lib/types";
import type { HistoryEntry } from "@/lib/types";
import AppHeader from "@/app/components/AppHeader";
import ChatMessageList from "@/app/components/ChatMessageList";
import type { ChatMessageListItem } from "@/app/components/ChatMessageList";
import ChatInputBar from "@/app/components/ChatInputBar";

/** Map HistoryEntry.role to ChatMessageListItem.role (tool_call/tool_result treated as agent). */
function entryToItem(entry: HistoryEntry): ChatMessageListItem {
  const role: ChatMessageListItem["role"] =
    entry.role === "user" ? "user" : entry.role === "agent" || entry.role === "tool_call" || entry.role === "tool_result" ? "agent" : "system";
  return { role, content: entry.content };
}

export default function Home() {
  const [messages, setMessages] = useState<ChatMessageListItem[]>([]);
  const [input, setInput] = useState("");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [currentToken, setCurrentToken] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const sessionIdRef = useRef<string | null>(null);
  sessionIdRef.current = sessionId;

  useEffect(() => {
    fetch("/api/sessions/active")
      .then((r) => r.json())
      .then((data) => {
        if (data.sessionId) setSessionId(data.sessionId);
        if (data.session?.original?.length) {
          setMessages(
            data.session.original.map((e: { role: string; content: string }) => ({
              role: e.role === "user" ? "user" : "agent",
              content: e.content,
            }))
          );
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const es = new EventSource("/api/events");
    es.addEventListener("message", (e: MessageEvent) => {
      try {
        const payload = JSON.parse(e.data) as { sessionId: string; entry: HistoryEntry; participants: string[] };
        const current = sessionIdRef.current;
        if (payload.sessionId && payload.entry && current && payload.sessionId === current) {
          setMessages((prev) => [...prev, entryToItem(payload.entry)]);
        }
      } catch {
        // ignore non-message or malformed
      }
    });
    es.addEventListener("ping", () => {});
    return () => es.close();
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, currentToken]);

  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if (!text || loading) return;

    setInput("");
    setLoading(true);
    setCurrentToken("");
    setMessages((prev) => [...prev, { role: "user", content: text }]);

    try {
      const resp = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, sessionId: sessionId ?? undefined }),
      });

      if (!resp.body) throw new Error("No response body");

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let accumulated = "";
      let currentToolCalls: { tool: string; args: Record<string, unknown> }[] = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split("\n");

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6);
          let event: SSEEvent;
          try { event = JSON.parse(data); } catch { continue; }

          if (event.type === "token") {
            accumulated += event.content;
            setCurrentToken(accumulated);
          } else if (event.type === "tool_call") {
            currentToolCalls = [...currentToolCalls, { tool: event.tool, args: event.args }];
          } else if (event.type === "done") {
            if (event.sessionId) setSessionId(event.sessionId);
            setMessages((prev) => [
              ...prev,
              { role: "agent", content: accumulated, toolCalls: currentToolCalls.length ? currentToolCalls : undefined },
            ]);
            setCurrentToken("");
            accumulated = "";
            currentToolCalls = [];
          } else if (event.type === "error") {
            setMessages((prev) => [...prev, { role: "system", content: `Error: ${event.message}` }]);
          }
        }
      }
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        { role: "system", content: `Connection error: ${err instanceof Error ? err.message : String(err)}` },
      ]);
    } finally {
      setLoading(false);
    }
  }, [input, loading, sessionId]);

  return (
    <div className="flex flex-col h-screen bg-zinc-950 text-zinc-100">
      <AppHeader subtitle="AI Agent System" />

      <div className="flex-1 overflow-y-auto px-4 py-6 space-y-4 max-w-3xl mx-auto w-full">
        <ChatMessageList
          messages={messages}
          currentToken={currentToken}
          loading={loading}
          bottomRef={bottomRef}
        />
      </div>

      <ChatInputBar
        value={input}
        onChange={setInput}
        onSubmit={sendMessage}
        disabled={loading}
      />
    </div>
  );
}
