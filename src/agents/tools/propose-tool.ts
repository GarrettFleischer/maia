/**
 * @fileoverview propose_tool agent tool for requesting a new tool be added to the system.
 * @module agents/tools/propose-tool
 *
 * @brief Agents use this to propose a new tool (name, description, parameters, implementation).
 * The proposal is persisted and a background security review is enqueued; the agent gets
 * "pending security review" and later approval/denial and user decision are delivered via feedback.
 */

import type { Logger, ToolDefinition } from "../../core/types.js";
import type { AgentTool, ToolContext, ToolResult } from "../../agent/tools/base.js";
import type { ToolProposalsRepository } from "../../tools/proposals.js";
import type { RequestQueue } from "../../providers/queue.js";
import type { CryptoProvider } from "../../core/types.js";

/**
 * @brief Dependencies for createProposeToolTool.
 */
export interface ProposeToolToolDeps {
  logger: Logger;
  proposals: ToolProposalsRepository;
  queue: RequestQueue;
  crypto: CryptoProvider;
  /** Resolves the calling agent's ID (e.g. "maia" or subagent id). */
  resolveAgentId: (context: ToolContext) => string | undefined;
}

/**
 * @brief Creates the propose_tool agent tool.
 * @param deps - Dependencies: logger, proposals repo, queue, crypto, resolveAgentId
 * @returns AgentTool that allows proposing a new tool
 *
 * @example
 * // LLM calls: propose_tool({ name: "my_tool", description: "...", parameters: {...}, implementation_type: "inline", implementation_config: { code: "..." } })
 */
export function createProposeToolTool(deps: ProposeToolToolDeps): AgentTool {
  const { logger, proposals, queue, crypto, resolveAgentId } = deps;

  return {
    name: "propose_tool",
    description:
      "Propose a new tool for the system. The tool will be reviewed for security; if approved by Maia, the user will be asked to approve. Once approved, the tool is available to all agents.",
    definition(): ToolDefinition {
      return {
        name: "propose_tool",
        description:
          "Propose a new tool. Provide name (lowercase with underscores), description, parameters (JSON Schema object), implementation type (e.g. 'inline'), and optional implementation config. The proposal is reviewed for security in the background; you will receive feedback when it is approved or denied.",
        parameters: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "Unique tool name (lowercase, letters, numbers, underscores only)",
            },
            description: {
              type: "string",
              description: "What the tool does (10–500 characters)",
            },
            parameters: {
              type: "object",
              description:
                "JSON Schema for the tool's parameters (e.g. { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] })",
            },
            implementation_type: {
              type: "string",
              description: "How the tool runs, e.g. 'inline' for agent-provided code",
            },
            implementation_config: {
              type: "object",
              description: "Optional config (e.g. { code: '...' } for inline)",
            },
          },
          required: ["name", "description", "parameters", "implementation_type"],
        },
      };
    },

    async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
      const agentId = resolveAgentId(context);
      if (!agentId) {
        return {
          content: "Could not determine your agent ID. This tool is only available to agents.",
          success: false,
        };
      }

      const name = typeof args.name === "string" ? args.name.trim() : "";
      const description = typeof args.description === "string" ? args.description.trim() : "";
      const implementationType = typeof args.implementation_type === "string" ? args.implementation_type.trim() : "";

      if (!name || !description || !implementationType) {
        return {
          content: "name, description, and implementation_type are required.",
          success: false,
        };
      }

      let parametersJson: string;
      if (args.parameters !== null && typeof args.parameters === "object") {
        try {
          parametersJson = JSON.stringify(args.parameters);
        } catch {
          return { content: "parameters must be a valid JSON object.", success: false };
        }
      } else {
        return { content: "parameters must be a JSON object (e.g. { type: 'object', properties: {} }).", success: false };
      }

      let implementationConfigJson: string | null = null;
      if (args.implementation_config !== undefined && args.implementation_config !== null) {
        if (typeof args.implementation_config !== "object") {
          return { content: "implementation_config must be an object if provided.", success: false };
        }
        try {
          implementationConfigJson = JSON.stringify(args.implementation_config);
        } catch {
          return { content: "implementation_config must be JSON-serializable.", success: false };
        }
      }

      const id = crypto.randomUUID();
      try {
        await proposals.create({
          id,
          proposingAgentId: agentId,
          name,
          description,
          parametersJson,
          implementationType,
          implementationConfigJson,
        });
      } catch (err) {
        logger.warn("Tool proposal create failed", { error: err instanceof Error ? err.message : String(err) });
        return {
          content: `Failed to save proposal: ${err instanceof Error ? err.message : String(err)}`,
          success: false,
        };
      }

      try {
        await queue.enqueueJob(
          { type: "tool_review", payload: { proposalId: id } },
          "background"
        );
      } catch (err) {
        logger.warn("Tool review job enqueue failed", { proposalId: id, error: err instanceof Error ? err.message : String(err) });
        return {
          content: `Proposal saved but security review could not be queued. Please try again or ask the user to check the queue.`,
          success: false,
        };
      }

      logger.info("Tool proposal created and queued for review", { proposalId: id, name, proposingAgentId: agentId });
      return {
        content: `Tool proposal "${name}" has been received and is pending security review. You will receive feedback when it is approved or denied.`,
        success: true,
        data: { proposalId: id },
      };
    },
  };
}
