/**
 * @fileoverview Tool registry for the agent. Manages registration, lookup,
 * and execution of agent tools.
 * @module agent/tools/registry
 *
 * @note Implements a Factory + Registry pattern. Tools register themselves
 * by name and the agent runtime retrieves them for function calling.
 */

import type { AuditLog, Logger, ToolDefinition } from "../../core/types.js";
import type { AgentTool, ToolContext, ToolResult } from "./base.js";

/**
 * @brief Dependencies for createToolRegistry.
 */
export interface ToolRegistryDeps {
  logger: Logger;
  /** Optional audit log to record every tool execution for auditing. */
  auditLog?: AuditLog;
}

/**
 * @brief Tool registry interface.
 */
export interface ToolRegistry {
  /**
   * @brief Registers a tool in the registry.
   * @param tool - AgentTool implementation to register
   * @throws Error if a tool with the same name is already registered
   */
  register(tool: AgentTool): void;

  /**
   * @brief Returns a tool by name, or undefined if not found.
   * @param name - Tool name to look up
   * @returns AgentTool or undefined
   */
  get(name: string): AgentTool | undefined;

  /**
   * @brief Returns all registered tool definitions for LLM function calling.
   * @returns Array of ToolDefinition objects
   */
  definitions(): ToolDefinition[];

  /**
   * @brief Executes a tool by name.
   * @param name - Tool name to execute
   * @param args - Arguments from the LLM
   * @param context - Execution context
   * @returns Promise resolving to ToolResult
   */
  execute(name: string, args: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;

  /**
   * @brief Returns the names of all registered tools.
   * @returns Array of tool name strings
   */
  list(): string[];
}

/**
 * @brief Creates a tool registry for managing agent tools.
 * @param deps - Dependencies: logger, optional auditLog
 * @returns ToolRegistry instance
 *
 * @example
 * const registry = createToolRegistry({ logger });
 * registry.register(memorySearchTool);
 * registry.register(webFetchTool);
 *
 * const defs = registry.definitions(); // pass to LLM
 * const result = await registry.execute("memory_search", { query: "Alice" }, context);
 */
/** @brief Max length for result summary in audit log to avoid huge payloads. */
const AUDIT_RESULT_SUMMARY_MAX = 200;

export function createToolRegistry(deps: ToolRegistryDeps): ToolRegistry {
  const { logger, auditLog } = deps;
  const tools = new Map<string, AgentTool>();

  return {
    register(tool: AgentTool): void {
      if (tools.has(tool.name)) {
        throw new Error(`Tool already registered: ${tool.name}`);
      }
      tools.set(tool.name, tool);
      logger.debug("Tool registered", { name: tool.name });
    },

    get(name: string): AgentTool | undefined {
      return tools.get(name);
    },

    definitions(): ToolDefinition[] {
      return [...tools.values()].map((t) => t.definition());
    },

    async execute(
      name: string,
      args: Record<string, unknown>,
      context: ToolContext
    ): Promise<ToolResult> {
      const tool = tools.get(name);
      if (!tool) {
        logger.warn("Tool not found", { name });
        if (auditLog) {
          await auditLog.log("TOOL_EXECUTION", {
            toolName: name,
            success: false,
            resultSummary: "tool not found",
            sessionId: context.sessionId,
            channelId: context.channelId,
            senderId: context.senderId,
          });
        }
        return {
          content: `Tool '${name}' not found.`,
          success: false,
        };
      }

      const argsSummary =
        Object.keys(args).length > 0
          ? JSON.stringify(args).slice(0, AUDIT_RESULT_SUMMARY_MAX)
          : undefined;

      try {
        logger.debug("Executing tool", { name, args });
        const result = await tool.execute(args, context);
        logger.debug("Tool execution complete", {
          name,
          success: result.success,
        });
        if (auditLog) {
          const content = result.content ?? "";
          const resultSummary =
            typeof content === "string"
              ? content.length > AUDIT_RESULT_SUMMARY_MAX
                ? `${content.slice(0, AUDIT_RESULT_SUMMARY_MAX)}...`
                : content
              : String(content).slice(0, AUDIT_RESULT_SUMMARY_MAX);
          await auditLog.log("TOOL_EXECUTION", {
            toolName: name,
            argsSummary,
            success: result.success,
            resultSummary,
            contentLength: typeof content === "string" ? content.length : 0,
            sessionId: context.sessionId,
            channelId: context.channelId,
            senderId: context.senderId,
          });
        }
        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error("Tool execution failed", { name, error: message });
        if (auditLog) {
          await auditLog.log("TOOL_EXECUTION", {
            toolName: name,
            argsSummary,
            success: false,
            resultSummary: `error: ${message}`,
            sessionId: context.sessionId,
            channelId: context.channelId,
            senderId: context.senderId,
          });
        }
        return {
          content: `Tool '${name}' failed: ${message}`,
          success: false,
        };
      }
    },

    list(): string[] {
      return [...tools.keys()];
    },
  };
}
