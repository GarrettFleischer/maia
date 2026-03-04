/**
 * @fileoverview Presentational message list for the chat UI (welcome state, bubbles, streaming, loading).
 * @module app/components/ChatMessageList
 *
 * @brief Renders welcome state, message bubbles (with markdown for agent/system), streaming token bubble,
 * smart context phase bubbles (UI-only, excluded from round selection), and loading indicator.
 */

import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { SmartContextPhase, SmartContextRun } from "@/lib/types";

/** Ordered smart context phases for live bubble display. Not part of message/round list. */
const SMART_CONTEXT_PHASES: { id: SmartContextPhase; label: string }[] = [
  { id: "clarified", label: "Clarified command" },
  { id: "queries", label: "Extracting queries" },
  { id: "retrieval", label: "Searching" },
  { id: "filter", label: "Filtering" },
  { id: "summary", label: "Summarizing" },
  { id: "done", label: "Done" },
];

/**
 * Returns display label for a phase, optionally using detail (e.g. filter + "skipped" → "Filter skipped").
 * @param phase - Current phase
 * @param detail - Optional detail from backend (e.g. "skipped", "3 sources")
 * @returns Label for the phase bubble
 */
function smartContextPhaseLabel(
  phase: SmartContextPhase,
  detail?: string,
): string {
  if (phase === "filter" && detail === "skipped") return "Filter skipped";
  if (phase === "done" && detail) return `Done (${detail})`;
  if (phase === "clarified") return "Clarified command";
  const entry = SMART_CONTEXT_PHASES.find((p) => p.id === phase);
  return entry?.label ?? phase;
}

/**
 * Renders a single smart context phase bubble (completed, active, or pending).
 * When output is provided, the bubble is clickable to show content in the detail panel.
 * @param label - Text to show in the bubble
 * @param status - "completed" | "active" | "pending"
 * @param output - Optional step output (click to show in detail panel)
 * @param isSelected - Whether this phase's content is currently shown in the detail panel
 * @param onClick - Called when the bubble is clicked (only when output is present)
 */
function SmartContextPhaseBubble({
  label,
  status,
  output,
  isSelected,
  onClick,
}: {
  label: string;
  status: "completed" | "active" | "pending";
  output?: string;
  isSelected?: boolean;
  onClick?: () => void;
}) {
  const className = `inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium border ${
    status === "completed"
      ? "bg-teal-950/50 text-teal-300 border-teal-800/60"
      : status === "active"
        ? "bg-teal-900/60 text-teal-100 border-teal-600/80"
        : "bg-zinc-800/60 text-zinc-500 border-zinc-700/80"
  } ${onClick ? "cursor-pointer hover:opacity-90" : ""} ${isSelected ? "ring-2 ring-teal-500 ring-offset-2 ring-offset-zinc-950" : ""}`;

  const content = (
    <>
      {status === "completed" && (
        <span className="text-teal-400 shrink-0" aria-hidden>
          ✓
        </span>
      )}
      {status === "active" && (
        <span
          className="inline-block w-2 h-2 rounded-full bg-teal-400 animate-pulse shrink-0"
          aria-hidden
        />
      )}
      <span>{label}</span>
    </>
  );

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        className={className}
        aria-pressed={isSelected}
        aria-label={`${label}, click to view details`}
      >
        {content}
      </button>
    );
  }
  return (
    <div
      className={className}
      aria-live="polite"
      aria-busy={status === "active"}
    >
      {content}
    </div>
  );
}

/**
 * Row of smart context phase bubbles from a preserved run. Click a bubble with output to show
 * its content in a single scrollable detail panel below. Excluded from round selection; UI-only.
 */
function SmartContextPhaseBubbles({
  run,
  loading,
}: {
  run: SmartContextRun;
  loading: boolean;
}) {
  const [selectedPhaseId, setSelectedPhaseId] =
    useState<SmartContextPhase | null>(null);
  const phases = run.phases;
  const lastPhase = phases[phases.length - 1];
  const currentPhase = lastPhase?.phase;
  const isComplete = run.doneDetail !== undefined;
  const currentPhaseIndex =
    currentPhase !== undefined
      ? SMART_CONTEXT_PHASES.findIndex((x) => x.id === currentPhase)
      : -1;

  const selectedPhaseData =
    selectedPhaseId != null
      ? phases.find((ph) => ph.phase === selectedPhaseId)
      : undefined;
  const selectedLabel =
    selectedPhaseId != null
      ? smartContextPhaseLabel(
          selectedPhaseId,
          selectedPhaseId === "done"
            ? run.doneDetail
            : selectedPhaseData?.detail,
        )
      : "";

  return (
    <div className="flex flex-col items-start gap-2 w-full max-w-[80%]">
      <div className="flex justify-start flex-wrap gap-2">
        {SMART_CONTEXT_PHASES.map((p, i) => {
          const phaseData = phases.find((ph) => ph.phase === p.id);
          const isCompleted =
            isComplete || (currentPhaseIndex >= 0 && currentPhaseIndex > i);
          const isActive = !isComplete && loading && currentPhase === p.id;
          const isPending = !isCompleted && !isActive;
          const status: "completed" | "active" | "pending" = isCompleted
            ? "completed"
            : isActive
              ? "active"
              : "pending";
          const label =
            phaseData && phaseData.phase === p.id
              ? smartContextPhaseLabel(
                  p.id,
                  p.id === "done" ? run.doneDetail : phaseData.detail,
                )
              : p.id === "filter"
                ? "Filtering"
                : p.label;
          return (
            <SmartContextPhaseBubble
              key={p.id}
              label={label}
              status={status}
              output={phaseData?.output}
              isSelected={selectedPhaseId === p.id}
              onClick={() =>
                setSelectedPhaseId((prev) => (prev === p.id ? null : p.id))
              }
            />
          );
        })}
      </div>
      {selectedPhaseId != null && (
        <div className="w-full rounded-lg border border-teal-700/80 bg-teal-950 overflow-hidden">
          <div className="flex items-center justify-between px-3 py-2 border-b border-teal-800/60 bg-teal-950/80">
            <span className="text-xs font-medium text-teal-200">
              {selectedLabel}
            </span>
            <button
              type="button"
              onClick={() => setSelectedPhaseId(null)}
              className="text-xs text-teal-400 hover:text-teal-200 px-1.5 py-0.5 rounded"
              aria-label="Close"
            >
              Close
            </button>
          </div>
          <div
            className="smart-context-detail-scroll max-h-64 overflow-auto px-3 py-2 text-xs text-teal-100 whitespace-pre-wrap"
            tabIndex={0}
          >
            {selectedPhaseData?.output ?? "(no output for this run)"}
          </div>
        </div>
      )}
    </div>
  );
}

/** Shared class for markdown message content (agent, system, streaming) so code and lists look consistent. */
const markdownContentClass =
  "markdown-chat space-y-2 [&_p]:my-0 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0 [&_ul]:my-2 [&_ol]:my-2 [&_pre]:my-2 [&_pre]:p-3 [&_pre]:rounded-lg [&_pre]:bg-zinc-900/80 [&_pre]:overflow-x-auto [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_code]:bg-zinc-900/80 [&_code]:text-zinc-300 [&_pre_code]:p-0 [&_pre_code]:bg-transparent";

/**
 * Renders a string as markdown with GFM (tables, strikethrough, etc.).
 * @param content - Raw markdown text.
 * @param className - Optional extra class names.
 */
function MarkdownContent({
  content,
  className = "",
}: {
  content: string;
  className?: string;
}) {
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

/** A regular message (user, agent, system), a standalone tool-call bubble, or a thinking (reasoning) bubble. */
export type ChatMessageListItem =
  | {
      role: "user" | "agent" | "system";
      content: string;
      toolCalls?: ToolCallDisplay[];
      resolvedContent?: string;
      roundIndex?: number;
    }
  | {
      role: "tool";
      tool: string;
      args: Record<string, unknown>;
      result?: unknown;
    }
  | { role: "thinking"; content: string };

export interface ChatMessageListProps {
  /** List of messages to show. */
  messages: ChatMessageListItem[];
  /** Current streaming token text (shown in a bubble with cursor). */
  currentToken: string;
  /** Current streaming thinking text (shown in a thinking bubble with cursor). */
  currentThinking?: string;
  /** Whether a request is in progress (shows loading dots when true and no currentToken/currentThinking). */
  loading: boolean;
  /** Preserved smart context run (phases + result). Shown when set; not cleared when agent responds. */
  smartContextRun?: SmartContextRun | null;
  /** When set, smart context is rendered right after the message at this index (below the user message that triggered it). */
  smartContextAfterMessageIndex?: number | null;
  /** Ref for the scroll anchor at the bottom. */
  bottomRef?: React.RefObject<HTMLDivElement | null>;
  /** When set, user messages show a re-send button; called with (index, content) to clear history after that message and re-post. */
  onResendMessage?: (index: number, content: string) => void;
}

/** ExecResult shape from terminal_exec and powershell_exec tools. */
interface ExecResultShape {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}

function isExecResult(r: unknown): r is ExecResultShape {
  return (
    r != null &&
    typeof r === "object" &&
    "stdout" in r &&
    "stderr" in r &&
    "exitCode" in r
  );
}

/** Single expandable tool-call bubble (args + optional result). */
function ToolCallBubble({
  tool,
  args,
  result,
}: {
  tool: string;
  args: Record<string, unknown>;
  result?: unknown;
}) {
  const renderResult = () => {
    if (result === undefined) return null;
    if (
      (tool === "terminal_exec" || tool === "powershell_exec") &&
      isExecResult(result)
    ) {
      return (
        <div className="space-y-2">
          {result.stdout != null && result.stdout !== "" && (
            <div>
              <span className="text-zinc-500">stdout</span>
              <pre className="mt-0.5 p-2 rounded bg-zinc-900/80 text-zinc-400 overflow-x-auto whitespace-pre-wrap break-all font-mono text-xs">
                {result.stdout}
              </pre>
            </div>
          )}
          {result.stderr != null && result.stderr !== "" && (
            <div>
              <span className="text-zinc-500">stderr</span>
              <pre className="mt-0.5 p-2 rounded bg-zinc-900/80 text-amber-400/90 overflow-x-auto whitespace-pre-wrap break-all font-mono text-xs">
                {result.stderr}
              </pre>
            </div>
          )}
          <div className="text-zinc-500">
            exit code:{" "}
            <span
              className={
                result.exitCode === 0 ? "text-emerald-400" : "text-red-400"
              }
            >
              {result.exitCode}
            </span>
          </div>
        </div>
      );
    }
    return (
      <pre className="mt-0.5 p-2 rounded bg-zinc-900/80 text-zinc-400 overflow-x-auto whitespace-pre-wrap break-all">
        {typeof result === "string" ? result : JSON.stringify(result, null, 2)}
      </pre>
    );
  };

  return (
    <details className="group max-w-[80%] rounded-xl rounded-bl-sm overflow-hidden bg-zinc-800/80 text-zinc-200 border border-zinc-700">
      <summary className="list-none cursor-pointer px-4 py-2.5 text-sm font-mono flex items-center gap-2 hover:bg-zinc-700/50 [&::-webkit-details-marker]:hidden">
        <span className="text-zinc-400 select-none">⚙</span>
        <span className="truncate">
          {tool}
          {Object.keys(args).length > 0 && (
            <span className="text-zinc-500 font-normal">
              {" "}
              ({JSON.stringify(args).slice(0, 40)}
              {JSON.stringify(args).length > 40 ? "…)" : ")"}
            </span>
          )}
        </span>
        <span className="ml-auto text-zinc-500 text-xs shrink-0" aria-hidden>
          ▾
        </span>
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
            {tool !== "terminal_exec" && tool !== "powershell_exec" && (
              <span className="text-zinc-500">result</span>
            )}
            {renderResult()}
          </div>
        )}
      </div>
    </details>
  );
}

/** Expandable bubble for model reasoning/thinking (persisted or streaming). */
function ThinkingBubble({
  content,
  streaming = false,
}: {
  content: string;
  streaming?: boolean;
}) {
  return (
    <details
      className="group max-w-[80%] rounded-xl rounded-bl-sm overflow-hidden bg-amber-950/40 text-amber-100/95 border border-amber-800/60"
      open={streaming}
    >
      <summary className="list-none cursor-pointer px-4 py-2.5 text-sm font-mono flex items-center gap-2 hover:bg-amber-900/30 [&::-webkit-details-marker]:hidden">
        <span className="text-amber-400/90 select-none">◆</span>
        <span className="truncate">Thinking</span>
        <span className="ml-auto text-amber-600 text-xs shrink-0" aria-hidden>
          ▾
        </span>
      </summary>
      <div className="px-4 pb-3 pt-0 text-xs font-mono border-t border-amber-800/60">
        <div className="mt-0.5 p-2 rounded bg-zinc-900/80 text-amber-200/90 overflow-x-auto whitespace-pre-wrap break-all">
          {content}
          {streaming && (
            <span
              className="inline-block w-1.5 h-4 bg-amber-400 ml-0.5 animate-pulse"
              aria-hidden
            />
          )}
        </div>
      </div>
    </details>
  );
}

export default function ChatMessageList({
  messages,
  currentToken,
  currentThinking = "",
  loading,
  smartContextRun,
  smartContextAfterMessageIndex,
  bottomRef,
  onResendMessage,
}: ChatMessageListProps) {
  const showSmartContextInPlace =
    smartContextRun != null &&
    typeof smartContextAfterMessageIndex === "number";
  const showSmartContextAtBottom =
    smartContextRun != null && !showSmartContextInPlace;

  return (
    <>
      {messages.length === 0 && (
        <div className="text-center text-zinc-500 mt-24">
          <div className="text-4xl mb-4">✦</div>
          <p className="text-lg font-medium text-zinc-300">Welcome to Maia</p>
          <p className="text-sm mt-2">
            Your personal AI agent system. Send a message to get started.
          </p>
        </div>
      )}

      {messages.map((msg, i) => (
        <div key={i} className="space-y-2">
          {msg.role === "user" || msg.role === "system" ? (
            <div
              className={`flex flex-col ${msg.role === "user" ? "items-end" : "items-start"}`}
            >
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
                  <MarkdownContent
                    content={msg.content}
                    className="text-red-200 [&_code]:bg-red-900/50 [&_pre]:bg-red-900/50"
                  />
                )}
              </div>
              {msg.role === "user" &&
                msg.resolvedContent &&
                msg.resolvedContent.trim() !== msg.content.trim() && (
                  <details className="mt-1 max-w-[80%] text-xs text-zinc-400">
                    <summary className="cursor-pointer select-none">
                      Clarified command
                      {typeof msg.roundIndex === "number"
                        ? ` (Round ${msg.roundIndex})`
                        : ""}
                    </summary>
                    <div className="mt-1 whitespace-pre-wrap rounded-md bg-zinc-900/80 px-3 py-2 text-zinc-300">
                      {msg.resolvedContent}
                    </div>
                  </details>
                )}
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
              <ToolCallBubble
                tool={msg.tool}
                args={msg.args}
                result={msg.result}
              />
            </div>
          ) : msg.role === "thinking" ? (
            <div className="flex justify-start">
              <ThinkingBubble content={msg.content} />
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
                  <ToolCallBubble
                    tool={tc.tool}
                    args={tc.args}
                    result={tc.result}
                  />
                </div>
              ))}
            </>
          )}
          {i === smartContextAfterMessageIndex && showSmartContextInPlace && (
            <div className="flex flex-col items-start gap-2">
              <span className="text-xs text-zinc-500">Smart context</span>
              <SmartContextPhaseBubbles
                run={smartContextRun}
                loading={loading}
              />
            </div>
          )}
        </div>
      ))}

      {showSmartContextAtBottom && smartContextRun ? (
        <div className="flex flex-col items-start gap-2">
          <span className="text-xs text-zinc-500">Smart context</span>
          <SmartContextPhaseBubbles run={smartContextRun} loading={loading} />
        </div>
      ) : null}

      {currentThinking ? (
        <div className="flex justify-start">
          <ThinkingBubble content={currentThinking} streaming />
        </div>
      ) : null}

      {currentToken ? (
        <div className="flex justify-start">
          <div className="max-w-[80%] rounded-2xl rounded-bl-sm px-4 py-3 bg-zinc-800 text-zinc-100 text-sm leading-relaxed">
            <MarkdownContent content={currentToken} />
            <span
              className="inline-block w-1.5 h-4 bg-violet-400 ml-0.5 animate-pulse"
              aria-hidden
            />
          </div>
        </div>
      ) : null}

      {loading && !currentToken && !currentThinking ? (
        <div className="flex justify-start">
          <div className="rounded-2xl rounded-bl-sm px-4 py-3 bg-zinc-800">
            <div className="flex gap-1">
              <div className="w-2 h-2 rounded-full bg-zinc-500 animate-bounce [animation-delay:0ms]" />
              <div className="w-2 h-2 rounded-full bg-zinc-500 animate-bounce [animation-delay:150ms]" />
              <div className="w-2 h-2 rounded-full bg-zinc-500 animate-bounce [animation-delay:300ms]" />
            </div>
          </div>
        </div>
      ) : null}

      {bottomRef ? <div ref={bottomRef} /> : null}
    </>
  );
}
