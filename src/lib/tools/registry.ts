import { fileCrudTools } from "./file-crud";
import { terminalTool } from "./terminal";
import { webSearchTool } from "./web-search";
import { braveAnswersTool } from "./brave-answers";
import { fetchWebPageTool } from "./fetch-web-page";
import { browserTools } from "./browser-tools";
import { messagingTools } from "./messaging";
import { historyTools } from "./history-tool";
import { knowledgeTools } from "./knowledge-tool";
import { credentialTools } from "./credentials";
import { agentManagementTools, agentIdentityTools } from "./agent-management";
import { cronTools } from "./cron-tool";
import { taskTrackerTools } from "./task-tracker";
import { yahooMailTools } from "./yahoo-mail";
import { dateTimeTools } from "./datetime";
import type { Tool, ToolRegistration } from "./types";

/**
 * @fileoverview Global registry and filtering helpers for Maia tools.
 * @module lib/tools/registry
 */

export const TOOL_REGISTRY: ToolRegistration[] = [
  ...fileCrudTools.map((tool) => ({ tool, maiaOnly: false })),
  { tool: terminalTool, maiaOnly: false },
  { tool: webSearchTool, maiaOnly: false },
  { tool: braveAnswersTool, maiaOnly: false },
  { tool: fetchWebPageTool, maiaOnly: false },
  ...(process.env.BROWSER_TOOLS_ENABLED === "1"
    ? browserTools.map((tool) => ({ tool, maiaOnly: false }))
    : []),
  ...messagingTools.map((tool) => ({ tool, maiaOnly: false })),
  ...historyTools.map((tool) => ({ tool, maiaOnly: false })),
  ...knowledgeTools.map((tool) => ({ tool, maiaOnly: false })),
  ...credentialTools.map((tool) => ({ tool, maiaOnly: false })),
  ...taskTrackerTools.map((tool) => ({ tool, maiaOnly: false })),
  ...yahooMailTools.map((tool) => ({ tool, maiaOnly: false })),
  ...dateTimeTools.map((tool) => ({ tool, maiaOnly: false })),
  ...agentManagementTools.map((tool) => ({ tool, maiaOnly: true })),
  ...agentIdentityTools.map((tool) => ({ tool, maiaOnly: false })),
  ...cronTools.map((tool) => ({ tool, maiaOnly: true })),
];

/**
 * @brief Get the list of tools available to a specific agent.
 * @param agentId Agent identifier; some tools are restricted to the special \"maia\" orchestrator.
 * @returns Array of tools the given agent is allowed to use.
 */
export function getToolsForAgent(agentId: string): Tool[] {
  return TOOL_REGISTRY.filter(
    (reg) => !reg.maiaOnly || agentId === "maia"
  ).map((reg) => reg.tool);
}

/**
 * @brief Look up a tool definition by its unique name.
 * @param name Tool name as exposed to the LLM (e.g. \"terminal_exec\").
 * @returns Matching Tool instance or undefined when no tool is registered under that name.
 */
export function getToolByName(name: string): Tool | undefined {
  return TOOL_REGISTRY.find((r) => r.tool.name === name)?.tool;
}
