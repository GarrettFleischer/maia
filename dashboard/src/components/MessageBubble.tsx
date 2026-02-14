/**
 * @fileoverview Message bubble component for thread and chat views.
 * @module components/MessageBubble
 */

interface MessageBubbleProps {
  senderId: string;
  senderType: "user" | "agent" | "maia";
  content: string;
  createdAt: string;
  isUser?: boolean;
  /** When set, show "[Name] will remember that" below the bubble */
  remembered?: Record<string, string>;
  responderId?: string;
}

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
  responderId,
}: MessageBubbleProps) {
  const isCurrentUser = isUser ?? senderType === "user";
  const time = new Date(createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  const senderLabel = senderType === "maia" ? "🌙 Maia" : senderType === "agent" ? `🤖 ${senderId}` : "You";
  const rememberLabel =
    responderId === "maia" ? "Maia" : responderId ? `Agent ${responderId}` : "Maia";

  return (
    <div class={`flex flex-col ${isCurrentUser ? "items-end" : "items-start"} mb-3`}>
      <div class="flex items-center gap-2 mb-1">
        <span class="text-xs text-maia-text-dim">{senderLabel}</span>
        <span class="text-xs text-maia-text-dim opacity-60">{time}</span>
      </div>
      <div
        class={`max-w-[70%] rounded-xl px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap
          ${isCurrentUser
            ? "bg-maia-accent text-white rounded-br-sm"
            : "bg-maia-surface-light text-maia-text rounded-bl-sm"
          }`}
      >
        {content}
      </div>
      {remembered && Object.keys(remembered).length > 0 && !isCurrentUser && (
        <p class="mt-1 text-xs text-maia-text-dim italic">{rememberLabel} will remember that.</p>
      )}
    </div>
  );
}
