/**
 * @fileoverview Thread list page showing all conversation threads.
 * @module routes/Threads
 */

import { route } from "preact-router";
import { useThreads } from "../hooks/use-threads.js";

const TYPE_LABELS: Record<string, string> = {
  "user-maia": "💬 User ↔ Maia",
  "user-agent": "💬 User ↔ Agent",
  "agent-agent": "🤝 Agent ↔ Agent",
  "agent-dm": "📩 Agent DM",
  "maia-agent-checkin": "📋 Maia Check-in",
};

interface ThreadsProps {
  path?: string;
}

/**
 * @brief Thread list page with filtering support.
 */
export function Threads(_props: ThreadsProps) {
  const { threads, loading, error } = useThreads();

  if (loading) {
    return (
      <div class="p-6">
        <h1 class="text-2xl font-semibold text-maia-text mb-6">Threads</h1>
        <p class="text-maia-text-dim">Loading threads...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div class="p-6">
        <h1 class="text-2xl font-semibold text-maia-text mb-6">Threads</h1>
        <p class="text-maia-error">{error}</p>
      </div>
    );
  }

  return (
    <div class="p-6 max-w-4xl">
      <h1 class="text-2xl font-semibold text-maia-text mb-6">Threads</h1>

      {threads.length === 0 ? (
        <div class="bg-maia-surface border border-maia-border rounded-xl p-8 text-center">
          <p class="text-4xl mb-3">🧵</p>
          <p class="text-maia-text mb-2">No threads yet</p>
          <p class="text-sm text-maia-text-dim">
            Conversation threads will appear here as agents communicate.
          </p>
        </div>
      ) : (
        <div class="space-y-2">
          {threads.map((thread) => (
            <div
              key={thread.id}
              class="bg-maia-surface border border-maia-border rounded-xl p-4 cursor-pointer
                     hover:bg-maia-surface-light hover:border-maia-accent/30 transition-all"
              onClick={() => route(`/threads/${thread.id}`)}
            >
              <div class="flex items-center justify-between mb-2">
                <h3 class="text-sm font-medium text-maia-text">
                  {thread.title ?? `Thread ${thread.id.slice(0, 8)}`}
                </h3>
                <span class="text-xs text-maia-text-dim px-2 py-0.5 bg-maia-bg rounded-full">
                  {TYPE_LABELS[thread.type] ?? thread.type}
                </span>
              </div>
              <div class="flex items-center gap-3 text-xs text-maia-text-dim">
                <span>👥 {thread.participants.join(", ")}</span>
                <span>📅 {new Date(thread.updatedAt).toLocaleString()}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
