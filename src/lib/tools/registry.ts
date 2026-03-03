import path from "path";
import fs from "fs";
import { terminalTool } from "./terminal";
import { webSearchTool } from "./web-search";
import { braveAnswersTool } from "./brave-answers";
import { webResearchTool } from "./web-research";
import { fetchWebPageTool } from "./fetch-web-page";
import { browserTools } from "./browser-tools";
import { messagingTools } from "./messaging";
import { historyTools } from "./history-tool";
import { knowledgeTools } from "./knowledge-tool";
import { findTool } from "./find-tool";
import { chainTool } from "./chain-tool";
import { smartContextTool } from "./smart-context-tool";
import { credentialTools } from "./credentials";
import { agentManagementTools } from "./agent-management";
import { cronTools } from "./cron-tool";
import { taskTrackerTools } from "./task-tracker";
import { yahooMailTools } from "./yahoo-mail";
import { dateTimeTools } from "./datetime";
import { customToolManagementTools } from "./custom-tools";
import { threadManagementTools } from "./thread-management";
import { fileCrudTools } from "./file-crud";
import type { Tool, ToolRegistration } from "./types";
import type { DbAdapter } from "../context";
import { getDb } from "../db";
import { getApprovedToolSlugs } from "./approved-tools";
import { getToolsDir } from "../data-dir";
import { parseManifest, buildToolsFromManifest } from "./custom-tool-manifest";

/**
 * @fileoverview Global registry and filtering helpers for Maia tools.
 * @module lib/tools/registry
 */

export const TOOL_REGISTRY: ToolRegistration[] = [
  { tool: findTool, maiaOnly: false },
  { tool: chainTool, maiaOnly: false },
  ...fileCrudTools.map((tool) => ({ tool, maiaOnly: false })),
  { tool: terminalTool, maiaOnly: false },
  { tool: webSearchTool, maiaOnly: false },
  { tool: braveAnswersTool, maiaOnly: false },
  { tool: webResearchTool, maiaOnly: false },
  { tool: fetchWebPageTool, maiaOnly: false },
  ...(process.env.BROWSER_TOOLS_ENABLED === "1"
    ? browserTools.map((tool) => ({ tool, maiaOnly: false }))
    : []),
  ...messagingTools.map((tool) => ({ tool, maiaOnly: false })),
  ...historyTools.map((tool) => ({ tool, maiaOnly: false })),
  ...knowledgeTools.map((tool) => ({ tool, maiaOnly: false })),
  { tool: smartContextTool, maiaOnly: false },
  ...credentialTools.map((tool) => ({ tool, maiaOnly: false })),
  ...taskTrackerTools.map((tool) => ({ tool, maiaOnly: false })),
  ...yahooMailTools.map((tool) => ({ tool, maiaOnly: false })),
  ...dateTimeTools.map((tool) => ({ tool, maiaOnly: false })),
  ...agentManagementTools.map((tool) => ({ tool, maiaOnly: true })),
  ...cronTools.map((tool) => ({ tool, maiaOnly: true })),
  ...customToolManagementTools.map((tool) => ({ tool, maiaOnly: true })),
  ...threadManagementTools.map((tool) => ({ tool, maiaOnly: true })),
];

const BUILT_IN_TOOL_NAMES = new Set(TOOL_REGISTRY.map((r) => r.tool.name));

type ReadFileFn = (filePath: string) => string;

/**
 * Load approved custom tools given db and a function to read manifest file contents.
 * Skips any custom tool whose function name clashes with a built-in tool name.
 * @param db - Database adapter (approved_tools table)
 * @param toolsDir - Root directory for tools (e.g. getToolsDir())
 * @param readFile - Sync read of manifest file (e.g. fs.readFileSync(path, "utf-8"))
 * @returns Array of Tool instances from approved manifests
 */
export function loadApprovedCustomTools(
  db: DbAdapter,
  toolsDir: string,
  readFile: ReadFileFn,
): Tool[] {
  const slugs = getApprovedToolSlugs(db);
  const result: Tool[] = [];
  const seenNames = new Set(BUILT_IN_TOOL_NAMES);

  for (const slug of slugs) {
    try {
      const manifestPath = path.join(toolsDir, slug, "manifest.json");
      const content = readFile(manifestPath);
      const manifest = parseManifest(content);
      const customTools = buildToolsFromManifest(slug, manifest);
      for (const t of customTools) {
        if (!seenNames.has(t.name)) {
          result.push(t);
          seenNames.add(t.name);
        }
      }
    } catch {
      // Skip missing or invalid manifest
    }
  }
  return result;
}

/**
 * Load approved custom tools from data/tools/<slug>/manifest.json.
 * Returns [] when db or fs is unavailable (e.g. in some test environments).
 */
function getApprovedCustomTools(): Tool[] {
  try {
    const db = getDb();
    const toolsDir = getToolsDir();
    return loadApprovedCustomTools(db, toolsDir, (p) =>
      fs.readFileSync(p, "utf-8"),
    );
  } catch {
    return [];
  }
}

/** Tool names sent to the LLM by default; agents discover and invoke other tools via find_tool. */
const MINIMAL_DEFAULT_TOOL_NAMES = new Set([
  "find_tool",
  "chat_read",
  "chat_find",
  "terminal_exec",
]);

/** Maia-only tools included in the minimal set for the maia agent. */
const MAIA_MINIMAL_TOOL_NAMES = new Set([
  "agent_create",
  "agent_delete",
  "agent_list",
  "agent_get",
]);

/** Include terminal_exec Maia shell tool on all platforms. */
function isToolAvailableForPlatform(toolName: string): boolean {
  if (toolName === "terminal_exec") return true;
  return true;
}

/**
 * @brief Get the list of tools available to a specific agent.
 * @param agentId Agent identifier; some tools are restricted to the special \"maia\" orchestrator.
 * @returns Array of tools the given agent is allowed to use (built-in + approved custom tools).
 */
export function getToolsForAgent(agentId: string): Tool[] {
  const staticTools = TOOL_REGISTRY.filter(
    (reg) =>
      (!reg.maiaOnly || agentId === "maia") && isToolAvailableForPlatform(reg.tool.name),
  ).map((reg) => reg.tool);
  const customTools = getApprovedCustomTools();
  return [...staticTools, ...customTools];
}

/**
 * @brief Get the minimal tool definitions to send to the LLM (find_tool, chat_read, chat_find, terminal; for maia also agent management).
 * The runner uses this so the model discovers other tools via find_tool; tool execution still resolves by name from getToolsForAgent.
 * @param agentId - Agent id (maia gets additional agent-management tools in the minimal set).
 * @returns Tool definitions for the minimal set only.
 */
export function getMinimalToolDefsForAgent(agentId: string): import("../ai/types").ToolDefinition[] {
  const tools = getToolsForAgent(agentId);
  const names = new Set(MINIMAL_DEFAULT_TOOL_NAMES);
  if (agentId === "maia") {
    for (const n of MAIA_MINIMAL_TOOL_NAMES) names.add(n);
  }
  return tools.filter((t) => names.has(t.name)).map((t) => t.toDefinition());
}

/**
 * @brief Look up a tool definition by its unique name.
 * @param name Tool name as exposed to the LLM (e.g. \"terminal_exec\").
 * @returns Matching Tool instance or undefined when no tool is registered under that name.
 */
export function getToolByName(name: string): Tool | undefined {
  const fromRegistry = TOOL_REGISTRY.find((r) => r.tool.name === name)?.tool;
  if (fromRegistry) return fromRegistry;
  const custom = getApprovedCustomTools().find((t) => t.name === name);
  return custom;
}
