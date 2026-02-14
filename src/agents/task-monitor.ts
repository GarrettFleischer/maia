/**
 * @fileoverview Timer-based task monitor that scans agents' tasks.json files
 * and fires due tasks through the priority LLM queue. Uses setInterval (not cron).
 * @module agents/task-monitor
 *
 * @note Each agent can have a tasks.json file in its workspace directory.
 * The monitor periodically reads these files, checks for due tasks, and
 * enqueues them for execution at "agent" priority.
 */

import type { FileSystem, Clock, Logger, CryptoProvider } from "../core/types.js";

/**
 * @brief Recurring schedule options for agent tasks.
 */
export type TaskRecurrence = "once" | "hourly" | "daily" | "weekly" | null;

/**
 * @brief A single task entry in an agent's tasks.json.
 */
export interface AgentTask {
  /** Unique task identifier */
  id: string;
  /** Human-readable description of what this task does */
  description: string;
  /** ISO datetime string for when this task should run */
  scheduledAt: string;
  /** Recurrence pattern: once, hourly, daily, weekly, or null for one-shot */
  recurring: TaskRecurrence;
  /** Task status */
  status: "pending" | "completed" | "failed";
  /** The prompt to send to the agent when the task fires */
  prompt: string;
  /** ISO datetime of when the task was created */
  createdAt: string;
  /** ISO datetime of the last run, or null if never run */
  lastRunAt: string | null;
}

/**
 * @brief Called when a task becomes due.
 * @param agentId - The agent this task belongs to
 * @param task - The due task
 */
export type TaskDueHandler = (agentId: string, task: AgentTask) => Promise<void>;

/**
 * @brief Dependencies for createTaskMonitor.
 */
export interface TaskMonitorDeps {
  fs: FileSystem;
  clock: Clock;
  crypto: CryptoProvider;
  logger: Logger;
  /** Function that returns all active agent IDs and their workspace paths */
  getAgentWorkspaces: () => Map<string, string>;
  /** Polling interval in milliseconds (default: 30000 = 30s) */
  checkIntervalMs?: number;
}

/**
 * @brief Task monitor interface.
 */
export interface TaskMonitor {
  /**
   * @brief Starts the polling loop. Calls handler for each due task.
   * @param handler - Callback invoked when a task is due
   */
  start(handler: TaskDueHandler): void;

  /**
   * @brief Stops the polling loop.
   */
  stop(): void;

  /**
   * @brief Reads an agent's tasks.json and returns its tasks.
   * @param agentId - Agent identifier
   * @returns Array of agent tasks, or empty array if no tasks.json
   */
  getTasks(agentId: string): Promise<AgentTask[]>;

  /**
   * @brief Writes tasks back to an agent's tasks.json.
   * @param agentId - Agent identifier
   * @param tasks - Tasks to write
   */
  writeTasks(agentId: string, tasks: AgentTask[]): Promise<void>;

  /**
   * @brief Adds a task to an agent's tasks.json.
   * @param agentId - Agent identifier
   * @param task - Task to add (id and createdAt will be generated if missing)
   * @returns The added task with generated fields
   */
  addTask(agentId: string, task: Omit<AgentTask, "id" | "createdAt" | "lastRunAt" | "status">): Promise<AgentTask>;

  /**
   * @brief Removes a task from an agent's tasks.json.
   * @param agentId - Agent identifier
   * @param taskId - Task ID to remove
   * @returns True if removed, false if not found
   */
  removeTask(agentId: string, taskId: string): Promise<boolean>;
}

/**
 * @brief Checks if a task is currently due based on its schedule and recurrence.
 * @param task - The task to check
 * @param now - Current time
 * @returns True if the task should run now
 */
function isTaskDue(task: AgentTask, now: Date): boolean {
  if (task.status !== "pending") return false;

  const scheduledTime = new Date(task.scheduledAt);
  if (now < scheduledTime) return false;

  // For one-shot tasks, fire if due and never run
  if (!task.recurring || task.recurring === "once") {
    return !task.lastRunAt;
  }

  // For recurring tasks, check if enough time has passed since last run
  if (task.lastRunAt) {
    const lastRun = new Date(task.lastRunAt);
    const elapsedMs = now.getTime() - lastRun.getTime();

    switch (task.recurring) {
      case "hourly":
        return elapsedMs >= 60 * 60 * 1000;
      case "daily":
        return elapsedMs >= 24 * 60 * 60 * 1000;
      case "weekly":
        return elapsedMs >= 7 * 24 * 60 * 60 * 1000;
      default:
        return false;
    }
  }

  // Recurring task that has never run and is past scheduled time
  return true;
}

/**
 * @brief Creates a task monitor instance.
 * @param deps - Dependencies: fs, clock, crypto, logger, getAgentWorkspaces
 * @returns TaskMonitor instance
 *
 * @example
 * const monitor = createTaskMonitor({
 *   fs, clock, crypto, logger,
 *   getAgentWorkspaces: () => activeAgentPaths,
 * });
 * monitor.start(async (agentId, task) => {
 *   await agentRuntime.handleMessage({ ... task.prompt ... });
 * });
 */
export function createTaskMonitor(deps: TaskMonitorDeps): TaskMonitor {
  const { fs, clock, crypto, logger, getAgentWorkspaces, checkIntervalMs = 30000 } = deps;
  let pollInterval: ReturnType<typeof setInterval> | null = null;

  function tasksPath(workspacePath: string): string {
    return `${workspacePath}/tasks.json`;
  }

  async function readTasks(workspacePath: string): Promise<AgentTask[]> {
    const path = tasksPath(workspacePath);
    try {
      const exists = await fs.exists(path);
      if (!exists) return [];
      const content = await fs.readFile(path);
      return JSON.parse(content) as AgentTask[];
    } catch {
      return [];
    }
  }

  async function saveTasks(workspacePath: string, tasks: AgentTask[]): Promise<void> {
    const path = tasksPath(workspacePath);
    await fs.writeFile(path, JSON.stringify(tasks, null, 2));
  }

  function getWorkspacePath(agentId: string): string | undefined {
    return getAgentWorkspaces().get(agentId);
  }

  return {
    start(handler: TaskDueHandler): void {
      if (pollInterval) return;

      logger.info("Task monitor started", { intervalMs: checkIntervalMs });

      const tick = async (): Promise<void> => {
        const workspaces = getAgentWorkspaces();

        for (const [agentId, workspacePath] of workspaces) {
          try {
            const tasks = await readTasks(workspacePath);
            const now = clock.now();
            let modified = false;

            for (const task of tasks) {
              if (isTaskDue(task, now)) {
                logger.info("Task due, firing", { agentId, taskId: task.id, description: task.description });

                try {
                  await handler(agentId, task);
                  task.lastRunAt = now.toISOString();

                  // One-shot tasks become completed
                  if (!task.recurring || task.recurring === "once") {
                    task.status = "completed";
                  }
                  modified = true;
                } catch (err) {
                  logger.warn("Task execution failed", {
                    agentId,
                    taskId: task.id,
                    error: err instanceof Error ? err.message : String(err),
                  });
                  // Don't mark as failed on handler error; it may retry next cycle
                }
              }
            }

            if (modified) {
              await saveTasks(workspacePath, tasks);
            }
          } catch (err) {
            logger.warn("Task monitor tick failed for agent", {
              agentId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      };

      // Run once immediately, then on interval
      tick();
      pollInterval = setInterval(tick, checkIntervalMs);
    },

    stop(): void {
      if (pollInterval) {
        clearInterval(pollInterval);
        pollInterval = null;
        logger.info("Task monitor stopped");
      }
    },

    async getTasks(agentId: string): Promise<AgentTask[]> {
      const wp = getWorkspacePath(agentId);
      if (!wp) return [];
      return readTasks(wp);
    },

    async writeTasks(agentId: string, tasks: AgentTask[]): Promise<void> {
      const wp = getWorkspacePath(agentId);
      if (!wp) throw new Error(`Agent '${agentId}' workspace not found`);
      await saveTasks(wp, tasks);
    },

    async addTask(
      agentId: string,
      task: Omit<AgentTask, "id" | "createdAt" | "lastRunAt" | "status">
    ): Promise<AgentTask> {
      const wp = getWorkspacePath(agentId);
      if (!wp) throw new Error(`Agent '${agentId}' workspace not found`);

      const tasks = await readTasks(wp);
      const newTask: AgentTask = {
        ...task,
        id: crypto.randomUUID(),
        status: "pending",
        createdAt: clock.timestamp(),
        lastRunAt: null,
      };
      tasks.push(newTask);
      await saveTasks(wp, tasks);

      logger.debug("Task added", { agentId, taskId: newTask.id });
      return newTask;
    },

    async removeTask(agentId: string, taskId: string): Promise<boolean> {
      const wp = getWorkspacePath(agentId);
      if (!wp) return false;

      const tasks = await readTasks(wp);
      const idx = tasks.findIndex((t) => t.id === taskId);
      if (idx === -1) return false;

      tasks.splice(idx, 1);
      await saveTasks(wp, tasks);

      logger.debug("Task removed", { agentId, taskId });
      return true;
    },
  };
}
