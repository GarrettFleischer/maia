/**
 * @fileoverview Presentational chat input (textarea + send button).
 * @module app/components/ChatInputBar
 *
 * @brief Renders the message input and submit button; callers wire value and onSubmit.
 */

export interface ChatInputBarProps {
  /** Current input value. */
  value: string;
  /** Called when the input value changes. */
  onChange: (value: string) => void;
  /** Called when the user submits (button click or Enter without Shift). */
  onSubmit: () => void;
  /** Disables the input and button when true. */
  disabled?: boolean;
  /** Placeholder text for the textarea. */
  placeholder?: string;
}

export default function ChatInputBar({
  value,
  onChange,
  onSubmit,
  disabled = false,
  placeholder = "Message Maia… (Enter to send, Shift+Enter for newline)",
}: ChatInputBarProps) {
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSubmit();
    }
  };

  return (
    <div className="border-t border-zinc-800 px-4 py-4">
      <div className="max-w-3xl mx-auto flex gap-3 items-end">
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          rows={1}
          className="flex-1 resize-none bg-zinc-800 rounded-xl px-4 py-3 text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-violet-600 max-h-40 overflow-y-auto"
        />
        <button
          type="button"
          onClick={onSubmit}
          disabled={disabled || !value.trim()}
          className="shrink-0 w-10 h-10 rounded-xl bg-violet-600 hover:bg-violet-500 disabled:bg-zinc-700 disabled:text-zinc-500 flex items-center justify-center transition-colors"
          aria-label="Send message"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <path d="M.5 1.163A1 1 0 0 1 1.97.28l12.868 6.837a1 1 0 0 1 0 1.766L1.969 15.72A1 1 0 0 1 .5 14.836V10.33a1 1 0 0 1 .816-.983L8.5 8 1.316 6.653A1 1 0 0 1 .5 5.67V1.163Z" />
          </svg>
        </button>
      </div>
    </div>
  );
}
