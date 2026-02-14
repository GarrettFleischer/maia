/**
 * @fileoverview Task list component for displaying agent tasks.
 * @module components/TaskList
 */

import type { AgentTask } from "../lib/types.js";

interface TaskListProps {
  tasks: AgentTask[];
  onRemove?: (taskId: string) => void;
}

const STATUS_STYLES = {
  pending: "bg-maia-warning/20 text-maia-warning",
  completed: "bg-maia-success/20 text-maia-success",
  failed: "bg-maia-error/20 text-maia-error",
};

/**
 * @brief Renders a list of agent tasks with status and schedule info.
 * @param props - Tasks array and optional remove handler
 * @returns Preact element
 */
export function TaskList({ tasks, onRemove }: TaskListProps) {
  if (tasks.length === 0) {
    return <p class="text-sm text-maia-text-dim py-4">No tasks scheduled.</p>;
  }

  return (
    <div class="space-y-2">
      {tasks.map((task) => (
        <div
          key={task.id}
          class="bg-maia-surface-light border border-maia-border rounded-lg p-3"
        >
          <div class="flex items-start justify-between gap-2">
            <div class="flex-1 min-w-0">
              <p class="text-sm font-medium text-maia-text">{task.description}</p>
              <div class="flex items-center gap-3 mt-1.5">
                <span class={`text-xs px-2 py-0.5 rounded-full ${STATUS_STYLES[task.status]}`}>
                  {task.status}
                </span>
                <span class="text-xs text-maia-text-dim">
                  {task.recurring && task.recurring !== "once" ? `🔁 ${task.recurring}` : "⏱ Once"}
                </span>
                <span class="text-xs text-maia-text-dim">
                  📅 {new Date(task.scheduledAt).toLocaleString()}
                </span>
              </div>
              {task.lastRunAt && (
                <p class="text-xs text-maia-text-dim mt-1">
                  Last run: {new Date(task.lastRunAt).toLocaleString()}
                </p>
              )}
            </div>
            {onRemove && task.status !== "completed" && (
              <button
                onClick={() => onRemove(task.id)}
                class="text-xs text-maia-error hover:text-red-400 p-1"
              >
                Remove
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
