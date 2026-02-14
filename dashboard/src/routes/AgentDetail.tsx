/**
 * @fileoverview Agent detail page with config, tasks, and threads.
 * @module routes/AgentDetail
 */

import { route } from "preact-router";
import { useAgentDetail } from "../hooks/use-agents.js";
import { useThreads } from "../hooks/use-threads.js";
import { TaskList } from "../components/TaskList.js";
import { StatusBadge } from "../components/StatusBadge.js";
import { removeAgentTask } from "../lib/api-client.js";

interface AgentDetailProps {
  path?: string;
  id?: string;
}

/**
 * @brief Agent detail page showing config, tasks, and related threads.
 */
export function AgentDetail({ id }: AgentDetailProps) {
  if (!id) return <p class="p-6 text-maia-error">Agent ID required.</p>;

  const { agent, loading, error, refresh } = useAgentDetail(id);
  const { threads } = useThreads(id);

  if (loading) {
    return (
      <div class="p-6">
        <p class="text-maia-text-dim">Loading agent...</p>
      </div>
    );
  }

  if (error || !agent) {
    return (
      <div class="p-6">
        <p class="text-maia-error">{error ?? "Agent not found"}</p>
      </div>
    );
  }

  const handleRemoveTask = async (taskId: string) => {
    try {
      await removeAgentTask(id, taskId);
      refresh();
    } catch (err) {
      console.error("Failed to remove task:", err);
    }
  };

  return (
    <div class="p-6 max-w-4xl">
      {/* Header */}
      <div class="flex items-center gap-4 mb-6">
        <span class="text-4xl">{agent.emoji}</span>
        <div>
          <h1 class="text-2xl font-semibold text-maia-text">{agent.name}</h1>
          <div class="flex items-center gap-3 mt-1">
            <span class="text-sm text-maia-text-dim">{agent.id}</span>
            <StatusBadge status={agent.isRunning ? "active" : "idle"} size="md" />
          </div>
        </div>
      </div>

      {/* Config section */}
      <div class="bg-maia-surface border border-maia-border rounded-xl p-4 mb-6">
        <h2 class="text-sm font-medium text-maia-text-dim uppercase tracking-wider mb-3">Configuration</h2>
        <div class="grid grid-cols-2 gap-4 text-sm">
          <div>
            <span class="text-maia-text-dim">Personality:</span>
            <p class="text-maia-text mt-0.5">{agent.personality}</p>
          </div>
          <div>
            <span class="text-maia-text-dim">Model:</span>
            <p class="text-maia-text mt-0.5">{agent.model.provider}/{agent.model.model}</p>
          </div>
          <div>
            <span class="text-maia-text-dim">Tools:</span>
            <p class="text-maia-text mt-0.5">{agent.tools.join(", ") || "None"}</p>
          </div>
          <div>
            <span class="text-maia-text-dim">Schedule:</span>
            <p class="text-maia-text mt-0.5">{agent.schedule || "None"}</p>
          </div>
          <div>
            <span class="text-maia-text-dim">Created by:</span>
            <p class="text-maia-text mt-0.5">{agent.createdBy}</p>
          </div>
          {agent.instructions && (
            <div class="col-span-2">
              <span class="text-maia-text-dim">Instructions:</span>
              <p class="text-maia-text mt-0.5">{agent.instructions}</p>
            </div>
          )}
        </div>
      </div>

      {/* Tasks section */}
      <div class="bg-maia-surface border border-maia-border rounded-xl p-4 mb-6">
        <h2 class="text-sm font-medium text-maia-text-dim uppercase tracking-wider mb-3">
          Tasks ({agent.tasks.length})
        </h2>
        <TaskList tasks={agent.tasks} onRemove={handleRemoveTask} />
      </div>

      {/* Threads section */}
      <div class="bg-maia-surface border border-maia-border rounded-xl p-4">
        <h2 class="text-sm font-medium text-maia-text-dim uppercase tracking-wider mb-3">
          Threads ({threads.length})
        </h2>
        {threads.length === 0 ? (
          <p class="text-sm text-maia-text-dim py-2">No conversation threads.</p>
        ) : (
          <div class="space-y-2">
            {threads.map((thread) => (
              <div
                key={thread.id}
                class="flex items-center justify-between p-3 bg-maia-surface-light border border-maia-border
                       rounded-lg cursor-pointer hover:bg-maia-border/30 transition-colors"
                onClick={() => route(`/threads/${thread.id}`)}
              >
                <div class="flex-1 min-w-0">
                  <p class="text-sm font-medium text-maia-text truncate">
                    {thread.title ?? thread.type}
                  </p>
                  <p class="text-xs text-maia-text-dim">
                    {thread.participants.join(", ")} • {new Date(thread.updatedAt).toLocaleString()}
                  </p>
                </div>
                <span class="text-xs text-maia-text-dim px-2 py-0.5 bg-maia-bg rounded-full">
                  {thread.type}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
