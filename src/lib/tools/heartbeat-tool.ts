/**
 * @fileoverview Internal heartbeat tool: wakes Maia only so she can review tasks and cron jobs.
 * @module lib/tools/heartbeat-tool
 *
 * Not visible to agents; invoked by the heartbeat scheduler. Maia inspects tasks and cron targets,
 * delegates specialized work via personas in user threads, and reports blockers when schedules stall.
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

/** Agent id for the orchestrator that receives the heartbeat thread. */
const MAIA_AGENT_ID = "maia";

/**
 * @brief Get or create the Maia heartbeat session.
 * @param ctx - Application context
 * @returns Session id for the heartbeat thread
 */
function getOrCreateHeartbeatSession(ctx: AppContext): string {
  return getOrCreateSession(ctx, [MAIA_AGENT_ID], "agents", "Heartbeat");
}

const HEARTBEAT_BASE_MAIA = `[HEARTBEAT] Timestamp: {{TIMESTAMP}}

Review the task board and cron jobs below.

You are Maia, the orchestrator. Specialized turns belong in delegated personas (**persona_run**, **persona_list**) inside user sessions—not separate chat identities.

Goals:
1. Keep tasks flowing (assign via **task_update** when something should move forward).
2. Keep cron schedules sane—avoid needless overlap between maintenance jobs.
3. Surface blockers clearly when tasks cannot advance.
`;

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
        "### Unassigned Tasks (assign via task_update when appropriate)",
      );
      for (const t of unassigned) {
        lines.push(`- [${t.id}] ${t.title} — created by ${t.created_by}`);
      }
    }

    if (inProgress.length > 0) {
      lines.push("### In-Progress Tasks");
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
        "SELECT id, expression, task_description, agent_id, is_built_in, tool_name, persona_id, persona_model, cron_message FROM cron_jobs ORDER BY created_at",
      )
      .all() as {
      id: string;
      expression: string;
      task_description: string;
      agent_id: string;
      is_built_in: number;
      tool_name: string;
      persona_id: string | null;
      persona_model: string | null;
      cron_message: string | null;
    }[];
    if (rows.length === 0) return "";
    const lines = [
      "\n\n## Cron Jobs",
      "| ID | Expression | Description | Agent | Built-in | Tool | Persona | Model | Wake |",
    ];
    lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const r of rows) {
      const personaCell = r.persona_id?.trim() ? r.persona_id.trim() : "—";
      const modelCell = r.persona_model?.trim() ? r.persona_model.trim() : "—";
      let wakeCell = "maia prompt";
      if (r.persona_id?.trim()) wakeCell = "persona";
      const msgPreview =
        r.cron_message != null && String(r.cron_message).trim()
          ? String(r.cron_message).trim().slice(0, 80).replace(/\|/g, "/") +
            (String(r.cron_message).trim().length > 80 ? "…" : "")
          : "";
      const wakeDetail =
        wakeCell === "maia prompt" && msgPreview
          ? `${wakeCell}: ${msgPreview}`
          : wakeCell;
      lines.push(
        `| ${r.id} | ${r.expression} | ${r.task_description} | ${r.agent_id} | ${r.is_built_in ? "yes" : "no"} | ${r.tool_name ?? "cron_echo"} | ${personaCell} | ${modelCell} | ${wakeDetail} |`,
      );
    }
    return lines.join("\n");
  } catch {
    return "";
  }
}

/**
 * Builds a lightweight agents table from SQLite so operators can spot stray rows.
 * @param ctx - Application context
 * @returns Markdown section or empty string if none
 */
function buildAgentsTableSection(ctx: AppContext): string {
  try {
    const rows = ctx.db
      .prepare(
        "SELECT id, name, status FROM agents WHERE status != 'deleted' ORDER BY id",
      )
      .all() as { id: string; name: string; status: string }[];
    if (rows.length === 0) return "";
    const lines = ["\n\n## Agents table (SQLite rows)", "| ID | Name | Status |"];
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
    buildCronListSection(ctx) +
    buildAgentsTableSection(ctx)
  );
}

/**
 * Creates the internal heartbeat tool. Not registered for agents; invoked by the heartbeat scheduler.
 * @param runAgentFn - Used to run Maia with the heartbeat message (single thread).
 * @returns Tool instance (do not add to TOOL_REGISTRY).
 */
export function createHeartbeatTool(runAgentFn: RunAgentFn): Tool {
  return {
    name: "heartbeat",
    description:
      "Internal: wake Maia to review tasks and cron targets against schedules.",
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
            options: {},
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
