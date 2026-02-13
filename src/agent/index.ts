/**
 * @fileoverview Agent subsystem public exports.
 * @module agent
 */

export { createSessionManager } from "./session.js";
export type { SessionManager, SessionManagerDeps } from "./session.js";
export { createThreadTracker } from "./threading.js";
export { createPrivacyManager } from "./privacy.js";
export { createScheduler } from "./scheduler.js";
export { createContextBuilder } from "./context.js";
export type { ContextBuilder, ContextBuilderDeps, ContextInput } from "./context.js";
export { createAgentRuntime } from "./runtime.js";
export type { AgentRuntime, AgentRuntimeDeps } from "./runtime.js";
export {
  createToolRegistry,
  createWebFetchTool,
  createMemorySearchTool,
  createMemoryStoreTool,
  createMemoryForgetTool,
} from "./tools/index.js";
export type {
  AgentTool,
  ToolContext,
  ToolResult,
  ToolRegistry,
  ToolRegistryDeps,
} from "./tools/index.js";
