/**
 * @fileoverview File operations tools (read, write, list) scoped to the agent's workspace.
 * @module agent/tools/file-operations
 *
 * @brief Agents can read, write, and list files within their workspace. Paths are
 * relative to the workspace root; parent traversal (..) is rejected.
 */

import type { FileSystem, Logger } from "../../core/types.js";
import type { AgentTool, ToolContext, ToolResult } from "./base.js";

/**
 * @brief Normalizes and validates a path relative to workspace (rejects .. and absolute).
 * @param path - User-provided path
 * @returns Normalized relative path or null if invalid
 */
function resolveRelativePath(path: string): string | null {
  const trimmed = path.trim();
  if (!trimmed) return null;
  const normalized = trimmed.replace(/\\/g, "/").replace(/\/+/g, "/");
  if (normalized.startsWith("/") || normalized.includes("..")) return null;
  return normalized;
}

/**
 * @brief Dependencies for file operation tools.
 */
export interface FileOperationsToolDeps {
  fs: FileSystem;
  logger: Logger;
}

/**
 * @brief Creates the file_read tool.
 * @param deps - Dependencies: fs (workspace-scoped), logger
 * @returns AgentTool for reading files
 */
export function createFileReadTool(deps: FileOperationsToolDeps): AgentTool {
  const { fs, logger } = deps;

  return {
    name: "file_read",
    description: "Read a file from your workspace. Path is relative to your workspace root.",
    definition() {
      return {
        name: "file_read",
        description: "Read the contents of a file in your workspace. Path must be relative (no ..).",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Relative path to the file (e.g. MEMORY.md, notes/foo.txt)" },
          },
          required: ["path"],
        },
      };
    },

    async execute(args: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
      const path = resolveRelativePath((args.path as string) ?? "");
      if (!path) {
        return { content: "Invalid path: use a relative path without '..'.", success: false };
      }
      try {
        const exists = await fs.exists(path);
        if (!exists) {
          return { content: `File not found: ${path}`, success: false };
        }
        const content = await fs.readFile(path);
        return { content, success: true };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn("file_read failed", { path, error: msg });
        return { content: `Failed to read: ${msg}`, success: false };
      }
    },
  };
}

/**
 * @brief Creates the file_write tool.
 * @param deps - Dependencies: fs (workspace-scoped), logger
 * @returns AgentTool for writing files
 */
export function createFileWriteTool(deps: FileOperationsToolDeps): AgentTool {
  const { fs, logger } = deps;

  return {
    name: "file_write",
    description: "Write content to a file in your workspace. Creates parent directories if needed.",
    definition() {
      return {
        name: "file_write",
        description: "Write or overwrite a file in your workspace. Path must be relative. Creates parent dirs if needed.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Relative path to the file" },
            content: { type: "string", description: "Content to write" },
          },
          required: ["path", "content"],
        },
      };
    },

    async execute(args: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
      const path = resolveRelativePath((args.path as string) ?? "");
      if (!path) {
        return { content: "Invalid path: use a relative path without '..'.", success: false };
      }
      const content = typeof args.content === "string" ? args.content : String(args.content ?? "");
      try {
        const dir = path.slice(0, Math.max(path.lastIndexOf("/"), 0));
        if (dir) {
          await fs.mkdir(dir).catch(() => {});
        }
        await fs.writeFile(path, content);
        return { content: `Wrote ${path} (${content.length} bytes).`, success: true };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn("file_write failed", { path, error: msg });
        return { content: `Failed to write: ${msg}`, success: false };
      }
    },
  };
}

/**
 * @brief Creates the file_list tool.
 * @param deps - Dependencies: fs (workspace-scoped), logger
 * @returns AgentTool for listing directory contents
 */
export function createFileListTool(deps: FileOperationsToolDeps): AgentTool {
  const { fs, logger } = deps;

  return {
    name: "file_list",
    description: "List entries in a directory in your workspace. Path is relative to workspace root.",
    definition() {
      return {
        name: "file_list",
        description: "List files and directories at the given path. Use '.' or '' for workspace root.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Relative path to the directory (default: .)" },
          },
          required: [],
        },
      };
    },

    async execute(args: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
      const raw = (args.path as string) ?? ".";
      const path = raw.trim() === "" ? "." : resolveRelativePath(raw);
      if (path === null) {
        return { content: "Invalid path: use a relative path without '..'.", success: false };
      }
      try {
        const entries = await fs.readDir(path);
        if (entries.length === 0) {
          return { content: `Directory is empty: ${path}`, success: true };
        }
        const lines = entries.slice().sort();
        return { content: lines.join("\n"), success: true };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn("file_list failed", { path, error: msg });
        return { content: `Failed to list: ${msg}`, success: false };
      }
    },
  };
}
