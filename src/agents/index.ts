/**
 * @fileoverview Agent orchestration subsystem public exports.
 * @module agents
 */

export { createAgentRegistry } from "./registry.js";
export type { AgentRegistry, AgentConfig, AgentModelConfig, AgentRegistryDeps } from "./registry.js";

export { createSubAgentRuntime } from "./factory.js";
export type { SubAgent, SharedAgentDeps } from "./factory.js";

export { createMonitoredProvider } from "./monitor.js";
export type { MonitorCallbacks, MonitoredProviderDeps } from "./monitor.js";

export {
  createAgentCreateTool,
  createAgentListTool,
  createAgentShutdownTool,
  createAgentRemoveTool,
  createAgentInspectTool,
  createAgentUpdateTool,
} from "./tools.js";
export type { AgentToolsDeps } from "./tools.js";
