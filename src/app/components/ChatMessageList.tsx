/**
 * @fileoverview Presentational message list for the chat UI (welcome state, bubbles, streaming, loading).
 * @module app/components/ChatMessageList
 *
 * @brief Renders welcome state, message bubbles, streaming token bubble, and loading indicator.
 */

export interface ChatMessageListItem {
  role: "user" | "agent" | "system";
  content: string;
  toolCalls?: { tool: string; args: Record<string, unknown> }[];
}

export interface ChatMessageListProps {
  /** List of messages to show. */
  messages: ChatMessageListItem[];
  /** Current streaming token text (shown in a bubble with cursor). */
  currentToken: string;
  /** Whether a request is in progress (shows loading dots when true and no currentToken). */
  loading: boolean;
  /** Ref for the scroll anchor at the bottom. */
  bottomRef?: React.RefObject<HTMLDivElement | null>;
}

export default function ChatMessageList({
  messages,
  currentToken,
  loading,
  bottomRef,
}: ChatMessageListProps) {
  return (
    <>
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

      {bottomRef && <div ref={bottomRef} />}
    </>
  );
}
