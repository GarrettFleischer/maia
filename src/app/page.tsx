"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import type { SSEEvent } from "@/lib/types";

interface ChatMessage {
  role: "user" | "agent" | "system";
  content: string;
  toolCalls?: { tool: string; args: Record<string, unknown> }[];
}

export default function Home() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [currentToken, setCurrentToken] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

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

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  return (
    <div className="flex flex-col h-screen bg-zinc-950 text-zinc-100">
      <header className="flex items-center justify-between px-6 py-4 border-b border-zinc-800">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-full bg-violet-600 flex items-center justify-center text-sm font-bold">M</div>
          <div>
            <div className="font-semibold text-sm">Maia</div>
            <div className="text-xs text-zinc-500">AI Agent System</div>
          </div>
        </div>
        <nav className="flex gap-4 text-sm text-zinc-400">
          <a href="/agents" className="hover:text-zinc-100 transition-colors">Agents</a>
          <a href="/settings" className="hover:text-zinc-100 transition-colors">Settings</a>
        </nav>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-6 space-y-4 max-w-3xl mx-auto w-full">
        {messages.length === 0 && (
          <div className="text-center text-zinc-500 mt-24">
            <div className="text-4xl mb-4">✦</div>
            <p className="text-lg font-medium text-zinc-300">Welcome to Maia</p>
            <p className="text-sm mt-2">Your personal AI agent system. Send a message to get started.</p>
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
            <div
              className={`max-w-[80%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${
                msg.role === "user"
                  ? "bg-violet-600 text-white rounded-br-sm"
                  : msg.role === "system"
                  ? "bg-red-900/50 text-red-200 border border-red-800 rounded-lg"
                  : "bg-zinc-800 text-zinc-100 rounded-bl-sm"
              }`}
            >
              <div className="whitespace-pre-wrap">{msg.content}</div>
              {msg.toolCalls && (
                <div className="mt-2 pt-2 border-t border-zinc-700 space-y-1">
                  {msg.toolCalls.map((tc, j) => (
                    <div key={j} className="text-xs text-zinc-400 font-mono">
                      ⚙ {tc.tool}({JSON.stringify(tc.args)})
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}

        {currentToken && (
          <div className="flex justify-start">
            <div className="max-w-[80%] rounded-2xl rounded-bl-sm px-4 py-3 bg-zinc-800 text-zinc-100 text-sm leading-relaxed">
              <div className="whitespace-pre-wrap">{currentToken}</div>
              <span className="inline-block w-1.5 h-4 bg-violet-400 ml-0.5 animate-pulse" />
            </div>
          </div>
        )}

        {loading && !currentToken && (
          <div className="flex justify-start">
            <div className="rounded-2xl rounded-bl-sm px-4 py-3 bg-zinc-800">
              <div className="flex gap-1">
                <div className="w-2 h-2 rounded-full bg-zinc-500 animate-bounce [animation-delay:0ms]" />
                <div className="w-2 h-2 rounded-full bg-zinc-500 animate-bounce [animation-delay:150ms]" />
                <div className="w-2 h-2 rounded-full bg-zinc-500 animate-bounce [animation-delay:300ms]" />
              </div>
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      <div className="border-t border-zinc-800 px-4 py-4">
        <div className="max-w-3xl mx-auto flex gap-3 items-end">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Message Maia… (Enter to send, Shift+Enter for newline)"
            rows={1}
            className="flex-1 resize-none bg-zinc-800 rounded-xl px-4 py-3 text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-violet-600 max-h-40 overflow-y-auto"
          />
          <button
            onClick={sendMessage}
            disabled={loading || !input.trim()}
            className="shrink-0 w-10 h-10 rounded-xl bg-violet-600 hover:bg-violet-500 disabled:bg-zinc-700 disabled:text-zinc-500 flex items-center justify-center transition-colors"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M.5 1.163A1 1 0 0 1 1.97.28l12.868 6.837a1 1 0 0 1 0 1.766L1.969 15.72A1 1 0 0 1 .5 14.836V10.33a1 1 0 0 1 .816-.983L8.5 8 1.316 6.653A1 1 0 0 1 .5 5.67V1.163Z"/>
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
