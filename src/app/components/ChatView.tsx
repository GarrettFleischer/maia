/**
 * @fileoverview Chat view: list messages and input to send a new message.
 * Streams assistant replies for real-time feedback. Message content is rendered as Markdown.
 * @module app/components/ChatView
 */

"use client";

import { useAuth } from "./AuthGuard";
import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";
import {
  shouldShowThinkingIndicator,
  STREAMING_MESSAGE_ID,
} from "./chatViewHelpers";

type MessageRecord = {
  id: string;
  type: string;
  role: string | null;
  content: string | null;
  tool_name: string | null;
  tool_result: string | null;
  created_at: number;
};

export type ChatViewProps = {
  conversationId: string | null;
  agentId: string | null;
  /** When false, the send form is hidden and a read-only message is shown. */
  canSend?: boolean;
  /**
   * When set (e.g. for Internal chat), poll for new messages at this interval (ms) as a fallback
   * if SSE does not deliver (e.g. cross-worker). Only polls when tab is visible.
   */
  pollingFallbackMs?: number;
  /** When true, show a hint that this thread is the agent's internal monologue (talking to themselves). */
  isInternalThoughts?: boolean;
};

/** Markdown component overrides so rendered content uses app theme (vars) and fits chat layout. */
const markdownComponents: Components = {
  p: ({ children }) => <p style={{ margin: "0 0 0.5rem 0" }}>{children}</p>,
  ul: ({ children }) => (
    <ul style={{ margin: "0.25rem 0 0.5rem 1.25rem", padding: 0 }}>
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol style={{ margin: "0.25rem 0 0.5rem 1.25rem", padding: 0 }}>
      {children}
    </ol>
  ),
  li: ({ children }) => <li style={{ marginBottom: "0.25rem" }}>{children}</li>,
  code: ({ className, children, ...props }) => {
    const isBlock =
      typeof className === "string" && className.startsWith("language-");
    if (isBlock) {
      return (
        <pre
          style={{
            margin: "0.5rem 0",
            padding: "0.75rem",
            background: "var(--bg-tertiary)",
            border: "1px solid var(--border)",
            borderRadius: "4px",
            overflow: "auto",
            fontSize: "0.875rem",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          <code style={{ background: "none", padding: 0 }}>{children}</code>
        </pre>
      );
    }
    return (
      <code
        style={{
          background: "var(--bg-tertiary)",
          padding: "0.125rem 0.375rem",
          borderRadius: "4px",
          fontSize: "0.9em",
        }}
        {...props}
      >
        {children}
      </code>
    );
  },
  pre: ({ children }) => <>{children}</>,
  h1: ({ children }) => (
    <h1 style={{ fontSize: "1.25rem", margin: "0.5rem 0", fontWeight: 700 }}>
      {children}
    </h1>
  ),
  h2: ({ children }) => (
    <h2 style={{ fontSize: "1.1rem", margin: "0.5rem 0", fontWeight: 600 }}>
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3 style={{ fontSize: "1rem", margin: "0.5rem 0", fontWeight: 600 }}>
      {children}
    </h3>
  ),
  blockquote: ({ children }) => (
    <blockquote
      style={{
        margin: "0.5rem 0",
        paddingLeft: "1rem",
        borderLeft: "3px solid var(--border)",
        color: "var(--text-muted)",
      }}
    >
      {children}
    </blockquote>
  ),
  a: ({ href, children }) => (
    <a
      href={href ?? "#"}
      target="_blank"
      rel="noopener noreferrer"
      style={{ color: "var(--accent)" }}
    >
      {children}
    </a>
  ),
  table: ({ children }) => (
    <div style={{ overflow: "auto", margin: "0.5rem 0" }}>
      <table
        style={{
          borderCollapse: "collapse",
          width: "100%",
          fontSize: "0.9rem",
        }}
      >
        {children}
      </table>
    </div>
  ),
  th: ({ children }) => (
    <th
      style={{
        border: "1px solid var(--border)",
        padding: "0.375rem 0.5rem",
        textAlign: "left",
        background: "var(--bg-tertiary)",
      }}
    >
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td
      style={{ border: "1px solid var(--border)", padding: "0.375rem 0.5rem" }}
    >
      {children}
    </td>
  ),
  hr: () => (
    <hr
      style={{
        border: "none",
        borderTop: "1px solid var(--border)",
        margin: "0.75rem 0",
      }}
    />
  ),
};

export function ChatView({
  conversationId,
  canSend = true,
  pollingFallbackMs,
  isInternalThoughts = false,
}: ChatViewProps) {
  const { token } = useAuth();
  const [messages, setMessages] = useState<MessageRecord[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  /** Skip refetch while we are handling our own send so SSE doesn't overwrite optimistic state. */
  const sendInProgressRef = useRef(false);

  const loadMessages = useCallback(() => {
    if (!conversationId) {
      setMessages([]);
      return;
    }
    if (sendInProgressRef.current) return;
    fetch(`/api/conversations/${conversationId}/messages`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => (r.ok ? r.json() : []))
      .then((list: MessageRecord[]) => setMessages(list))
      .catch(() => setMessages([]));
  }, [token, conversationId]);

  useEffect(() => {
    loadMessages();
  }, [loadMessages]);

  useEffect(() => {
    if (!conversationId || !token) return;
    const url = `/api/events?conversationId=${encodeURIComponent(conversationId)}&token=${encodeURIComponent(token)}`;
    const es = new EventSource(url);
    const onMessage = () => loadMessages();
    es.onmessage = onMessage;
    return () => {
      es.onmessage = null;
      es.close();
    };
  }, [conversationId, token, loadMessages]);

  useEffect(() => {
    if (!conversationId || !pollingFallbackMs || pollingFallbackMs <= 0)
      return;
    const tick = () => {
      if (typeof document !== "undefined" && document.visibilityState === "visible") {
        loadMessages();
      }
    };
    const id = setInterval(tick, pollingFallbackMs);
    return () => clearInterval(id);
  }, [conversationId, pollingFallbackMs, loadMessages]);

  useEffect(() => {
    scrollContainerRef.current?.scrollTo({
      top: scrollContainerRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages]);

  async function handleSend() {
    if (!conversationId || !input.trim()) return;
    const text = input.trim();
    setInput("");
    setLoading(true);
    sendInProgressRef.current = true;
    abortRef.current = new AbortController();
    const signal = abortRef.current.signal;

    setMessages((prev) => [
      ...prev,
      {
        id: `user-${Date.now()}`,
        type: "user",
        role: "user",
        content: text,
        tool_name: null,
        tool_result: null,
        created_at: Date.now(),
      },
      {
        id: STREAMING_MESSAGE_ID,
        type: "assistant",
        role: "assistant",
        content: "",
        tool_name: null,
        tool_result: null,
        created_at: Date.now(),
      },
    ]);

    try {
      const res = await fetch(`/api/conversations/${conversationId}/send`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ content: text }),
        signal,
      });

      if (!res.ok || !res.body) {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === STREAMING_MESSAGE_ID
              ? { ...m, content: `[Request failed: ${res.status}]` }
              : m,
          ),
        );
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let streamedContent = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const data = JSON.parse(trimmed) as {
              delta?: string;
              done?: boolean;
              content?: string;
              error?: string;
            };
            if (data.delta !== undefined) {
              streamedContent += data.delta;
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === STREAMING_MESSAGE_ID
                    ? { ...m, content: streamedContent }
                    : m,
                ),
              );
            }
            if (data.done === true) {
              const final = data.content ?? data.error ?? streamedContent;
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === STREAMING_MESSAGE_ID
                    ? { ...m, id: `assistant-${Date.now()}`, content: final }
                    : m,
                ),
              );
            }
          } catch {
            // skip malformed line
          }
        }
      }
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      setMessages((prev) =>
        prev.map((m) =>
          m.id === STREAMING_MESSAGE_ID
            ? { ...m, content: `[Error: ${(e as Error).message}]` }
            : m,
        ),
      );
    } finally {
      setLoading(false);
      sendInProgressRef.current = false;
      abortRef.current = null;
    }
  }

  if (!conversationId) {
    return (
      <div style={{ padding: "2rem", color: "var(--text-muted)" }}>
        Select a conversation from the sidebar, or create one for an agent.
      </div>
    );
  }

  const isUser = (m: MessageRecord) => (m.role ?? m.type) === "user";

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
      }}
    >
      <div
        ref={scrollContainerRef}
        style={{ flex: 1, overflow: "auto", padding: "1rem" }}
      >
        {isInternalThoughts && (
          <p
            style={{
              margin: "0 0 1rem 0",
              fontSize: "0.8125rem",
              color: "var(--text-muted)",
            }}
          >
            This thread is your internal monologue—thoughts you had during heartbeat (talking to yourself).
          </p>
        )}
        {messages.map((m) => {
          const alignRight = isUser(m);
          return (
            <div
              key={m.id}
              style={{
                display: "flex",
                justifyContent: alignRight ? "flex-end" : "flex-start",
                marginBottom: "0.75rem",
              }}
            >
              <div
                style={{
                  maxWidth: "85%",
                  padding: "0.75rem 1rem",
                  borderRadius: "1rem",
                  ...(alignRight
                    ? {
                        background: "var(--accent)",
                        color: "var(--bg-primary)",
                      }
                    : {
                        background: "var(--bg-tertiary)",
                        color: "var(--text-primary)",
                        border: "1px solid var(--border)",
                      }),
                }}
              >
                {shouldShowThinkingIndicator(m) ? (
                  <div
                    className="thinking-dots"
                    style={{
                      display: "flex",
                      gap: "0.25rem",
                      alignItems: "center",
                    }}
                    aria-label="Thinking"
                  >
                    <span />
                    <span />
                    <span />
                  </div>
                ) : m.content != null && m.content.length > 0 ? (
                  <div
                    className="chat-message-content"
                    style={{ wordBreak: "break-word" }}
                  >
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      components={markdownComponents}
                    >
                      {m.content}
                    </ReactMarkdown>
                  </div>
                ) : m.tool_name ? (
                  <span
                    style={{ fontSize: "0.875rem", color: "var(--text-muted)" }}
                  >
                    [{m.tool_name}]
                  </span>
                ) : null}
                {m.tool_result != null && (
                  <pre
                    style={{
                      fontSize: "0.875rem",
                      marginTop: "0.25rem",
                      marginBottom: 0,
                      whiteSpace: "pre-wrap",
                      color: "var(--text-muted)",
                    }}
                  >
                    {m.tool_result}
                  </pre>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {canSend ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleSend();
          }}
          style={{
            padding: "0.5rem",
            borderTop: "1px solid var(--border)",
            display: "flex",
            gap: "0.5rem",
          }}
        >
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Message…"
            style={{
              flex: 1,
              padding: "0.5rem",
              background: "var(--bg-tertiary)",
              border: "1px solid var(--border)",
              color: "var(--text-primary)",
              borderRadius: "4px",
            }}
          />
          <button
            type="submit"
            disabled={loading}
            style={{
              padding: "0.5rem 1rem",
              background: "var(--accent)",
              color: "var(--bg-primary)",
              border: "none",
              borderRadius: "4px",
              cursor: "pointer",
              fontWeight: 600,
            }}
          >
            Send
          </button>
        </form>
      ) : (
        <div
          style={{
            padding: "0.75rem 1rem",
            borderTop: "1px solid var(--border)",
            color: "var(--text-muted)",
            fontSize: "0.875rem",
          }}
        >
          You can&apos;t send messages in this thread.
        </div>
      )}
    </div>
  );
}
