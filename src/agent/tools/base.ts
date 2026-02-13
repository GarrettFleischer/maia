/**
 * @fileoverview Base tool interface for the agent tool system.
 * @module agent/tools/base
 *
 * @note All agent tools implement this interface. Tools are registered
 * in the tool registry and made available to the LLM via function calling.
 */

import type { ToolDefinition } from "../../core/types.js";

/**
 * @brief Context passed to tool execute methods.
 *
 * @note Contains session and channel information that tools may
 * need to scope their behavior (e.g., memory tools may tag entries
 * with channel/session metadata).
 */
export interface ToolContext {
  /** Current session ID */
  sessionId: string;
  /** Channel the message originated from */
  channelId: string;
  /** User/sender ID */
  senderId: string;
  /** Whether privacy mode is active for this session */
  privacyMode: boolean;
}

/**
 * @brief Result returned by a tool execution.
 */
export interface ToolResult {
  /** Human-readable result to include in the conversation */
  content: string;
  /** Whether the tool execution succeeded */
  success: boolean;
  /** Optional structured data for programmatic use */
  data?: Record<string, unknown>;
}

/**
 * @brief Agent tool interface. All tools must implement this contract.
 *
 * @note Tools should:
 * - Validate their arguments before execution
 * - Return meaningful error messages on failure
 * - Respect privacy mode when dealing with memory
 * - Log their execution via the provided logger
 */
export interface AgentTool {
  /** Unique tool name (matches the name in ToolDefinition) */
  readonly name: string;

  /** Human-readable description */
  readonly description: string;

  /**
   * @brief Returns the tool's function definition for LLM function calling.
   * @returns ToolDefinition with name, description, and JSON Schema parameters
   */
  definition(): ToolDefinition;

  /**
   * @brief Executes the tool with the given arguments and context.
   * @param args - Tool arguments from the LLM
   * @param context - Execution context (session, channel, etc.)
   * @returns Promise resolving to ToolResult
   */
  execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
}
