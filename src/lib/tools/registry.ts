import { fileCrudTools } from "./file-crud";
import { terminalTool } from "./terminal";
import { webSearchTool } from "./web-search";
import { messagingTools } from "./messaging";
import { historyTools } from "./history-tool";
import { credentialTools } from "./credentials";
import { agentManagementTools } from "./agent-management";
import { cronTools } from "./cron-tool";
import type { Tool, ToolRegistration } from "./types";

export const TOOL_REGISTRY: ToolRegistration[] = [
  ...fileCrudTools.map((tool) => ({ tool, maiaOnly: false })),
  { tool: terminalTool, maiaOnly: false },
  { tool: webSearchTool, maiaOnly: false },
  ...messagingTools.map((tool) => ({ tool, maiaOnly: false })),
  ...historyTools.map((tool) => ({ tool, maiaOnly: false })),
  ...credentialTools.map((tool) => ({ tool, maiaOnly: false })),
  ...agentManagementTools.map((tool) => ({ tool, maiaOnly: true })),
  ...cronTools.map((tool) => ({ tool, maiaOnly: true })),
];

export function getToolsForAgent(agentId: string): Tool[] {
  return TOOL_REGISTRY.filter(
    (reg) => !reg.maiaOnly || agentId === "maia"
  ).map((reg) => reg.tool);
}

export function getToolByName(name: string): Tool | undefined {
  return TOOL_REGISTRY.find((r) => r.tool.name === name)?.tool;
}
