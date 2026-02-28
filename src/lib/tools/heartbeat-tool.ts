/**
 * @fileoverview Internal heartbeat tool: wakes Maia only so she can review the task board and manage cron jobs.
 * @module lib/tools/heartbeat-tool
 *
 * This tool is NOT visible to agents. It is invoked by the heartbeat scheduler when the timer fires.
 * Only the "maia" agent is woken (single thread). Maia reviews tasks, assigns unassigned work, and
 * ensures each active agent has a staggered cron job. She messages only agents with no tasks—to
 * tell them to create tasks and mark one in progress, not to start working. Agents run on their cron.
 */
import { z } from "zod";
import type { AppContext } from "../context";
import type { ToolContext } from "./types";
import type { Tool } from "./types";
import type { RunAgentFn } from "../agent/runner";
import { getAgentIdentity } from "../agent/identity";
import { getOrCreateSession } from "../history";
import { runDataBackup } from "../data-backup";
import { enqueue } from "../queue/llm-queue";

/** Agent id for the orchestrator that receives the single heartbeat thread. */
const MAIA_AGENT_ID = "maia";

/**
 * @brief Get or create the single Maia heartbeat session.
 * @param ctx - Application context
 * @returns Session id for the heartbeat thread
 */
function getOrCreateHeartbeatSession(ctx: AppContext): string {
  return getOrCreateSession(ctx, [MAIA_AGENT_ID], "agents", "Heartbeat");
}

const HEARTBEAT_BASE_MAIA = `[HEARTBEAT] Timestamp: {{TIMESTAMP}}

Review the task board and cron job list below. Do NOT message agents to start work—they run on their own cron schedule. Only message agents who have no tasks (see below).

Your job:
1. Assign unassigned tasks to agents using task_update with assignedTo so every agent has work.
2. For agents with no tasks: message them to create their own tasks and mark one as in_progress—but NOT to start working on them yet. They will run on their cron schedule.
3. Ensure each active agent (except yourself) has a cron job at a staggered time within the interval so they do not overlap; create or update cron jobs as needed.
4. Report any blockers if you cannot assign tasks or schedule cron jobs.`;

/**
 * Builds the task board section for Maia (unassigned and in-progress tasks).
 * @param ctx - Application context
 * @returns Task board markdown or empty string if no tasks
 */
function buildTaskBoardSection(ctx: AppContext): string {
  try {
    const unassigned = ctx.db
      .prepare(
        `SELECT id, title, created_by FROM tasks WHERE status = 'todo' AND assigned_to IS NULL ORDER BY created_at ASC`,
      )
      .all() as { id: string; title: string; created_by: string }[];

    const inProgress = ctx.db
      .prepare(
        `SELECT id, title, assigned_to FROM tasks WHERE status = 'in_progress' ORDER BY updated_at ASC`,
      )
      .all() as { id: string; title: string; assigned_to: string | null }[];

    const lines: string[] = ["\n\n## Task Board"];

    if (unassigned.length > 0) {
      lines.push(
        "### Unassigned Tasks (assign these to agents using task_update with assignedTo)",
      );
      for (const t of unassigned) {
        lines.push(`- [${t.id}] ${t.title} — created by ${t.created_by}`);
      }
    }

    if (inProgress.length > 0) {
      lines.push(
        "### In-Progress Tasks (assigned agents will run on their cron schedule)",
      );
      for (const t of inProgress) {
        lines.push(
          `- [${t.id}] ${t.title} — assigned to ${t.assigned_to ?? "unassigned"}`,
        );
      }
    }

    if (unassigned.length === 0 && inProgress.length === 0) return "";
    return lines.join("\n");
  } catch {
    return "";
  }
}

/**
 * Builds the cron job list section for Maia (all cron jobs).
 * @param ctx - Application context
 * @returns Cron jobs markdown or empty string if none
 */
function buildCronListSection(ctx: AppContext): string {
  try {
    const rows = ctx.db
      .prepare(
        "SELECT id, expression, task_description, agent_id, is_built_in, tool_name FROM cron_jobs ORDER BY created_at",
      )
      .all() as {
      id: string;
      expression: string;
      task_description: string;
      agent_id: string;
      is_built_in: number;
      tool_name: string;
    }[];
    if (rows.length === 0) return "";
    const lines = [
      "\n\n## Cron Jobs",
      "| ID | Expression | Description | Agent | Built-in | Tool |",
    ];
    lines.push("| --- | --- | --- | --- | --- | --- |");
    for (const r of rows) {
      lines.push(
        `| ${r.id} | ${r.expression} | ${r.task_description} | ${r.agent_id} | ${r.is_built_in ? "yes" : "no"} | ${r.tool_name ?? "cron_echo"} |`,
      );
    }
    return lines.join("\n");
  } catch {
    return "";
  }
}

/**
 * Builds the agents-with-no-tasks section: active agents (except Maia) who have zero todo or
 * in_progress tasks assigned. Maia should message these agents to create tasks and mark one in progress.
 * @param ctx - Application context
 * @returns Markdown section or empty string if none
 */
function buildAgentsWithNoTasksSection(ctx: AppContext): string {
  try {
    const agentsWithTasks = ctx.db
      .prepare(
        `SELECT DISTINCT assigned_to FROM tasks WHERE assigned_to IS NOT NULL AND status IN ('todo', 'in_progress')`,
      )
      .all() as { assigned_to: string }[];
    const assignedSet = new Set(agentsWithTasks.map((r) => r.assigned_to));

    const activeAgents = ctx.db
      .prepare(
        "SELECT id, name FROM agents WHERE status != 'deleted' AND status != 'paused' AND id != ?",
      )
      .all(MAIA_AGENT_ID) as { id: string; name: string }[];

    const withNoTasks = activeAgents.filter((a) => !assignedSet.has(a.id));
    if (withNoTasks.length === 0) return "";
    const lines = [
      "\n\n## Agents with no tasks (message these to create tasks and mark one in_progress)",
    ];
    for (const a of withNoTasks) {
      lines.push(`- ${a.name} (${a.id})`);
    }
    return lines.join("\n");
  } catch {
    return "";
  }
}

/**
 * Builds the active agents section for Maia (non-deleted agents with status).
 * @param ctx - Application context
 * @returns Active agents markdown
 */
function buildActiveAgentsSection(ctx: AppContext): string {
  try {
    const rows = ctx.db
      .prepare(
        "SELECT id, name, status FROM agents WHERE status != 'deleted' ORDER BY id",
      )
      .all() as { id: string; name: string; status: string }[];
    if (rows.length === 0) return "";
    const lines = ["\n\n## Agents", "| ID | Name | Status |"];
    lines.push("| --- | --- | --- |");
    for (const r of rows) {
      lines.push(`| ${r.id} | ${r.name} | ${r.status} |`);
    }
    return lines.join("\n");
  } catch {
    return "";
  }
}

function buildHeartbeatMessage(ctx: AppContext, timestamp: string): string {
  const base = HEARTBEAT_BASE_MAIA.replace("{{TIMESTAMP}}", timestamp);
  return (
    base +
    buildTaskBoardSection(ctx) +
    buildAgentsWithNoTasksSection(ctx) +
    buildCronListSection(ctx) +
    buildActiveAgentsSection(ctx)
  );
}

/**
 * Creates the internal heartbeat tool. Not registered for agents; invoked by the heartbeat scheduler.
 * Wakes only Maia; Maia reviews the task board and manages cron jobs. She messages only agents with
 * no tasks (to create tasks and mark one in progress).
 * @param runAgentFn - Used to run Maia with the heartbeat message (single thread).
 * @returns Tool instance (do not add to TOOL_REGISTRY).
 */
export function createHeartbeatTool(runAgentFn: RunAgentFn): Tool {
  return {
    name: "heartbeat",
    description:
      "Internal: wake Maia to review tasks, manage cron jobs, and message agents with no tasks.",
    schema: z.object({}),
    toDefinition: () => ({
      name: "heartbeat",
      description: "",
      parameters: {},
    }),
    execute: async (_args, ctx: ToolContext) => {
      const timestamp = new Date().toISOString();
      console.debug("[Heartbeat] Tool executing", { timestamp });
      ctx.events.emit({ event: "heartbeat", data: { timestamp } });

      // Refresh embeddings and knowledge index before waking agents so smart context search is current.
      // If embedding fails, do not run knowledge index or Maia.
      const getCtx = () => ctx;
      try {
        await enqueue(
          { tool: "refreshEmbeddings", args: {}, caller: "system" },
          getCtx,
        );
      } catch (err) {
        console.error("Embedding refresh failed during heartbeat:", err);
        try {
          await runDataBackup(ctx);
        } catch (backupErr) {
          console.error("Data backup failed during heartbeat:", backupErr);
        }
        return { woken: 0, timestamp };
      }

      try {
        await enqueue(
          { tool: "runKnowledgeIndex", args: {}, caller: "system" },
          getCtx,
        );
      } catch (err) {
        console.error("Knowledge index failed during heartbeat:", err);
      }

      const maia = getAgentIdentity(ctx, MAIA_AGENT_ID);
      if (!maia || maia.status === "paused" || maia.status === "deleted") {
        console.debug(
          "[Heartbeat] Maia not present or not active, skipping wake",
        );
        try {
          await runDataBackup(ctx);
        } catch (err) {
          console.error("Data backup failed during heartbeat:", err);
        }
        return { woken: 0, timestamp };
      }

      const message = buildHeartbeatMessage(ctx, timestamp);
      const sessionId = getOrCreateHeartbeatSession(ctx);
      await enqueue(
        {
          tool: "runAgent",
          args: {
            agentId: MAIA_AGENT_ID,
            sessionId,
            message,
            options: { enableSmartContext: false },
            queueCaller: "maia",
            runAgentFn,
          },
          caller: "maia",
        },
        getCtx,
      ).catch((err) => {
        console.error("Heartbeat failed for maia:", err);
      });

      try {
        await runDataBackup(ctx);
      } catch (err) {
        console.error("Data backup failed during heartbeat:", err);
      }

      return { woken: 1, timestamp };
    },
  };
}
