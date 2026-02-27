/**
 * @fileoverview File CRUD tools for workspace, knowledge base, and custom tools.
 * @module lib/tools/file-crud
 *
 * Paths starting with "knowledge/" resolve to the shared knowledge base (data/knowledge/).
 * Paths starting with "tools/" resolve to the custom tools directory (data/tools/).
 * Otherwise paths are relative to the agent workspace volume.
 */
import { z } from "zod";
import path from "path";
import { zodToJsonSchema } from "../zod-to-json";
import type { Tool, ToolContext } from "./types";

import { getKnowledgeDir, getToolsDir } from "../data-dir";
import { isToolRegistered } from "./approved-tools";

const KNOWLEDGE_DIR = getKnowledgeDir();
const KNOWLEDGE_PREFIX = "knowledge/";
const TOOLS_DIR = getToolsDir();
const TOOLS_PREFIX = "tools/";

/**
 * Resolve user path to a full path.
 * - "knowledge" or "knowledge/..." -> data/knowledge/
 * - "tools" or "tools/..." -> data/tools/
 * - Otherwise resolve relative to volumeRoot and ensure it stays under volumeRoot.
 * @param userPath - Path from the tool (relative to workspace, or knowledge/..., or tools/...)
 * @param volumeRoot - Agent workspace root
 * @returns Absolute path; throws if path escapes allowed roots
 */
function resolvePath(userPath: string, volumeRoot: string): string {
  const normalized = userPath.replace(/\\/g, "/").trim();
  if (normalized === "knowledge" || normalized.startsWith(KNOWLEDGE_PREFIX)) {
    const suffix =
      normalized === "knowledge"
        ? ""
        : normalized.slice(KNOWLEDGE_PREFIX.length);
    return path.join(KNOWLEDGE_DIR, suffix);
  }
  if (normalized === "tools" || normalized.startsWith(TOOLS_PREFIX)) {
    const suffix =
      normalized === "tools" ? "" : normalized.slice(TOOLS_PREFIX.length);
    const resolved = path.join(TOOLS_DIR, suffix);
    const toolsDirResolved = path.resolve(TOOLS_DIR);
    if (!path.resolve(resolved).startsWith(toolsDirResolved)) {
      throw new Error("Path escapes tools directory");
    }
    return path.resolve(resolved);
  }
  const resolved = path.resolve(volumeRoot, userPath);
  if (!resolved.startsWith(path.resolve(volumeRoot))) {
    throw new Error("Path escapes workspace");
  }
  return resolved;
}

const TOOLS_DIR_RESOLVED = path.resolve(TOOLS_DIR);

/**
 * Throws if fullPath is under data/tools/<slug>/ and slug is a registered (approved) tool.
 * Call this for write operations so registered tools stay read-only.
 */
function assertNotUnderRegisteredTool(
  fullPath: string,
  ctx: ToolContext,
): void {
  const resolvedPath = path.resolve(fullPath);
  if (
    resolvedPath === TOOLS_DIR_RESOLVED ||
    !resolvedPath.startsWith(TOOLS_DIR_RESOLVED + path.sep)
  ) {
    return;
  }
  const relative = path.relative(TOOLS_DIR, resolvedPath);
  const slug = relative.split(path.sep)[0];
  if (slug && isToolRegistered(ctx.db, slug)) {
    throw new Error(
      "Registered tools are read-only; use tool_deregister first to allow edits.",
    );
  }
}

const MAX_OUTPUT = 50 * 1024; // 50KB

function makeFileTool<TSchema extends z.ZodTypeAny>(
  name: string,
  description: string,
  schema: TSchema,
  execute: (args: z.infer<TSchema>, context: ToolContext) => Promise<unknown>,
): Tool<z.infer<TSchema>> {
  return {
    name,
    description,
    schema,
    execute,
    toDefinition() {
      return { name, description, parameters: zodToJsonSchema(schema) };
    },
  };
}

export const fileReadTool = makeFileTool(
  "file_read",
  "Read the contents of a file within the workspace volume.",
  z.object({ path: z.string().describe("Path relative to workspace root") }),
  async ({ path: p }, ctx) => {
    const full = resolvePath(p, ctx.volumeRoot);
    const content = ctx.fs.readFile(full);
    return content.length > MAX_OUTPUT
      ? content.slice(0, MAX_OUTPUT) + "\n[truncated]"
      : content;
  },
);

export const fileWriteTool = makeFileTool(
  "file_write",
  "Write content to a file within the workspace volume. Creates or overwrites. Use file_list first to inspect the workspace and verify paths.",
  z.object({
    path: z.string().describe("Path relative to workspace root"),
    content: z.string().describe("Content to write"),
  }),
  async ({ path: p, content }, ctx) => {
    const full = resolvePath(p, ctx.volumeRoot);
    assertNotUnderRegisteredTool(full, ctx);
    ctx.fs.mkdirp(path.dirname(full));
    ctx.fs.writeFile(full, content);
  },
);

export const fileAppendTool = makeFileTool(
  "file_append",
  "Append content to a file within the workspace volume. Use file_list first to inspect the workspace and verify the file exists.",
  z.object({
    path: z.string().describe("Path relative to workspace root"),
    content: z.string().describe("Content to append"),
  }),
  async ({ path: p, content }, ctx) => {
    const full = resolvePath(p, ctx.volumeRoot);
    assertNotUnderRegisteredTool(full, ctx);
    ctx.fs.mkdirp(path.dirname(full));
    ctx.fs.appendFile(full, content);
  },
);

export const fileDeleteTool = makeFileTool(
  "file_delete",
  "Delete a file or empty directory within the workspace volume. Use file_list first to inspect the workspace and verify the path before deleting.",
  z.object({ path: z.string().describe("Path relative to workspace root") }),
  async ({ path: p }, ctx) => {
    const full = resolvePath(p, ctx.volumeRoot);
    assertNotUnderRegisteredTool(full, ctx);
    ctx.fs.deleteFile(full);
  },
);

/**
 * Recursively list all files and directories under dir. Returns relative paths
 * (relative to volumeRoot). Directories are suffixed with "/".
 * Uses readFile to distinguish files from directories (readFile on a dir fails).
 * @param fs - File system adapter
 * @param volumeRoot - Root path (must be resolved)
 * @param dir - Current directory (full path) to list
 * @param rel - Current relative path prefix for results
 */
function listRecursive(
  fs: ToolContext["fs"],
  volumeRoot: string,
  dir: string,
  rel: string,
): string[] {
  let entries: string[];
  try {
    entries = fs.listDir(dir);
  } catch {
    return [];
  }
  const result: string[] = [];
  for (const name of entries) {
    const full = path.join(dir, name);
    const relPath = rel ? path.join(rel, name) : name;
    try {
      fs.readFile(full);
      result.push(relPath);
    } catch {
      result.push(relPath + path.sep);
      for (const subRel of listRecursive(fs, volumeRoot, full, relPath)) {
        result.push(subRel);
      }
    }
  }
  return result;
}

export const fileListTool = makeFileTool(
  "file_list",
  "List all files and folders in your workspace (your writable directory). No arguments; returns a recursive listing of everything under your workspace.",
  z.object({}),
  async (_args, ctx) => {
    return listRecursive(ctx.fs, ctx.volumeRoot, ctx.volumeRoot, "");
  },
);

export const fileMoveTool = makeFileTool(
  "file_move",
  "Move or rename a file within the workspace volume. Use file_list first to inspect the workspace and verify source/destination paths.",
  z.object({
    from: z.string().describe("Source path relative to workspace root"),
    to: z.string().describe("Destination path relative to workspace root"),
  }),
  async ({ from, to }, ctx) => {
    const fullFrom = resolvePath(from, ctx.volumeRoot);
    const fullTo = resolvePath(to, ctx.volumeRoot);
    assertNotUnderRegisteredTool(fullFrom, ctx);
    assertNotUnderRegisteredTool(fullTo, ctx);
    ctx.fs.mkdirp(path.dirname(fullTo));
    ctx.fs.rename(fullFrom, fullTo);
  },
);

export const fileExistsTool = makeFileTool(
  "file_exists",
  "Check whether a file or directory exists within the workspace volume.",
  z.object({ path: z.string().describe("Path relative to workspace root") }),
  async ({ path: p }, ctx) => {
    const full = resolvePath(p, ctx.volumeRoot);
    return ctx.fs.exists(full);
  },
);

/**
 * Create a directory (and any missing parent directories). Path may be under
 * the workspace volume or under knowledge/ (shared knowledge base).
 */
export const directoryCreateTool = makeFileTool(
  "directory_create",
  "Create a directory within the workspace or knowledge base. Creates parent directories as needed. Use file_list first to inspect the workspace and verify the parent path. Use this instead of terminal_exec for mkdir.",
  z.object({
    path: z
      .string()
      .describe(
        "Directory path relative to workspace root, or under knowledge/ (e.g. knowledge/jurisdictions)",
      ),
  }),
  async ({ path: p }, ctx) => {
    const full = resolvePath(p, ctx.volumeRoot);
    assertNotUnderRegisteredTool(full, ctx);
    ctx.fs.mkdirp(full);
    return { created: full };
  },
);

export const fileCrudTools: Tool[] = [
  fileReadTool,
  fileWriteTool,
  fileAppendTool,
  fileDeleteTool,
  fileListTool,
  fileMoveTool,
  fileExistsTool,
  directoryCreateTool,
];
