import { fileCrudTools } from "./file-crud";
import { terminalTool } from "./terminal";
import { webSearchTool } from "./web-search";
import { fetchWebPageTool } from "./fetch-web-page";
import { browserTools } from "./browser-tools";
import { messagingTools } from "./messaging";
import { historyTools } from "./history-tool";
import { knowledgeTools } from "./knowledge-tool";
import { credentialTools } from "./credentials";
import { agentManagementTools, agentIdentityTools } from "./agent-management";
import { cronTools } from "./cron-tool";
import type { Tool, ToolRegistration } from "./types";

export const TOOL_REGISTRY: ToolRegistration[] = [
  ...fileCrudTools.map((tool) => ({ tool, maiaOnly: false })),
  { tool: terminalTool, maiaOnly: false },
  { tool: webSearchTool, maiaOnly: false },
  { tool: fetchWebPageTool, maiaOnly: false },
  ...(process.env.BROWSER_TOOLS_ENABLED === "1"
    ? browserTools.map((tool) => ({ tool, maiaOnly: false }))
    : []),
  ...messagingTools.map((tool) => ({ tool, maiaOnly: false })),
  ...historyTools.map((tool) => ({ tool, maiaOnly: false })),
  ...knowledgeTools.map((tool) => ({ tool, maiaOnly: false })),
  ...credentialTools.map((tool) => ({ tool, maiaOnly: false })),
  ...agentManagementTools.map((tool) => ({ tool, maiaOnly: true })),
  ...agentIdentityTools.map((tool) => ({ tool, maiaOnly: false })),
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
