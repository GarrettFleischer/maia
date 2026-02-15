/**
 * @fileoverview Message bubble component for thread and chat views.
 * @module components/MessageBubble
 *
 * @brief Renders message content as markdown and shows "will remember that"
 * with a lightbulb icon and hover tooltip for remembered content.
 */

import { MarkdownContent } from "./MarkdownContent.js";

interface MessageBubbleProps {
  senderId: string;
  senderType: "user" | "agent" | "maia";
  content: string;
  createdAt: string;
  isUser?: boolean;
  /** When set, show "[Name] will remember that" with lightbulb; hover shows what was remembered */
  remembered?: Record<string, string>;
  /** When set, show tool call summaries (e.g. "Created agent wally") below the message, like "will remember that" */
  toolCallsSummary?: string[];
  responderId?: string;
}

const REMEMBERED_LABELS: Record<string, string> = {
  memoryMd: "MEMORY.md",
  userMd: "USER.md",
  soulMd: "SOUL.md",
};

/**
 * @brief Renders a single message bubble with sender info and timestamp.
 * @param props - Message data
 * @returns Preact element
 */
export function MessageBubble({
  senderId,
  senderType,
  content,
  createdAt,
  isUser,
  remembered,
  toolCallsSummary,
  responderId,
}: MessageBubbleProps) {
  const isCurrentUser = isUser ?? senderType === "user";
  const time = new Date(createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  const senderLabel = senderType === "maia" ? "🌙 Maia" : senderType === "agent" ? `🤖 ${senderId}` : "You";
  const rememberLabel =
    responderId === "maia" ? "Maia" : responderId ? `Agent ${responderId}` : "Maia";

  const hasRemembered = remembered && Object.keys(remembered).length > 0;
  const hasToolCalls = toolCallsSummary && toolCallsSummary.length > 0;
  const tooltipParts =
    hasRemembered &&
    Object.entries(remembered)
      .filter(([, v]) => v != null && String(v).trim() !== "")
      .map(([k, v]) => `${REMEMBERED_LABELS[k] ?? k}:\n${String(v).trim()}`);

  return (
    <div class={`flex flex-col ${isCurrentUser ? "items-end" : "items-start"} mb-3`}>
      <div class="flex items-center gap-2 mb-1">
        <span class="text-xs text-maia-text-dim">{senderLabel}</span>
        <span class="text-xs text-maia-text-dim opacity-60">{time}</span>
      </div>
      <div
        class={`max-w-[70%] rounded-xl px-4 py-2.5 text-sm leading-relaxed
          ${isCurrentUser
            ? "bg-maia-accent text-white rounded-br-sm"
            : "bg-maia-surface-light text-maia-text rounded-bl-sm"
          }`}
      >
        <MarkdownContent
          content={content}
          class="message-bubble-markdown wrap-break-word [&_a]:underline [&_code]:bg-black/10 [&_code]:px-1 [&_code]:rounded [&_pre]:overflow-x-auto [&_pre]:my-1 [&_ul]:list-disc [&_ul]:pl-4 [&_ol]:list-decimal [&_ol]:pl-4"
        />
      </div>
      {hasRemembered && !isCurrentUser && (
        <div class="mt-1 flex items-center gap-1.5 group relative">
          <span class="text-xs text-maia-text-dim italic" title={tooltipParts ? tooltipParts.join("\n\n") : undefined}>
            <span class="align-middle" aria-hidden="true">💡</span>
            <span class="ml-1 align-middle">{rememberLabel} will remember that.</span>
          </span>
          {tooltipParts && tooltipParts.length > 0 && (
            <div
              class="absolute left-0 bottom-full mb-1 invisible group-hover:visible z-10
                max-w-sm rounded-lg border border-maia-border bg-maia-surface px-3 py-2
                text-xs text-maia-text shadow-lg whitespace-pre-wrap pointer-events-none"
              role="tooltip"
            >
              {tooltipParts.map((part, i) => (
                <div key={i} class="mb-2 last:mb-0">{part}</div>
              ))}
            </div>
          )}
        </div>
      )}
      {hasToolCalls && !isCurrentUser && (
        <div class="mt-1 flex items-center gap-1.5">
          <span class="text-xs text-maia-text-dim italic">
            <span class="align-middle" aria-hidden="true">🔧</span>
            <span class="ml-1 align-middle">
              {toolCallsSummary!.join(". ")}.
            </span>
          </span>
        </div>
      )}
    </div>
  );
}
