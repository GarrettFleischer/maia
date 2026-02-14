/**
 * @fileoverview set_identity tool for newly created agents to choose their name and soul.
 * @module agents/tools/set-identity
 *
 * @brief One-time tool: agent sets their own name and soul (personality), unique among
 * current agents. Updates config and SOUL.md/IDENTITY.md in the agent workspace.
 */

import type { Logger, ToolDefinition } from "../../core/types.js";
import type { AgentTool, ToolContext, ToolResult } from "../../agent/tools/base.js";
import type { AgentRegistry } from "../registry.js";
import { PLACEHOLDER_NAME } from "../tools.js";

/**
 * @brief Dependencies for createSetIdentityTool.
 */
export interface SetIdentityToolDeps {
  logger: Logger;
  registry: AgentRegistry;
  /** Resolves the calling agent's ID */
  resolveAgentId: (context: ToolContext) => string | undefined;
  /** Writes a file in the agent's workspace (e.g. SOUL.md, IDENTITY.md) */
  writeAgentWorkspaceFile: (agentId: string, filename: string, content: string) => Promise<void>;
}

/**
 * @brief Creates the set_identity tool.
 * @param deps - Dependencies: logger, registry, resolveAgentId, writeAgentWorkspaceFile
 * @returns AgentTool for setting name and soul (one-time when identity is placeholder)
 *
 * @example
 * // New agent calls: set_identity({ name: "ResearchBot", soul: "thorough, citation-focused researcher" })
 */
export function createSetIdentityTool(deps: SetIdentityToolDeps): AgentTool {
  const { logger, registry, resolveAgentId, writeAgentWorkspaceFile } = deps;

  return {
    name: "set_identity",
    description:
      "Set your display name and soul (personality). Use this once after creation; name and soul must be unique among all agents.",
    definition(): ToolDefinition {
      return {
        name: "set_identity",
        description:
          "Set your name and soul (personality). Call this once after you are created. Both must be unique among current agents. Optional: emoji.",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "Your display name (must be unique)" },
            soul: { type: "string", description: "Your personality / soul description (must be unique)" },
            emoji: { type: "string", description: "Optional emoji identifier" },
          },
          required: ["name", "soul"],
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

      const config = await registry.get(agentId);
      if (!config) {
        return { content: "Your agent config was not found.", success: false };
      }
      if (config.name !== PLACEHOLDER_NAME) {
        return {
          content: "You have already set your identity. Use agent_update if you need to change it.",
          success: false,
        };
      }

      const name = typeof args.name === "string" ? args.name.trim() : "";
      const soul = typeof args.soul === "string" ? args.soul.trim() : "";
      if (!name || !soul) {
        return { content: "name and soul are required.", success: false };
      }

      const agents = await registry.list();
      const nameTaken = agents.some((a) => a.id !== agentId && a.name.toLowerCase() === name.toLowerCase());
      const soulTaken = agents.some((a) => a.id !== agentId && a.personality.trim().toLowerCase() === soul.toLowerCase());
      if (nameTaken) {
        return {
          content: `The name "${name}" is already used by another agent. Choose a unique name.`,
          success: false,
        };
      }
      if (soulTaken) {
        return {
          content: "That soul (personality) description is already used by another agent. Choose a unique one.",
          success: false,
        };
      }

      const emoji = typeof args.emoji === "string" ? args.emoji.trim() || config.emoji : config.emoji;
      await registry.update(agentId, { name, personality: soul, emoji });
      await writeAgentWorkspaceFile(agentId, "SOUL.md", `# Soul\n\n${soul}\n`);
      await writeAgentWorkspaceFile(
        agentId,
        "IDENTITY.md",
        `# Identity\n\n- Name: ${name}\n- Emoji: ${emoji}\n- Created by: ${config.createdBy}\n`
      );

      logger.info("Agent set identity", { agentId, name });
      return {
        content: `Identity set: you are **${name}** ${emoji}. Your soul has been written to SOUL.md.`,
        success: true,
        data: { name, emoji },
      };
    },
  };
}
