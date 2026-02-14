/**
 * @fileoverview Agent management tools for Maia (the manager brain).
 * @module agents/tools
 *
 * @brief These tools are registered ONLY in Maia's tool registry, not in
 * sub-agents. They let Maia (and by extension the user) create, list,
 * remove, message, and inspect sub-agents.
 */

import type { Logger, InboundMessage } from "../core/types.js";
import type { AgentTool, ToolContext, ToolResult } from "../agent/tools/base.js";
import type { ToolDefinition } from "../core/types.js";
import type { AgentRegistry, AgentConfig, AgentModelConfig } from "./registry.js";
import type { SubAgent } from "./factory.js";

/**
 * @brief Dependencies shared by all agent management tools.
 */
export interface AgentToolsDeps {
  registry: AgentRegistry;
  logger: Logger;
  /** Creates and returns a SubAgent runtime for a given agent config */
  createRuntime: (config: AgentConfig) => SubAgent;
  /** Map of active sub-agent runtimes, keyed by agent ID */
  activeAgents: Map<string, SubAgent>;
}

// ─── agent_create ─────────────────────────────────────────────────

/**
 * @brief Creates the agent_create tool.
 * @param deps - Shared agent tool dependencies
 * @returns AgentTool that creates a new sub-agent
 *
 * @example
 * // LLM calls: agent_create({ id: "research-bot", name: "ResearchBot", ... })
 */
export function createAgentCreateTool(deps: AgentToolsDeps): AgentTool {
  const { registry, logger, createRuntime, activeAgents } = deps;

  return {
    name: "agent_create",
    description: "Create a new sub-agent with its own persona, schedule, and tools.",
    definition(): ToolDefinition {
      return {
        name: "agent_create",
        description:
          "Create a new sub-agent. The agent gets its own workspace, personality, memory, and optional schedule.",
        parameters: {
          type: "object",
          properties: {
            id: { type: "string", description: "Unique kebab-case identifier (e.g. 'research-bot')" },
            name: { type: "string", description: "Display name for the agent" },
            emoji: { type: "string", description: "Emoji identifier" },
            personality: { type: "string", description: "Personality description for the agent's soul" },
            schedule: { type: "string", description: "Cron schedule (e.g. '0 9 * * *') or empty for no schedule" },
            tools: {
              type: "array",
              items: { type: "string" },
              description: "Tool names this agent can use (e.g. ['web_fetch', 'memory_store'])",
            },
            provider: { type: "string", description: "LLM provider name (e.g. 'gemini', 'groq')" },
            model: { type: "string", description: "LLM model name" },
            instructions: { type: "string", description: "Custom operating instructions (optional)" },
          },
          required: ["id", "name", "personality"],
        },
      };
    },

    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      try {
        const id = args.id as string;
        const existing = await registry.get(id);
        if (existing) {
          return { content: `Agent '${id}' already exists.`, success: false };
        }

        const config: AgentConfig = {
          id,
          name: args.name as string,
          emoji: (args.emoji as string) ?? "🤖",
          personality: args.personality as string,
          createdBy: "maia",
          schedule: (args.schedule as string) ?? "",
          tools: (args.tools as string[]) ?? ["memory_search", "memory_store"],
          model: {
            provider: (args.provider as string) ?? "gemini",
            model: (args.model as string) ?? "gemini-2.0-flash",
          } as AgentModelConfig,
          instructions: args.instructions as string | undefined,
        };

        const registered = await registry.register(config);

        // Create and activate the runtime
        const subAgent = createRuntime(registered);
        activeAgents.set(id, subAgent);

        logger.info("Agent created via tool", { id, name: config.name });
        return {
          content: `Agent '${config.name}' (${id}) created successfully with tools: ${config.tools.join(", ")}. ${config.schedule ? `Scheduled: ${config.schedule}` : "No schedule."}`,
          success: true,
          data: { agentId: id },
        };
      } catch (err) {
        return {
          content: `Failed to create agent: ${err instanceof Error ? err.message : String(err)}`,
          success: false,
        };
      }
    },
  };
}

// ─── agent_list ───────────────────────────────────────────────────

/**
 * @brief Creates the agent_list tool.
 * @param deps - Shared agent tool dependencies
 * @returns AgentTool that lists all sub-agents
 */
export function createAgentListTool(deps: AgentToolsDeps): AgentTool {
  const { registry } = deps;

  return {
    name: "agent_list",
    description: "List all registered sub-agents and their status.",
    definition(): ToolDefinition {
      return {
        name: "agent_list",
        description: "List all registered sub-agents with their status, schedule, and tools.",
        parameters: { type: "object", properties: {} },
      };
    },

    async execute(): Promise<ToolResult> {
      try {
        const agents = await registry.list();
        if (agents.length === 0) {
          return { content: "No sub-agents registered.", success: true };
        }

        const lines = agents.map((a) =>
          `- **${a.name}** (${a.id}) ${a.emoji} | Active: ${a.active !== false ? "yes" : "no"} | Tools: ${a.tools.join(", ")} | Schedule: ${a.schedule || "none"}`
        );
        return {
          content: `Registered agents:\n${lines.join("\n")}`,
          success: true,
          data: { count: agents.length },
        };
      } catch (err) {
        return {
          content: `Failed to list agents: ${err instanceof Error ? err.message : String(err)}`,
          success: false,
        };
      }
    },
  };
}

// ─── agent_remove ─────────────────────────────────────────────────

/**
 * @brief Creates the agent_remove tool.
 * @param deps - Shared agent tool dependencies
 * @returns AgentTool that removes a sub-agent
 */
export function createAgentRemoveTool(deps: AgentToolsDeps): AgentTool {
  const { registry, logger, activeAgents } = deps;

  return {
    name: "agent_remove",
    description: "Remove a sub-agent and delete its workspace.",
    definition(): ToolDefinition {
      return {
        name: "agent_remove",
        description: "Permanently remove a sub-agent, its workspace, and its memories.",
        parameters: {
          type: "object",
          properties: {
            id: { type: "string", description: "Agent ID to remove" },
          },
          required: ["id"],
        },
      };
    },

    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      try {
        const id = args.id as string;
        const removed = await registry.remove(id);
        if (!removed) {
          return { content: `Agent '${id}' not found.`, success: false };
        }
        activeAgents.delete(id);
        logger.info("Agent removed via tool", { id });
        return { content: `Agent '${id}' removed.`, success: true };
      } catch (err) {
        return {
          content: `Failed to remove agent: ${err instanceof Error ? err.message : String(err)}`,
          success: false,
        };
      }
    },
  };
}

// ─── agent_message ────────────────────────────────────────────────

/**
 * @brief Creates the agent_message tool.
 * @param deps - Shared agent tool dependencies
 * @returns AgentTool that sends a message to a sub-agent and returns the response
 */
export function createAgentMessageTool(deps: AgentToolsDeps): AgentTool {
  const { activeAgents, logger } = deps;

  return {
    name: "agent_message",
    description: "Send a message to a sub-agent and get its response.",
    definition(): ToolDefinition {
      return {
        name: "agent_message",
        description: "Send a message to a specific sub-agent. Returns the agent's response.",
        parameters: {
          type: "object",
          properties: {
            id: { type: "string", description: "Agent ID to message" },
            content: { type: "string", description: "Message content to send" },
          },
          required: ["id", "content"],
        },
      };
    },

    async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
      try {
        const id = args.id as string;
        const content = args.content as string;

        const subAgent = activeAgents.get(id);
        if (!subAgent) {
          return { content: `Agent '${id}' is not active. It may not exist or hasn't been loaded.`, success: false };
        }

        const message: InboundMessage = {
          id: crypto.randomUUID(),
          channelId: `agent:${id}`,
          senderId: context.senderId,
          content,
          timestamp: new Date().toISOString(),
          isGroup: false,
        };

        const result = await subAgent.runtime.handleMessage(message);
        logger.debug("Agent message exchanged", {
          agentId: id,
          responseLength: result.content.length,
        });

        return {
          content: `[${subAgent.config.name}]: ${result.content}`,
          success: true,
          data: { agentId: id, response: result.content },
        };
      } catch (err) {
        return {
          content: `Failed to message agent: ${err instanceof Error ? err.message : String(err)}`,
          success: false,
        };
      }
    },
  };
}

// ─── agent_inspect ────────────────────────────────────────────────

/**
 * @brief Creates the agent_inspect tool.
 * @param deps - Shared agent tool dependencies
 * @returns AgentTool that reads a sub-agent's workspace files
 */
export function createAgentInspectTool(deps: AgentToolsDeps): AgentTool {
  const { registry } = deps;

  return {
    name: "agent_inspect",
    description: "Read a sub-agent's workspace files (SOUL.md, MEMORY.md, USER.md, daily logs).",
    definition(): ToolDefinition {
      return {
        name: "agent_inspect",
        description:
          "Inspect a sub-agent's workspace: read its SOUL.md, MEMORY.md, USER.md, or recent daily log.",
        parameters: {
          type: "object",
          properties: {
            id: { type: "string", description: "Agent ID to inspect" },
            file: {
              type: "string",
              description: "File to read: 'soul', 'memory', 'user', 'agents', 'identity', or 'config'",
              enum: ["soul", "memory", "user", "agents", "identity", "config"],
            },
          },
          required: ["id"],
        },
      };
    },

    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      try {
        const id = args.id as string;
        const file = (args.file as string) ?? "config";

        const config = await registry.get(id);
        if (!config) {
          return { content: `Agent '${id}' not found.`, success: false };
        }

        if (file === "config") {
          return {
            content: `Agent '${id}' config:\n\`\`\`json\n${JSON.stringify(config, null, 2)}\n\`\`\``,
            success: true,
          };
        }

        // Map file names to workspace files
        const fileMap: Record<string, string> = {
          soul: "SOUL.md",
          memory: "MEMORY.md",
          user: "USER.md",
          agents: "AGENTS.md",
          identity: "IDENTITY.md",
        };

        const filename = fileMap[file];
        if (!filename) {
          return { content: `Unknown file: '${file}'. Use: soul, memory, user, agents, identity, or config.`, success: false };
        }

        // Read from the agent's workspace using the registry's path helper
        const workspacePath = registry.agentWorkspacePath(id);
        return {
          content: `[${id}/${filename}] contents available at: ${workspacePath}/${filename}`,
          success: true,
          data: { agentId: id, file: filename, path: `${workspacePath}/${filename}` },
        };
      } catch (err) {
        return {
          content: `Failed to inspect agent: ${err instanceof Error ? err.message : String(err)}`,
          success: false,
        };
      }
    },
  };
}

// ─── agent_update ─────────────────────────────────────────────────

/**
 * @brief Creates the agent_update tool.
 * @param deps - Shared agent tool dependencies
 * @returns AgentTool that updates a sub-agent's configuration
 */
export function createAgentUpdateTool(deps: AgentToolsDeps): AgentTool {
  const { registry, logger } = deps;

  return {
    name: "agent_update",
    description: "Update a sub-agent's configuration (schedule, tools, personality, etc.).",
    definition(): ToolDefinition {
      return {
        name: "agent_update",
        description: "Update a sub-agent's configuration. Only provided fields are changed.",
        parameters: {
          type: "object",
          properties: {
            id: { type: "string", description: "Agent ID to update" },
            name: { type: "string", description: "New display name" },
            personality: { type: "string", description: "New personality description" },
            schedule: { type: "string", description: "New cron schedule" },
            tools: { type: "array", items: { type: "string" }, description: "New tool list" },
            active: { type: "boolean", description: "Enable or disable the agent" },
          },
          required: ["id"],
        },
      };
    },

    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      try {
        const id = args.id as string;
        const changes: Partial<AgentConfig> = {};

        if (args.name !== undefined) changes.name = args.name as string;
        if (args.personality !== undefined) changes.personality = args.personality as string;
        if (args.schedule !== undefined) changes.schedule = args.schedule as string;
        if (args.tools !== undefined) changes.tools = args.tools as string[];
        if (args.active !== undefined) changes.active = args.active as boolean;

        const updated = await registry.update(id, changes);
        if (!updated) {
          return { content: `Agent '${id}' not found.`, success: false };
        }

        logger.info("Agent updated via tool", { id, changes: Object.keys(changes) });
        return {
          content: `Agent '${id}' updated: ${Object.keys(changes).join(", ")}`,
          success: true,
        };
      } catch (err) {
        return {
          content: `Failed to update agent: ${err instanceof Error ? err.message : String(err)}`,
          success: false,
        };
      }
    },
  };
}
