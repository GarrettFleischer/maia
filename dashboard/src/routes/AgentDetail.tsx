/**
 * @fileoverview Agent detail page with config, tasks, threads, and approved dashboard widgets.
 * @module routes/AgentDetail
 */

import { route } from "preact-router";
import { useEffect, useState } from "preact/hooks";
import { useAgentDetail } from "../hooks/use-agents.js";
import { useThreads } from "../hooks/use-threads.js";
import { TaskList } from "../components/TaskList.js";
import { StatusBadge } from "../components/StatusBadge.js";
import { removeAgentTask, fetchAgentDashboard } from "../lib/api-client.js";
import { wsClient } from "../lib/ws-client.js";
import type { AgentDashboardConfig, ApprovedDashboardWidget } from "../lib/types.js";

interface AgentDetailProps {
  path?: string;
  id?: string;
}

/**
 * @brief Builds srcdoc for a sandboxed iframe from approved widget HTML/CSS/JS.
 * Escapes closing tags in css/js to avoid breaking out of style/script.
 */
function widgetSrcdoc(w: ApprovedDashboardWidget): string {
  const escCss = (w.css ?? "").replace(/<\/style>/gi, "\\u003c/style>");
  const escJs = (w.js ?? "").replace(/<\/script>/gi, "\\u003c/script>");
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${escCss}</style></head><body>${w.html ?? ""}<script>${escJs}<\/script></body></html>`;
}

/**
 * @brief Renders a single approved widget in a sandboxed iframe (no same-origin, scripts only).
 */
function SandboxedWidget({ widget }: { widget: ApprovedDashboardWidget }) {
  const srcdoc = widgetSrcdoc(widget);
  return (
    <div class="border border-maia-border rounded-lg overflow-hidden bg-maia-surface-light">
      {(widget.name || widget.widgetId) && (
        <div class="px-3 py-2 text-xs font-medium text-maia-text-dim border-b border-maia-border">
          {widget.name ?? widget.widgetId}
        </div>
      )}
      <iframe
        title={widget.name ?? widget.widgetId}
        sandbox="allow-scripts"
        srcdoc={srcdoc}
        class="w-full min-h-[120px] border-0"
      />
    </div>
  );
}

/**
 * @brief Agent detail page showing config, tasks, threads, and approved dashboard widgets.
 */
export function AgentDetail({ id }: AgentDetailProps) {
  if (!id) return <p class="p-6 text-maia-error">Agent ID required.</p>;

  const { agent, loading, error, refresh } = useAgentDetail(id);
  const { threads } = useThreads(id);
  const [dashboard, setDashboard] = useState<AgentDashboardConfig | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchAgentDashboard(id)
      .then((data) => {
        if (!cancelled) setDashboard(data);
      })
      .catch(() => {
        if (!cancelled) setDashboard({ approvedWidgets: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  // Refetch dashboard when a widget is approved for this agent (live update without reload).
  useEffect(() => {
    const onWidgetApproved = (agentId: string) => {
      if (agentId !== id) return;
      fetchAgentDashboard(id).then(setDashboard).catch(() => {});
    };
    wsClient.addWidgetApprovedListener(onWidgetApproved);
    return () => wsClient.removeWidgetApprovedListener(onWidgetApproved);
  }, [id]);

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

      {/* Dashboard widgets (approved custom HTML/CSS/JS) */}
      {dashboard && dashboard.approvedWidgets.length > 0 && (
        <div class="bg-maia-surface border border-maia-border rounded-xl p-4 mb-6">
          <h2 class="text-sm font-medium text-maia-text-dim uppercase tracking-wider mb-3">
            Dashboard widgets ({dashboard.approvedWidgets.length})
          </h2>
          <div class="grid gap-4 sm:grid-cols-2">
            {dashboard.approvedWidgets.map((widget) => (
              <SandboxedWidget key={widget.id} widget={widget} />
            ))}
          </div>
        </div>
      )}

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
