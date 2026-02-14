/**
 * @fileoverview Loader for dynamic (agent-created) tools from the tools folder.
 * @module tools/loader
 *
 * @brief Discovers tool subfolders, reads manifest.json, and loads TypeScript
 * modules that export a createTool(deps) => AgentTool. Used to register
 * approved tools for Maia and all subagents.
 */

import { pathToFileURL } from "node:url";
import type { FileSystem, Logger } from "../core/types.js";
import type { AgentTool } from "../agent/tools/base.js";

/**
 * @brief Manifest schema for a dynamic tool (one tool per folder).
 */
export interface DynamicToolManifest {
  name: string;
  description: string;
  functions: Array<{
    name: string;
    description: string;
    parametersSchema: Record<string, unknown>;
    resultDescription?: string;
  }>;
}

/**
 * @brief Dependencies passed to each dynamic tool's createTool.
 */
export interface DynamicToolDeps {
  logger: Logger;
}

/**
 * @brief Module contract: dynamic tool index.ts must export createTool.
 */
export interface DynamicToolModule {
  createTool(deps: DynamicToolDeps): AgentTool;
}

/**
 * @brief Loads all dynamic tools from a directory. Each subfolder must contain
 * manifest.json and index.ts that exports createTool(deps) => AgentTool.
 * @param fs - Filesystem to read from
 * @param toolsDir - Absolute path to the tools directory (e.g. workspace/tools)
 * @param deps - Dependencies passed to each tool's createTool
 * @returns Array of AgentTool instances; empty if dir missing or no valid tools
 *
 * @example
 * const tools = await loadDynamicTools(fs, `${workspacePath}/tools`, { logger });
 * for (const tool of tools) toolRegistry.register(tool);
 */
export async function loadDynamicTools(
  fs: FileSystem,
  toolsDir: string,
  deps: DynamicToolDeps
): Promise<AgentTool[]> {
  const { logger } = deps;
  const exists = await fs.exists(toolsDir);
  if (!exists) return [];

  let entries: string[];
  try {
    entries = await fs.readDir(toolsDir);
  } catch {
    return [];
  }

  const tools: AgentTool[] = [];
  for (const name of entries) {
    const dirPath = `${toolsDir}/${name}`;
    const manifestPath = `${dirPath}/manifest.json`;
    const indexPath = `${dirPath}/index.ts`;

    const [hasManifest, hasIndex] = await Promise.all([
      fs.exists(manifestPath),
      fs.exists(indexPath),
    ]);
    if (!hasManifest || !hasIndex) continue;

    try {
      const manifestRaw = await fs.readFile(manifestPath);
      const manifest = JSON.parse(manifestRaw) as DynamicToolManifest;
      if (!manifest.name || !manifest.description) {
        logger.warn("Dynamic tool manifest missing name or description", { dir: name });
        continue;
      }

      const moduleUrl = pathToFileURL(indexPath).href;
      const mod = (await import(moduleUrl)) as DynamicToolModule;
      if (typeof mod.createTool !== "function") {
        logger.warn("Dynamic tool module does not export createTool", { dir: name });
        continue;
      }

      const tool = mod.createTool(deps);
      tools.push(tool);
      logger.debug("Dynamic tool loaded", { name: tool.name, dir: name });
    } catch (err) {
      logger.warn("Failed to load dynamic tool", {
        dir: name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return tools;
}
