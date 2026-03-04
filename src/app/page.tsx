"use client";

/**
 * @fileoverview Home chat page: thread list sidebar, message list, input, send; subscribes to /api/events
 * so server-driven (async) agent messages update the UI. Supports switching threads and starting new ones.
 * @module app/page
 */

import { use, useState, useRef, useEffect, useCallback } from "react";
import type { SSEEvent, SmartContextRun } from "@/lib/types";
import type { HistoryEntry } from "@/lib/types";
import AppHeader from "@/app/components/AppHeader";
import ChatMessageList from "@/app/components/ChatMessageList";
import type { ChatMessageListItem } from "@/app/components/ChatMessageList";
import ChatInputBar from "@/app/components/ChatInputBar";
import ThreadList from "@/app/components/ThreadList";
import QuestionFormModal, {
  type QuestionItem,
} from "@/app/components/QuestionFormModal";

/** Map HistoryEntry from server to ChatMessageListItem (including tool_call as standalone tool bubble, thinking as reasoning bubble). Do not pass smart_context entries. */
function entryToItem(entry: HistoryEntry): ChatMessageListItem {
  if (entry.role === "tool_call") {
    return {
      role: "tool",
      tool: entry.toolName ?? "",
      args: entry.toolArgs ?? {},
      result: entry.content || undefined,
    };
  }
  if (entry.role === "thinking") {
    return { role: "thinking", content: entry.content };
  }
  const role: "user" | "agent" | "system" =
    entry.role === "user"
      ? "user"
      : entry.role === "agent"
        ? "agent"
        : "system";
  return {
    role,
    content: entry.content,
    resolvedContent: entry.resolvedContent,
    roundIndex: entry.roundIndex,
  };
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
function primaryAgentFromParticipants(
  participants: string[] | undefined,
  type: SessionType,
): string | null {
  if (type !== "user" || !participants?.length) return null;
  const other = participants.filter((p) => p !== "user")[0];
  return other ?? null;
}

/** Pre-resolved promise for tests when Next.js does not pass params/searchParams; avoids conditional use() call. */
const RESOLVED_EMPTY = Promise.resolve(
  {} as Record<string, string | string[] | undefined>,
);

/** Props for home page; params/searchParams are Promises in Next.js 15 and must be unwrapped with use(). */
type HomePageProps = {
  params?: Promise<Record<string, string | undefined>>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default function Home(props: HomePageProps = {}) {
  use(
    props.params ??
      (RESOLVED_EMPTY as Promise<Record<string, string | undefined>>),
  );
  use(props.searchParams ?? RESOLVED_EMPTY);
  const [messages, setMessages] = useState<ChatMessageListItem[]>([]);
  const [input, setInput] = useState("");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessionType, setSessionType] = useState<SessionType>("user");
  const [currentAgentId, setCurrentAgentId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [currentToken, setCurrentToken] = useState("");
  const [currentThinking, setCurrentThinking] = useState("");
  /** Preserved smart context run (phases + result). Not cleared when tokens/done arrive; replaced when next run starts. */
  const [smartContextRun, setSmartContextRun] =
    useState<SmartContextRun | null>(null);
  /** Message index after which to show smart context (below the user message that triggered it). */
  const [smartContextAfterMessageIndex, setSmartContextAfterMessageIndex] =
    useState<number | null>(null);
  const [threadListRefetch, setThreadListRefetch] = useState(0);
  const [userIsAtBottom, setUserIsAtBottom] = useState(true);
  /** When the agent calls ask_user, we show this modal until the user submits answers. */
  const [pendingQuestion, setPendingQuestion] = useState<{
    sessionId: string;
    requestId: string;
    questions: QuestionItem[];
  } | null>(null);
  const userIsAtBottomRef = useRef(true);
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
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
    const data = (await fetch("/api/sessions/active").then((r) =>
      r.json(),
    )) as ActiveSessionResponse;
    if (data.sessionId) setSessionId(data.sessionId);
    const type = data.session?.type ?? "user";
    if (data.session?.type) setSessionType(type);
    const primary = primaryAgentFromParticipants(
      data.session?.participants,
      type,
    );
    setCurrentAgentId(primary);
    const original = data.session?.original ?? [];
    const conversationEntries = original.filter(
      (e) => e.role !== "smart_context",
    );
    setMessages(conversationEntries.map(entryToItem));
    const smartContextEntry = original
      .filter((e) => e.role === "smart_context")
      .pop();
    if (smartContextEntry) {
      try {
        setSmartContextRun(
          JSON.parse(smartContextEntry.content) as SmartContextRun,
        );
        const lastScIdx = original.findLastIndex(
          (e) => e.role === "smart_context",
        );
        const lastUserIdxBeforeSc =
          lastScIdx >= 0
            ? original.findLastIndex(
                (e, i) => i < lastScIdx && e.role === "user",
              )
            : -1;
        const afterIndex =
          lastUserIdxBeforeSc >= 0
            ? original
                .slice(0, lastUserIdxBeforeSc + 1)
                .filter((e) => e.role !== "smart_context").length - 1
            : null;
        setSmartContextAfterMessageIndex(afterIndex ?? null);
      } catch {
        setSmartContextRun(null);
        setSmartContextAfterMessageIndex(null);
      }
    } else {
      setSmartContextRun(null);
      setSmartContextAfterMessageIndex(null);
    }
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
        const primary = primaryAgentFromParticipants(
          data.session?.participants,
          type,
        );
        setCurrentAgentId(primary);
        currentAgentIdRef.current = primary;
        if (data.session?.original?.length) {
          const original = data.session.original;
          const conversationEntries = original.filter(
            (e: HistoryEntry) => e.role !== "smart_context",
          );
          const loaded = conversationEntries.map(entryToItem);
          setMessages((prev) => {
            if (prev.length > 0) return prev; // avoid overwriting streamed messages if fetch completes late
            return loaded;
          });
          const smartContextEntry = original
            .filter((e: HistoryEntry) => e.role === "smart_context")
            .pop();
          if (smartContextEntry) {
            try {
              setSmartContextRun(
                JSON.parse(smartContextEntry.content) as SmartContextRun,
              );
              const lastScIdx = original.findLastIndex(
                (e: HistoryEntry) => e.role === "smart_context",
              );
              const lastUserIdxBeforeSc =
                lastScIdx >= 0
                  ? original.findLastIndex(
                      (e: HistoryEntry, i: number) =>
                        i < lastScIdx && e.role === "user",
                    )
                  : -1;
              const afterIndex =
                lastUserIdxBeforeSc >= 0
                  ? original
                      .slice(0, lastUserIdxBeforeSc + 1)
                      .filter((e: HistoryEntry) => e.role !== "smart_context")
                      .length - 1
                  : null;
              setSmartContextAfterMessageIndex(afterIndex ?? null);
            } catch {
              setSmartContextRun(null);
              setSmartContextAfterMessageIndex(null);
            }
          } else {
            setSmartContextRun(null);
            setSmartContextAfterMessageIndex(null);
          }
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const es = new EventSource("/api/events");
    es.addEventListener("message", (e: MessageEvent) => {
      try {
        const payload = JSON.parse(e.data) as {
          sessionId: string;
          entry: HistoryEntry;
          participants: string[];
        };
        const current = sessionIdRef.current;
        if (
          payload.sessionId &&
          payload.entry &&
          current &&
          payload.sessionId === current
        ) {
          // While our chat request is in flight, skip EventSource tool_call echoes to avoid duplicate bubbles.
          // For user entries we still apply server data (resolvedContent, roundIndex) to the optimistic message.
          if (loadingRef.current && payload.entry.role === "tool_call") {
            return;
          }
          if (payload.entry.role === "smart_context") {
            try {
              setSmartContextRun(
                JSON.parse(payload.entry.content) as SmartContextRun,
              );
            } catch {
              setSmartContextRun(null);
            }
            return;
          }
          const item = entryToItem(payload.entry);
          const contentLen =
            "content" in item ? (item.content?.length ?? 0) : 0;
          if (payload.entry.role === "agent") {
            setCurrentToken("");
            if (contentLen === 0) return;
          }
          // Dedupe or merge: server may echo user entry via EventSource after we added it optimistically.
          // When the last message is the same user content, merge resolvedContent and roundIndex so the clarified command shows without refresh.
          if (payload.entry.role === "user") {
            setMessages((prev) => {
              if (prev.length > 0) {
                const last = prev[prev.length - 1];
                if (
                  last.role === "user" &&
                  "content" in last &&
                  last.content === payload.entry.content
                ) {
                  const resolvedContent = payload.entry.resolvedContent;
                  const roundIndex = payload.entry.roundIndex;
                  if (
                    resolvedContent !== undefined ||
                    roundIndex !== undefined
                  ) {
                    return [
                      ...prev.slice(0, -1),
                      {
                        ...last,
                        ...(resolvedContent !== undefined && {
                          resolvedContent,
                        }),
                        ...(roundIndex !== undefined && { roundIndex }),
                      },
                    ];
                  }
                  return prev;
                }
              }
              return [...prev, item];
            });
          } else if (payload.entry.role === "agent") {
            setMessages((prev) => {
              if (prev.length > 0) {
                const last = prev[prev.length - 1];
                if (
                  last.role === "agent" &&
                  "content" in last &&
                  last.content === payload.entry.content
                ) {
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
    es.addEventListener("question", (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as {
          sessionId: string;
          requestId: string;
          questions: QuestionItem[];
        };
        if (data.sessionId && data.requestId && Array.isArray(data.questions)) {
          const current = sessionIdRef.current;
          if (current && data.sessionId === current) {
            setPendingQuestion({
              sessionId: data.sessionId,
              requestId: data.requestId,
              questions: data.questions,
            });
          }
        }
      } catch {
        // ignore malformed
      }
    });
    es.addEventListener("ping", () => {});
    return () => es.close();
  }, []);

  /** Threshold in px: user is "at bottom" when within this distance of the bottom. */
  const SCROLL_AT_BOTTOM_THRESHOLD = 80;

  const handleScrollContainerScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const { scrollTop, scrollHeight, clientHeight } = el;
    const atBottom =
      scrollTop + clientHeight >= scrollHeight - SCROLL_AT_BOTTOM_THRESHOLD;
    userIsAtBottomRef.current = atBottom;
    setUserIsAtBottom(atBottom);
  }, []);

  useEffect(() => {
    if (!userIsAtBottomRef.current) return;
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, currentToken, currentThinking, userIsAtBottom]);

  /** Send a message. If overrideContent is provided, uses that instead of input and does not clear input (used by re-send). */
  const sendMessage = useCallback(
    async (overrideContent?: string) => {
      const raw = overrideContent ?? input;
      const text = (typeof raw === "string" ? raw : "").trim();
      if (!text || loading) return;

      if (!overrideContent) setInput("");
      setLoading(true);
      setCurrentToken("");
      setCurrentThinking("");
      thinkingAccumulatorRef.current = "";
      setSmartContextRun(null);
      setSmartContextAfterMessageIndex(null);
      setMessages((prev) => {
        const newIndex = prev.length;
        setSmartContextAfterMessageIndex(newIndex);
        return [...prev, { role: "user", content: text }];
      });

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

          if (event.type === "smart_context_phase") {
            setSmartContextRun((prev) => {
              const phase = event.phase;
              const detail = event.detail;
              const output = event.output;
              const prevPhases = prev?.phases ?? [];
              const last = prevPhases[prevPhases.length - 1];
              const isNewPhase = !last || last.phase !== phase;
              const phaseEntry = isNewPhase
                ? { phase, detail, output }
                : {
                    phase,
                    detail: detail ?? last.detail,
                    output: output ?? last.output,
                  };
              const phases = isNewPhase
                ? [...prevPhases, phaseEntry]
                : [...prevPhases.slice(0, -1), phaseEntry];
              const doneDetail = phase === "done" ? detail : prev?.doneDetail;
              return { phases, doneDetail };
            });
          } else if (event.type === "thinking") {
            thinkingAccumulatorRef.current += event.content;
            setCurrentThinking(thinkingAccumulatorRef.current);
          } else if (event.type === "token") {
            flushThinking();
            accumulated += event.content;
            setCurrentToken(accumulated);
          } else if (event.type === "tool_call") {
            flushThinking();
            setMessages((prev) => [
              ...prev,
              { role: "tool" as const, tool: event.tool, args: event.args },
            ]);
          } else if (event.type === "tool_result") {
            setMessages((prev) => {
              const idx = prev.findIndex(
                (m) =>
                  m.role === "tool" &&
                  (m as { result?: unknown }).result === undefined,
              );
              if (idx === -1) return prev;
              const item = prev[idx];
              if (item.role !== "tool") return prev;
              return [
                ...prev.slice(0, idx),
                { ...item, result: event.result },
                ...prev.slice(idx + 1),
              ];
            });
          } else if (event.type === "done") {
            flushThinking();
            if (event.sessionId) setSessionId(event.sessionId);
            const contentToAdd = accumulated;
            if (!doneAppended && contentToAdd.length > 0) {
              setMessages((prev) => [
                ...prev,
                { role: "agent", content: contentToAdd },
              ]);
              doneAppended = true;
              setCurrentToken("");
            }
            accumulated = "";
            setThreadListRefetch((n) => n + 1);
          } else if (event.type === "error") {
            setMessages((prev) => [
              ...prev,
              { role: "system", content: `Error: ${event.message}` },
            ]);
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
          {
            role: "system",
            content: `Connection error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ]);
      } finally {
        setLoading(false);
      }
    },
    [input, loading],
  );

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
    [loading, sessionId, sendMessage],
  );

  const handleSelectSession = useCallback(
    (id: string) => {
      if (id === sessionId) return;
      loadSession(id);
    },
    [sessionId, loadSession],
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
    [loadSession],
  );

  const handleThreadDeleted = useCallback(
    (deletedId: string) => {
      setThreadListRefetch((n) => n + 1);
      if (deletedId === sessionId) {
        setSessionId(null);
        setMessages([]);
        setCurrentAgentId(null);
      }
    },
    [sessionId],
  );

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
          <div
            ref={scrollContainerRef}
            className="chat-scroll flex-1 min-h-0 overflow-y-auto overflow-x-hidden"
            onScroll={handleScrollContainerScroll}
            data-testid="chat-scroll-container"
          >
            <div className="px-4 py-6 space-y-4 max-w-3xl mx-auto w-full">
              {isAgentOnlyThread && (
                <div className="rounded-lg bg-zinc-800/80 border border-zinc-700 px-4 py-2 text-sm text-zinc-400">
                  Agent-to-agent thread (read-only). Switch to a user thread to
                  send messages.
                </div>
              )}
              <ChatMessageList
                messages={messages}
                currentToken={currentToken}
                currentThinking={currentThinking}
                loading={loading}
                smartContextRun={smartContextRun}
                smartContextAfterMessageIndex={smartContextAfterMessageIndex}
                bottomRef={bottomRef}
                onResendMessage={
                  !isAgentOnlyThread ? handleResendMessage : undefined
                }
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

      {pendingQuestion && (
        <QuestionFormModal
          requestId={pendingQuestion.requestId}
          sessionId={pendingQuestion.sessionId}
          questions={pendingQuestion.questions}
          onSubmitted={() => setPendingQuestion(null)}
        />
      )}
    </div>
  );
}
