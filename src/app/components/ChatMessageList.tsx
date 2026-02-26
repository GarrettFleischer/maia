/**
 * @fileoverview Presentational message list for the chat UI (welcome state, bubbles, streaming, loading).
 * @module app/components/ChatMessageList
 *
 * @brief Renders welcome state, message bubbles (with markdown for agent/system), streaming token bubble, and loading indicator.
 */

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** Shared class for markdown message content (agent, system, streaming) so code and lists look consistent. */
const markdownContentClass =
  "markdown-chat space-y-2 [&_p]:my-0 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0 [&_ul]:my-2 [&_ol]:my-2 [&_pre]:my-2 [&_pre]:p-3 [&_pre]:rounded-lg [&_pre]:bg-zinc-900/80 [&_pre]:overflow-x-auto [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_code]:bg-zinc-900/80 [&_code]:text-zinc-300 [&_pre_code]:p-0 [&_pre_code]:bg-transparent";

/**
 * Renders a string as markdown with GFM (tables, strikethrough, etc.).
 * @param content - Raw markdown text.
 * @param className - Optional extra class names.
 */
function MarkdownContent({ content, className = "" }: { content: string; className?: string }) {
  return (
    <div className={`${markdownContentClass} ${className}`.trim()}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  );
}

/** Single tool call plus optional result for display. */
export interface ToolCallDisplay {
  tool: string;
  args: Record<string, unknown>;
  result?: unknown;
}

/** A regular message (user, agent, system) or a standalone tool-call bubble. */
export type ChatMessageListItem =
  | { role: "user" | "agent" | "system"; content: string; toolCalls?: ToolCallDisplay[] }
  | { role: "tool"; tool: string; args: Record<string, unknown>; result?: unknown };

export interface ChatMessageListProps {
  /** List of messages to show. */
  messages: ChatMessageListItem[];
  /** Current streaming token text (shown in a bubble with cursor). */
  currentToken: string;
  /** Whether a request is in progress (shows loading dots when true and no currentToken). */
  loading: boolean;
  /** Ref for the scroll anchor at the bottom. */
  bottomRef?: React.RefObject<HTMLDivElement | null>;
  /** When set, user messages show a re-send button; called with (index, content) to clear history after that message and re-post. */
  onResendMessage?: (index: number, content: string) => void;
}

/** Single expandable tool-call bubble (args + optional result). */
function ToolCallBubble({
  tool,
  args,
  result,
}: { tool: string; args: Record<string, unknown>; result?: unknown }) {
  return (
    <details className="group max-w-[80%] rounded-xl rounded-bl-sm overflow-hidden bg-zinc-800/80 text-zinc-200 border border-zinc-700">
      <summary className="list-none cursor-pointer px-4 py-2.5 text-sm font-mono flex items-center gap-2 hover:bg-zinc-700/50 [&::-webkit-details-marker]:hidden">
        <span className="text-zinc-400 select-none">⚙</span>
        <span className="truncate">
          {tool}
          {Object.keys(args).length > 0 && (
            <span className="text-zinc-500 font-normal">
              {" "}({JSON.stringify(args).slice(0, 40)}
              {JSON.stringify(args).length > 40 ? "…)" : ")"}
            </span>
          )}
        </span>
        <span className="ml-auto text-zinc-500 text-xs shrink-0" aria-hidden>▾</span>
      </summary>
      <div className="px-4 pb-3 pt-0 text-xs font-mono border-t border-zinc-700 space-y-2">
        <div>
          <span className="text-zinc-500">args</span>
          <pre className="mt-0.5 p-2 rounded bg-zinc-900/80 text-zinc-400 overflow-x-auto whitespace-pre-wrap break-all">
            {JSON.stringify(args, null, 2)}
          </pre>
        </div>
        {result !== undefined && (
          <div>
            <span className="text-zinc-500">result</span>
            <pre className="mt-0.5 p-2 rounded bg-zinc-900/80 text-zinc-400 overflow-x-auto whitespace-pre-wrap break-all">
              {typeof result === "string" ? result : JSON.stringify(result, null, 2)}
            </pre>
          </div>
        )}
      </div>
    </details>
  );
}

export default function ChatMessageList({
  messages,
  currentToken,
  loading,
  bottomRef,
  onResendMessage,
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
        <div key={i} className="space-y-2">
          {msg.role === "user" || msg.role === "system" ? (
            <div className={`flex flex-col ${msg.role === "user" ? "items-end" : "items-start"}`}>
              <div
                className={`max-w-[80%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${
                  msg.role === "user"
                    ? "bg-violet-600 text-white rounded-br-sm"
                    : "bg-red-900/50 text-red-200 border border-red-800 rounded-lg"
                }`}
              >
                {msg.role === "user" ? (
                  <div className="whitespace-pre-wrap">{msg.content}</div>
                ) : (
                  <MarkdownContent content={msg.content} className="text-red-200 [&_code]:bg-red-900/50 [&_pre]:bg-red-900/50" />
                )}
              </div>
              {msg.role === "user" && onResendMessage && (
                <button
                  type="button"
                  onClick={() => onResendMessage(i, msg.content)}
                  disabled={loading}
                  className="mt-1 text-xs text-zinc-500 hover:text-violet-400 disabled:opacity-50"
                  aria-label="Re-send this message"
                >
                  Re-send
                </button>
              )}
            </div>
          ) : msg.role === "tool" ? (
            <div className="flex justify-start">
              <ToolCallBubble tool={msg.tool} args={msg.args} result={msg.result} />
            </div>
          ) : (
            <>
              {msg.content ? (
                <div className="flex justify-start">
                  <div className="max-w-[80%] rounded-2xl rounded-bl-sm px-4 py-3 text-sm leading-relaxed bg-zinc-800 text-zinc-100">
                    <MarkdownContent content={msg.content} />
                  </div>
                </div>
              ) : null}
              {msg.toolCalls?.map((tc, j) => (
                <div key={`${i}-tool-${j}`} className="flex justify-start">
                  <ToolCallBubble tool={tc.tool} args={tc.args} result={tc.result} />
                </div>
              ))}
            </>
          )}
        </div>
      ))}

      {currentToken && (
        <div className="flex justify-start">
          <div className="max-w-[80%] rounded-2xl rounded-bl-sm px-4 py-3 bg-zinc-800 text-zinc-100 text-sm leading-relaxed">
            <MarkdownContent content={currentToken} />
            <span className="inline-block w-1.5 h-4 bg-violet-400 ml-0.5 animate-pulse" aria-hidden />
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
