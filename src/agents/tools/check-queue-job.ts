/**
 * @fileoverview check_queue_job tool for agents to check job status in the queue.
 * @module agents/tools/check-queue-job
 *
 * @brief Allows agents to check whether a job they submitted is still queued,
 * currently running, completed, or not found. Agents use this to correlate
 * "waiting on job X" with completion.
 */

import type { Logger, ToolDefinition } from "../../core/types.js";
import type { AgentTool, ToolContext, ToolResult } from "../../agent/tools/base.js";
import type { ManagerJobStatus } from "../../providers/queue-manager.js";

/**
 * @brief Dependencies for createCheckQueueJobTool.
 */
export interface CheckQueueJobToolDeps {
  logger: Logger;
  /** Returns job status: queued | running | completed | not_found */
  getJobStatus: (jobId: string) => ManagerJobStatus;
}

/**
 * @brief Creates the check_queue_job tool.
 * @param deps - Dependencies: logger, getJobStatus
 * @returns AgentTool that enables agents to check queue job status
 *
 * @example
 * // LLM calls: check_queue_job({ jobId: "job_123_abc" })
 */
export function createCheckQueueJobTool(deps: CheckQueueJobToolDeps): AgentTool {
  const { logger, getJobStatus } = deps;

  return {
    name: "check_queue_job",
    description: "Check whether a job you submitted is still in the queue or has completed.",
    definition(): ToolDefinition {
      return {
        name: "check_queue_job",
        description:
          "Check the status of a job by its job ID. Use this when you're waiting on a task you submitted " +
          "(e.g. after enqueueing a chat or action). Returns: queued (waiting), running (in progress), " +
          "completed (finished successfully), or not_found.",
        parameters: {
          type: "object",
          properties: {
            jobId: {
              type: "string",
              description: "The job ID returned when you submitted the task",
            },
          },
          required: ["jobId"],
        },
      };
    },

    async execute(args: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
      const jobId = args.jobId as string;
      if (!jobId) {
        return { content: "jobId is required.", success: false };
      }

      try {
        const status = getJobStatus(jobId);
        logger.debug("check_queue_job", { jobId, status });
        return {
          content: `Job ${jobId} status: ${status}`,
          success: true,
        };
      } catch (err) {
        logger.warn("check_queue_job failed", {
          jobId,
          error: err instanceof Error ? err.message : String(err),
        });
        return {
          content: `Failed to check job status: ${err instanceof Error ? err.message : String(err)}`,
          success: false,
        };
      }
    },
  };
}
