"use client";

/**
 * @fileoverview Home chat page: thread list sidebar, message list, input, send; subscribes to /api/events
 * so server-driven (async) agent messages update the UI. Supports switching threads and starting new ones.
 * @module app/page
 */

import { use, useState, useRef, useEffect, useCallback } from "react";
import type { SSEEvent } from "@/lib/types";
import type { HistoryEntry } from "@/lib/types";
import AppHeader from "@/app/components/AppHeader";
import ChatMessageList from "@/app/components/ChatMessageList";
import type { ChatMessageListItem } from "@/app/components/ChatMessageList";
import ChatInputBar from "@/app/components/ChatInputBar";
import ThreadList from "@/app/components/ThreadList";

/** Map HistoryEntry from server to ChatMessageListItem (including tool_call as standalone tool bubble). */
function entryToItem(entry: HistoryEntry): ChatMessageListItem {
  if (entry.role === "tool_call") {
    return {
      role: "tool",
      tool: entry.toolName ?? "",
      args: entry.toolArgs ?? {},
      result: entry.content || undefined,
    };
  }
  const role: "user" | "agent" | "system" =
    entry.role === "user" ? "user" : entry.role === "agent" ? "agent" : "system";
  return { role, content: entry.content };
}

type SessionType = "user" | "agents";

interface ActiveSessionResponse {
  sessionId?: string;
  session?: {
    original: HistoryEntry[];
    type?: SessionType;
    participants?: string[];
  };
}

/** Primary agent id for the current user thread (non-user participant); null when none or agent-only thread. */
function primaryAgentFromParticipants(participants: string[] | undefined, type: SessionType): string | null {
  if (type !== "user" || !participants?.length) return null;
  const other = participants.filter((p) => p !== "user")[0];
  return other ?? null;
}

/** Pre-resolved promise for tests when Next.js does not pass params/searchParams; avoids conditional use() call. */
const RESOLVED_EMPTY = Promise.resolve({} as Record<string, string | string[] | undefined>);

/** Props for home page; params/searchParams are Promises in Next.js 15 and must be unwrapped with use(). */
type HomePageProps = {
  params?: Promise<Record<string, string | undefined>>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default function Home(props: HomePageProps = {}) {
  use(props.params ?? RESOLVED_EMPTY as Promise<Record<string, string | undefined>>);
  use(props.searchParams ?? RESOLVED_EMPTY);
  const [messages, setMessages] = useState<ChatMessageListItem[]>([]);
  const [input, setInput] = useState("");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessionType, setSessionType] = useState<SessionType>("user");
  const [currentAgentId, setCurrentAgentId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [currentToken, setCurrentToken] = useState("");
  const [currentThinking, setCurrentThinking] = useState("");
  const [threadListRefetch, setThreadListRefetch] = useState(0);
  const bottomRef = useRef<HTMLDivElement>(null);
  const sessionIdRef = useRef<string | null>(null);
  const loadingRef = useRef(false);
  const currentAgentIdRef = useRef<string | null>(null);
  const thinkingAccumulatorRef = useRef("");
  sessionIdRef.current = sessionId;
  loadingRef.current = loading;
  currentAgentIdRef.current = currentAgentId;

  /** Load a session by id into messages and set as active. */
  const loadSession = useCallback(async (id: string) => {
    const res = await fetch("/api/sessions/active", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: id }),
    });
    if (!res.ok) return;
    const data = (await fetch("/api/sessions/active").then((r) => r.json())) as ActiveSessionResponse;
    if (data.sessionId) setSessionId(data.sessionId);
    const type = data.session?.type ?? "user";
    if (data.session?.type) setSessionType(type);
    const primary = primaryAgentFromParticipants(data.session?.participants, type);
    setCurrentAgentId(primary);
    const entries = data.session?.original ?? [];
    const items = entries.map(entryToItem);
    setMessages(items);
  }, []);

  useEffect(() => {
    fetch("/api/sessions/active")
      .then((r) => {
        if (!r.ok) return null;
        return r.json() as Promise<ActiveSessionResponse>;
      })
      .then((data) => {
        if (!data) return;
        if (data.sessionId) setSessionId(data.sessionId);
        const type = data.session?.type ?? "user";
        if (data.session?.type) setSessionType(type);
        const primary = primaryAgentFromParticipants(data.session?.participants, type);
        setCurrentAgentId(primary);
        currentAgentIdRef.current = primary;
        if (data.session?.original?.length) {
          const loaded = data.session.original.map(entryToItem);
          setMessages((prev) => {
            if (prev.length > 0) return prev; // avoid overwriting streamed messages if fetch completes late
            return loaded;
          });
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
          // While our chat request is in flight, the stream is the source of truth; skip EventSource
          // echoes for user and tool_call so we don't duplicate bubbles.
          if (loadingRef.current && (payload.entry.role === "user" || payload.entry.role === "tool_call")) {
            return;
          }
          const item = entryToItem(payload.entry);
          const contentLen = "content" in item ? (item.content?.length ?? 0) : 0;
          if (payload.entry.role === "agent") {
            setCurrentToken("");
            if (loadingRef.current) return;
            if (contentLen === 0) return;
          }
          // Dedupe: server may echo user entry via EventSource after we added it optimistically.
          if (payload.entry.role === "user") {
            setMessages((prev) => {
              if (prev.length > 0) {
                const last = prev[prev.length - 1];
                if (last.role === "user" && "content" in last && last.content === payload.entry.content) {
                  return prev;
                }
              }
              return [...prev, item];
            });
          } else {
            setMessages((prev) => [...prev, item]);
          }
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
  }, [messages, currentToken, currentThinking]);

  /** Send a message. If overrideContent is provided, uses that instead of input and does not clear input (used by re-send). */
  const sendMessage = useCallback(async (overrideContent?: string) => {
    const raw = overrideContent ?? input;
    const text = (typeof raw === "string" ? raw : "").trim();
    if (!text || loading) return;

    if (!overrideContent) setInput("");
    setLoading(true);
    setCurrentToken("");
    setCurrentThinking("");
    thinkingAccumulatorRef.current = "";
    setMessages((prev) => [...prev, { role: "user", content: text }]);

    try {
      const resp = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: text,
          sessionId: sessionIdRef.current ?? undefined,
          targetAgent: currentAgentIdRef.current ?? "maia",
        }),
      });

      if (!resp.body) throw new Error("No response body");

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let accumulated = "";
      let lineBuffer = "";
      /** Only append agent message on first "done"; avoids second "done" appending with empty accumulated. */
      let doneAppended = false;

      function flushThinking(): void {
        if (thinkingAccumulatorRef.current.length > 0) {
          const content = thinkingAccumulatorRef.current;
          thinkingAccumulatorRef.current = "";
          setCurrentThinking("");
          setMessages((prev) => [...prev, { role: "thinking", content }]);
        }
      }

      function processLine(line: string): void {
        if (!line.startsWith("data: ")) return;
        const data = line.slice(6);
        let event: SSEEvent;
        try {
          event = JSON.parse(data);
        } catch {
          return;
        }

        if (event.type === "thinking") {
          thinkingAccumulatorRef.current += event.content;
          setCurrentThinking(thinkingAccumulatorRef.current);
        } else if (event.type === "token") {
          flushThinking();
          accumulated += event.content;
          setCurrentToken(accumulated);
        } else if (event.type === "tool_call") {
          flushThinking();
          setMessages((prev) => [...prev, { role: "tool" as const, tool: event.tool, args: event.args }]);
        } else if (event.type === "tool_result") {
          setMessages((prev) => {
            const idx = prev.findIndex((m) => m.role === "tool" && (m as { result?: unknown }).result === undefined);
            if (idx === -1) return prev;
            const item = prev[idx];
            if (item.role !== "tool") return prev;
            return [...prev.slice(0, idx), { ...item, result: event.result }, ...prev.slice(idx + 1)];
          });
        } else if (event.type === "done") {
          flushThinking();
          if (event.sessionId) setSessionId(event.sessionId);
          const contentToAdd = accumulated;
          if (!doneAppended && contentToAdd.length > 0) {
            setMessages((prev) => [...prev, { role: "agent", content: contentToAdd }]);
            doneAppended = true;
            setCurrentToken("");
          }
          accumulated = "";
          setThreadListRefetch((n) => n + 1);
        } else if (event.type === "error") {
          setMessages((prev) => [...prev, { role: "system", content: `Error: ${event.message}` }]);
          setCurrentToken("");
          setCurrentThinking("");
          thinkingAccumulatorRef.current = "";
          accumulated = "";
        }
      }

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        lineBuffer += decoder.decode(value, { stream: true });
        const lines = lineBuffer.split("\n");
        lineBuffer = lines.pop() ?? "";
        for (const line of lines) processLine(line);
      }
      if (lineBuffer.trim()) processLine(lineBuffer);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        { role: "system", content: `Connection error: ${err instanceof Error ? err.message : String(err)}` },
      ]);
    } finally {
      setLoading(false);
    }
  }, [input, loading]);

  /** Clear history after the given message index and re-post that message. */
  const handleResendMessage = useCallback(
    async (index: number, content: string) => {
      if (loading) return;
      if (sessionId) {
        const res = await fetch(`/api/sessions/${sessionId}/history/truncate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ keepThroughIndex: index - 1 }),
        });
        if (!res.ok) return;
      }
      setMessages((prev) => prev.slice(0, index));
      await sendMessage(content);
    },
    [loading, sessionId, sendMessage]
  );

  const handleSelectSession = useCallback(
    (id: string) => {
      if (id === sessionId) return;
      loadSession(id);
    },
    [sessionId, loadSession]
  );

  const handleNewThreadWithAgent = useCallback(
    async (agentId: string) => {
      const res = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ participants: ["user", agentId], type: "user" }),
      });
      if (!res.ok) return;
      const body = (await res.json()) as { sessionId: string };
      setCurrentAgentId(agentId);
      await loadSession(body.sessionId);
      setSessionType("user");
      setThreadListRefetch((n) => n + 1);
    },
    [loadSession]
  );

  const handleThreadDeleted = useCallback((deletedId: string) => {
    setThreadListRefetch((n) => n + 1);
    if (deletedId === sessionId) {
      setSessionId(null);
      setMessages([]);
      setCurrentAgentId(null);
    }
  }, [sessionId]);

  const isAgentOnlyThread = sessionType === "agents";

  return (
    <div className="flex flex-col h-screen bg-zinc-950 text-zinc-100">
      <AppHeader subtitle="AI Agent System" />

      <div className="flex flex-1 min-h-0">
        <ThreadList
          activeSessionId={sessionId}
          onSelectSession={handleSelectSession}
          onNewThreadWithAgent={handleNewThreadWithAgent}
          refetchTrigger={threadListRefetch}
          onThreadDeleted={handleThreadDeleted}
        />

        <div className="flex flex-col flex-1 min-w-0">
          <div className="chat-scroll flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
            <div className="px-4 py-6 space-y-4 max-w-3xl mx-auto w-full">
              {isAgentOnlyThread && (
                <div className="rounded-lg bg-zinc-800/80 border border-zinc-700 px-4 py-2 text-sm text-zinc-400">
                  Agent-to-agent thread (read-only). Switch to a user thread to send messages.
                </div>
              )}
              <ChatMessageList
                messages={messages}
                currentToken={currentToken}
                currentThinking={currentThinking}
                loading={loading}
                bottomRef={bottomRef}
                onResendMessage={!isAgentOnlyThread ? handleResendMessage : undefined}
              />
            </div>
          </div>

          {!isAgentOnlyThread && (
            <ChatInputBar
              value={input}
              onChange={setInput}
              onSubmit={sendMessage}
              disabled={loading}
            />
          )}
        </div>
      </div>
    </div>
  );
}
