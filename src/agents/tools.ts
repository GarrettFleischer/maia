/**
 * @fileoverview Agent management tools for Maia and sub-agents (flat architecture).
 * @module agents/tools
 *
 * @brief These tools are registered for Maia and optionally for sub-agents. They let
 * agents create (with Maia approval when caller is not Maia), list, remove, message,
 * and inspect other agents. New agents choose their own name and soul via set_identity.
 */

import type { CryptoProvider, Logger, EventBus } from "../core/types.js";
import type { AgentTool, ToolContext, ToolResult } from "../agent/tools/base.js";
import type { ToolDefinition } from "../core/types.js";
import type { AgentRegistry, AgentConfig, AgentModelConfig } from "./registry.js";
import type { SubAgent } from "./factory.js";
import type { AgentCreationRequestsRepository, AgentCreationRequest } from "./agent-creation-requests.js";
import type { TaskMonitor } from "./task-monitor.js";

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
  /** Crypto for generating request IDs */
  crypto: CryptoProvider;
  /** Resolves the calling agent's ID (e.g. "maia" or sub-agent id). When absent, caller is treated as Maia. */
  resolveAgentId?: (context: ToolContext) => string | undefined;
  /** Repository for agent creation requests (required when non-Maia agents can request creation). */
  creationRequestsRepo?: AgentCreationRequestsRepository;
  /** Called when a non-Maia agent submits an agent creation request (e.g. to push approval to dashboard). */
  onAgentCreationRequest?: (request: AgentCreationRequest) => void;
  /** Called when an agent is created (direct path) so the host can register message and other tools on it. */
  onAgentCreated?: (subAgent: SubAgent) => void;
  /** Optional: for agent_list to include each agent's assigned tasks. */
  taskMonitor?: TaskMonitor;
  /** Optional ref to TaskMonitor (for Maia's agent_list when monitor is created later). */
  taskMonitorRef?: { current: TaskMonitor | null };
  /** Optional event bus to emit agentCreated when an agent is created (direct path). */
  events?: EventBus;
  /** Default provider and model for new agents (e.g. Maia's primary); used when agent_create does not specify provider/model. */
  defaultModel?: { provider: string; model: string };
}

// ─── agent_create ─────────────────────────────────────────────────

/**
 * @brief Placeholder name and soul for newly created agents; they set their own via set_identity.
 */
export const PLACEHOLDER_NAME = "New Agent";
export const PLACEHOLDER_SOUL = "Identity to be set";

/**
 * @brief Creates the agent_create tool.
 * @param deps - Shared agent tool dependencies
 * @returns AgentTool that creates a new sub-agent (direct if Maia, request if non-Maia)
 *
 * @note When the caller is not Maia, a creation request is stored and onAgentCreationRequest
 * is called; Maia/user must approve before the agent is created. New agents get placeholder
 * name/soul and choose their own via set_identity.
 *
 * @example
 * // Maia: agent_create({ id: "research-bot", schedule: "0 9 * * *", tools: ["memory_search"] })
 * // Other agent: same args -> request created for Maia approval
 */
export function createAgentCreateTool(deps: AgentToolsDeps): AgentTool {
  const {
    registry,
    logger,
    createRuntime,
    activeAgents,
    crypto,
    resolveAgentId,
    creationRequestsRepo,
    onAgentCreationRequest,
    onAgentCreated,
    events,
    defaultModel,
  } = deps;
  const fallbackModel = defaultModel ?? { provider: "gemini", model: "gemini-2.0-flash" };

  return {
    name: "agent_create",
    description: "Create a new agent. If you are not Maia, a request is submitted for her approval; the new agent will choose their own name and soul.",
    definition(): ToolDefinition {
      return {
        name: "agent_create",
        description:
          "Create a new agent with its own workspace, schedule, and tools. Provide at least id. Optionally provide description (what the agent is for); the new agent uses it to choose their own name and soul. If you are not Maia, your request must be approved by Maia first.",
        parameters: {
          type: "object",
          properties: {
            id: { type: "string", description: "Unique kebab-case identifier (e.g. 'research-bot')" },
            description: {
              type: "string",
              description: "Short description of what this agent is for (e.g. 'Research assistant that finds and summarizes papers'). The new agent uses this to choose their own name and soul.",
            },
            schedule: { type: "string", description: "Cron schedule (e.g. '0 9 * * *') or empty for no schedule" },
            tools: {
              type: "array",
              items: { type: "string" },
              description: "Tool names this agent can use (e.g. ['web_fetch', 'memory_store'])",
            },
            provider: { type: "string", description: "LLM provider name (e.g. 'gemini', 'groq')" },
            model: { type: "string", description: "LLM model name" },
            instructions: { type: "string", description: "Custom operating instructions (optional)" },
            emoji: { type: "string", description: "Emoji identifier (optional; agent can change later)" },
          },
          required: ["id"],
        },
      };
    },

    async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
      try {
        const id = args.id as string;
        if (!id || typeof id !== "string") {
          return { content: "id is required.", success: false };
        }
        const existing = await registry.get(id);
        if (existing) {
          return { content: `Agent '${id}' already exists.`, success: false };
        }

        const callerId = resolveAgentId?.(context) ?? "maia";
        const isMaia = callerId === "maia";

        if (!isMaia && creationRequestsRepo && onAgentCreationRequest) {
          const proposedConfig = {
            id,
            description: args.description as string | undefined,
            schedule: (args.schedule as string) ?? "",
            tools: (args.tools as string[]) ?? ["memory_search", "memory_store"],
            model: {
              provider: (args.provider as string) ?? fallbackModel.provider,
              model: (args.model as string) ?? fallbackModel.model,
            } as AgentModelConfig,
            instructions: args.instructions as string | undefined,
            emoji: (args.emoji as string) ?? "🤖",
          };
          const requestId = crypto.randomUUID();
          await creationRequestsRepo.create({
            id: requestId,
            requestingAgentId: callerId,
            proposedConfigJson: JSON.stringify(proposedConfig),
          });
          const request = await creationRequestsRepo.getById(requestId);
          if (request) onAgentCreationRequest(request);
          logger.info("Agent creation request submitted", { requestId, id, requestingAgentId: callerId });
          return {
            content: `Agent creation request for '${id}' submitted. Maia must approve before the agent is created. You will be able to message them using message(recipientId: '${id}', content: '...') once they exist.`,
            success: true,
            data: { requestId, agentId: id },
          };
        }

        const config: AgentConfig = {
          id,
          name: PLACEHOLDER_NAME,
          emoji: (args.emoji as string) ?? "🤖",
          personality: PLACEHOLDER_SOUL,
          createdBy: callerId,
          schedule: (args.schedule as string) ?? "",
          tools: (args.tools as string[]) ?? ["memory_search", "memory_store"],
          model: {
            provider: (args.provider as string) ?? fallbackModel.provider,
            model: (args.model as string) ?? fallbackModel.model,
          } as AgentModelConfig,
          instructions: args.instructions as string | undefined,
          description: args.description as string | undefined,
        };

        const registered = await registry.register(config);
        const subAgent = createRuntime(registered);
        activeAgents.set(id, subAgent);
        onAgentCreated?.(subAgent);
        await events?.emit("agentCreated", { agentId: id });

        logger.info("Agent created via tool", { id, createdBy: callerId });
        return {
          content: `Agent (${id}) created successfully with full tool access. They will choose their own name and soul using set_identity. ${config.schedule ? `Scheduled: ${config.schedule}` : "No schedule."}`,
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
 * @param deps - Shared agent tool dependencies (optional taskMonitor for assigned tasks)
 * @returns AgentTool that lists all agents with status and optionally assigned tasks
 */
export function createAgentListTool(deps: AgentToolsDeps): AgentTool {
  const { registry, taskMonitor, taskMonitorRef, resolveAgentId } = deps;
  const getTaskMonitor = () => taskMonitor ?? taskMonitorRef?.current ?? undefined;

  return {
    name: "agent_list",
    description: "List all registered agents, their status, and assigned tasks.",
    definition(): ToolDefinition {
      return {
        name: "agent_list",
        description:
          "List all registered agents with status, schedule, tools, and assigned tasks (next due or count of pending).",
        parameters: { type: "object", properties: {} },
      };
    },

    async execute(_args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
      try {
        const agents = await registry.list();
        if (agents.length === 0) {
          return { content: "No agents registered.", success: true };
        }
        const callerId = resolveAgentId?.(context);

        const lines: string[] = [];
        for (const a of agents) {
          let line = `- **${a.name}** (${a.id}) ${a.emoji} | Active: ${a.active !== false ? "yes" : "no"} | Tools: ${a.tools.join(", ")} | Schedule: ${a.schedule || "none"}`;
          if (callerId === a.id) line += " | *(you)*";
          const monitor = getTaskMonitor();
          if (monitor) {
            try {
              const tasks = await monitor.getTasks(a.id);
              const pending = tasks.filter((t) => t.status === "pending");
              if (pending.length > 0) {
                const next = pending.sort(
                  (x, y) => new Date(x.scheduledAt).getTime() - new Date(y.scheduledAt).getTime()
                )[0];
                line += ` | Assigned: ${next.description} (due ${next.scheduledAt})`;
                if (pending.length > 1) line += `; +${pending.length - 1} more`;
              } else {
                line += " | Assigned: none";
              }
            } catch {
              line += " | Assigned: —";
            }
          }
          lines.push(line);
        }
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

// ─── agent_shutdown ───────────────────────────────────────────────

/**
 * @brief Creates the agent_shutdown tool (self-shutdown for sub-agents only).
 * @param deps - Shared agent tool dependencies (registry, activeAgents, resolveAgentId required)
 * @returns AgentTool that deactivates the calling agent
 */
export function createAgentShutdownTool(deps: AgentToolsDeps): AgentTool {
  const { registry, logger, activeAgents, resolveAgentId } = deps;

  return {
    name: "agent_shutdown",
    description: "Shut yourself down when your purpose is fully served. Only you can call this; Maia cannot.",
    definition(): ToolDefinition {
      return {
        name: "agent_shutdown",
        description:
          "Deactivate yourself and stop running. Use this when your purpose is fully served and you have nothing left to do. Only the agent themselves can call this; Maia cannot shut herself down.",
        parameters: {
          type: "object",
          properties: {},
          required: [],
        },
      };
    },

    async execute(_args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
      try {
        const callerId = resolveAgentId?.(context);
        if (!callerId || callerId === "maia") {
          return {
            content: "Only a sub-agent can shut themselves down. Maia cannot call agent_shutdown.",
            success: false,
          };
        }
        if (!activeAgents.has(callerId)) {
          return { content: "You are not active.", success: false };
        }
        await registry.update(callerId, { active: false });
        activeAgents.delete(callerId);
        logger.info("Agent shut down via tool", { id: callerId });
        return {
          content: `You have shut down. You can be restarted by Maia or the user if needed.`,
          success: true,
        };
      } catch (err) {
        return {
          content: `Failed to shut down: ${err instanceof Error ? err.message : String(err)}`,
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
