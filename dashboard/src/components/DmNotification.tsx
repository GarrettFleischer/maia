/**
 * @fileoverview Toast notification component for agent DMs.
 * @module components/DmNotification
 */

import { route } from "preact-router";
import type { AgentDm } from "../lib/types.js";

interface DmNotificationProps {
  notifications: AgentDm[];
  onDismiss: (index: number) => void;
}

/**
 * @brief Renders toast notifications for agent DMs (top-right overlay).
 * @param props - Notification list and dismiss handler
 * @returns Preact element
 */
export function DmNotification({ notifications, onDismiss }: DmNotificationProps) {
  if (notifications.length === 0) return null;

  return (
    <div class="fixed top-4 right-4 z-50 space-y-2 max-w-sm">
      {notifications.map((dm, index) => (
        <div
          key={`${dm.threadId}-${index}`}
          class="bg-maia-surface border border-maia-border rounded-xl p-4 shadow-lg
                 animate-[slideIn_0.3s_ease-out] cursor-pointer hover:bg-maia-surface-light
                 transition-colors"
          onClick={() => {
            route(`/threads/${dm.threadId}`);
            onDismiss(index);
          }}
        >
          <div class="flex items-start justify-between gap-2">
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-1.5 mb-1">
                <span class="text-sm font-medium text-maia-accent">
                  {dm.agentId === "maia" ? "🌙" : "🤖"} {dm.agentName}
                </span>
              </div>
              <p class="text-sm text-maia-text line-clamp-2">{dm.content}</p>
            </div>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onDismiss(index);
              }}
              class="text-maia-text-dim hover:text-maia-text text-xs p-1"
            >
              ✕
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
