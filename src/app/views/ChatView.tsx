"use client";

/**
 * @fileoverview Chat view: thread list sidebar, message list, input, send; subscribes to /api/events
 * so server-driven (async) agent messages update the UI. Rendered inside the app shell so state is preserved when switching tabs.
 * @module app/views/ChatView
 */

import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import type {
  SSEEvent,
  SmartContextRun,
  SmartContextRunEntry,
} from "@/lib/types";
import type { HistoryEntry } from "@/lib/types";
import ChatMessageList from "@/app/components/ChatMessageList";
import type { ChatMessageListItem } from "@/app/components/ChatMessageList";
import ChatInputBar from "@/app/components/ChatInputBar";
import ThreadList from "@/app/components/ThreadList";
import type { QuestionItem } from "@/app/components/QuestionFormModal";

/** Map HistoryEntry from server to ChatMessageListItem (including tool_call as standalone tool bubble, thinking as reasoning bubble). Do not pass smart_context entries. */
function entryToItem(entry: HistoryEntry): ChatMessageListItem {
  if (entry.role === "tool_call") {
    if (entry.toolName === "ask_user") {
      try {
        const parsed = JSON.parse(entry.content) as {
          questions?: QuestionItem[];
          answers?: Record<string, string>;
        };
        if (
          Array.isArray(parsed.questions) &&
          parsed.answers &&
          typeof parsed.answers === "object"
        ) {
          return {
            role: "user_input",
            questions: parsed.questions,
            status: "answered",
            answers: parsed.answers,
          };
        }
      } catch {
        // Fall through to generic tool bubble when content is not valid JSON.
      }
    }
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
    speakerLabel: entry.speakerLabel,
    speakerId: entry.speakerId,
  };
}

type SessionType = "user" | "agents";

interface ActiveSessionResponse {
  sessionId?: string;
  session?: {
    original: HistoryEntry[];
    type?: SessionType;
    participants?: string[];
    /** Smart context runs per round; used to restore all phase bubbles on refresh. */
    smartContextRuns?: SmartContextRunEntry[];
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

/**
 * @brief Chat view content: thread list, messages, input. No header (shell provides it).
 * @returns Fragment with thread list and chat area for the app shell to show/hide.
 */
export default function ChatView() {
  const [messages, setMessages] = useState<ChatMessageListItem[]>([]);
  const [input, setInput] = useState("");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessionType, setSessionType] = useState<SessionType>("user");
  const [currentAgentId, setCurrentAgentId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [currentToken, setCurrentToken] = useState("");
  const [currentThinking, setCurrentThinking] = useState("");
  /** Smart context runs per round (afterMessageIndex + run). Restored on load; current run appended when sending. */
  const [smartContextRuns, setSmartContextRuns] = useState<
    SmartContextRunEntry[]
  >([]);
  const [threadListRefetch, setThreadListRefetch] = useState(0);
  const [userIsAtBottom, setUserIsAtBottom] = useState(true);
  /** When set, user is editing a previous message at this index; next send replaces history after it. */
  const [editingMessageIndex, setEditingMessageIndex] = useState<number | null>(
    null,
  );
  const userIsAtBottomRef = useRef(true);
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const sessionIdRef = useRef<string | null>(null);
  const loadingRef = useRef(false);
  const currentAgentIdRef = useRef<string | null>(null);
  const thinkingAccumulatorRef = useRef("");
  /** Accumulates the current run during streaming so phase updates don't depend on state timing. */
  const streamingRunRef = useRef<SmartContextRun | null>(null);
  /** afterMessageIndex for the run being streamed; used so phase events update the correct run (follow-up messages). */
  const streamingAfterMessageIndexRef = useRef<number | null>(null);
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
    setSmartContextRuns(data.session?.smartContextRuns ?? []);
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
        }
        setSmartContextRuns(data.session?.smartContextRuns ?? []);
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
          if (loadingRef.current && payload.entry.role === "tool_call") {
            return;
          }
          if (payload.entry.role === "smart_context") {
            try {
              const run = JSON.parse(payload.entry.content) as SmartContextRun;
              setSmartContextRuns((prev) => {
                if (prev.length === 0) return prev;
                return [
                  ...prev.slice(0, -1),
                  { ...prev[prev.length - 1]!, run },
                ];
              });
            } catch {
              // ignore malformed
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
            setMessages((prev) => [
              ...prev,
              {
                role: "user_input",
                requestId: data.requestId,
                sessionId: data.sessionId,
                questions: data.questions,
                status: "pending",
              },
            ]);
          }
        }
      } catch {
        // ignore malformed
      }
    });
    es.addEventListener("ping", () => {});
    return () => es.close();
  }, []);

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
      const isEditing = editingMessageIndex != null;
      const editIndex = editingMessageIndex;
      setEditingMessageIndex(null);

      if (isEditing && sessionIdRef.current && typeof editIndex === "number") {
        try {
          const truncateRes = await fetch(
            `/api/sessions/${sessionIdRef.current}/history/truncate`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ keepThroughIndex: editIndex - 1 }),
            },
          );
          if (!truncateRes.ok) {
            setLoading(false);
            return;
          }
        } catch {
          setLoading(false);
          return;
        }
      }

      const placeholderRun: SmartContextRun = {
        phases: [],
        doneDetail: undefined,
      };
      streamingRunRef.current = placeholderRun;
      setMessages((prev) => {
        const base =
          isEditing && typeof editIndex === "number"
            ? prev.slice(0, editIndex)
            : prev;
        const newIndex = base.length;
        streamingAfterMessageIndexRef.current = newIndex;
        setSmartContextRuns((runs) => {
          const filtered =
            isEditing && typeof editIndex === "number"
              ? runs.filter((r) => r.afterMessageIndex < editIndex)
              : runs;
          return [
            ...filtered,
            {
              afterMessageIndex: newIndex,
              run: placeholderRun,
            },
          ];
        });
        return [...base, { role: "user", content: text }];
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
            event = JSON.parse(data) as SSEEvent;
          } catch {
            return;
          }

          if (event.type === "smart_context_phase") {
            const current = streamingRunRef.current;
            if (current) {
              const prevPhases = current.phases ?? [];
              const last = prevPhases[prevPhases.length - 1];
              const phase = event.phase;
              const detail = event.detail;
              const output = event.output;
              const fullPrompt = event.fullPrompt;
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
              const doneDetail = phase === "done" ? detail : current.doneDetail;
              streamingRunRef.current = {
                ...current,
                phases,
                doneDetail,
                ...(phase === "done" &&
                  fullPrompt !== undefined && { fullPrompt }),
              };
            }
            const targetIndex = streamingAfterMessageIndexRef.current;
            setSmartContextRuns((prev) => {
              const run = streamingRunRef.current;
              if (run == null) return prev;
              if (targetIndex === null) return prev;
              const idx = prev.findIndex(
                (e) => e.afterMessageIndex === targetIndex,
              );
              const entry = {
                afterMessageIndex: targetIndex,
                run,
              };
              if (idx >= 0) {
                return [...prev.slice(0, idx), entry, ...prev.slice(idx + 1)];
              }
              return [...prev, entry];
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
        streamingRunRef.current = null;
        streamingAfterMessageIndexRef.current = null;
        setLoading(false);
      }
    },
    [input, loading, editingMessageIndex],
  );

  const handleEditMessage = useCallback(
    (index: number, _content: string) => {
      if (loading) return;
      setEditingMessageIndex(index);
      setInput("");
    },
    [loading],
  );

  const handleSaveEdit = useCallback(
    (content: string) => {
      if (!content.trim() || loading) return;
      sendMessage(content);
    },
    [loading, sendMessage],
  );

  const handleCancelEdit = useCallback(() => {
    setEditingMessageIndex(null);
  }, []);

  const handleUserInputAnswered = useCallback(
    (requestId: string, answers: Record<string, string>) => {
      setMessages((prev) =>
        prev.map((msg) =>
          msg.role === "user_input" && msg.requestId === requestId
            ? { ...msg, status: "answered", answers }
            : msg,
        ),
      );
    },
    [],
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
        setSmartContextRuns([]);
        setCurrentAgentId(null);
      }
    },
    [sessionId],
  );

  const isAgentOnlyThread = sessionType === "agents";

  const displayMessages = useMemo(() => {
    const list: ChatMessageListItem[] = [];
    const lastRunIndex =
      smartContextRuns.length > 0
        ? smartContextRuns[smartContextRuns.length - 1]!.afterMessageIndex
        : null;
    const hideRunsAtOrAfter =
      editingMessageIndex != null ? editingMessageIndex : -1;
    for (let i = 0; i < messages.length; i++) {
      const item = messages[i];
      if (item.role === "user") {
        list.push({ ...item, conversationIndex: i });
      } else {
        list.push(item);
      }
      const runEntry = smartContextRuns.find((r) => r.afterMessageIndex === i);
      if (
        runEntry != null &&
        (hideRunsAtOrAfter < 0 ||
          runEntry.afterMessageIndex < hideRunsAtOrAfter)
      ) {
        list.push({
          role: "smart_context",
          run: runEntry.run,
          loading: loading && lastRunIndex === i,
        });
      }
    }
    return list;
  }, [messages, smartContextRuns, loading, editingMessageIndex]);

  return (
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
              messages={displayMessages}
              currentToken={currentToken}
              currentThinking={currentThinking}
              loading={loading}
              bottomRef={bottomRef}
              onEditMessage={!isAgentOnlyThread ? handleEditMessage : undefined}
              editingMessageIndex={
                !isAgentOnlyThread ? editingMessageIndex : null
              }
              onSaveEdit={!isAgentOnlyThread ? handleSaveEdit : undefined}
              onCancelEdit={!isAgentOnlyThread ? handleCancelEdit : undefined}
              onUserInputAnswered={handleUserInputAnswered}
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
  );
}
