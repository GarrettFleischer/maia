/**
 * @fileoverview File CRUD tools for workspace, knowledge base, and custom tools.
 * @module lib/tools/file-crud
 *
 * Agent workflow: (1) Check the directory first — use file_list before any write.
 * (2) Read before write — when editing an existing file, use file_read then file_write
 * with the full new content. Tool descriptions are written so the LLM sees these requirements.
 *
 * Path roots: Paths are relative to your agent directory (agents/<id>/). Your working
 * directory for saving files is the workspace: use the workspace/ prefix (e.g. workspace/notes.md).
 * Paths starting with "knowledge/" or "tools/" resolve to the shared knowledge base or custom tools.
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
 * @param userPath - Path from the tool (relative to agent directory, or knowledge/..., or tools/...)
 * @param volumeRoot - Agent directory (identity + workspace/); paths use workspace/ for working files
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
  "Read the contents of a file. REQUIRED before editing: when modifying an existing file, call file_read first to get current content, then use file_write with the full new content. Do not call file_write without reading first if the file may already exist. Example: file_read({ path: 'workspace/notes.md' }).",
  z.object({
    path: z
      .string()
      .describe(
        "Path relative to your agent directory; use workspace/ for your working files (e.g. workspace/notes.md)",
      ),
  }),
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
  "Write or overwrite a file. REQUIRED: (1) Use file_list to check the directory first. (2) If the file may already exist and you are editing it, use file_read first, then file_write with the complete new content. Prefer this over terminal for writing files. Example: file_write({ path: 'workspace/notes.md', content: 'Hello' }).",
  z.object({
    path: z
      .string()
      .describe(
        "Path relative to your agent directory; use workspace/ for your working files (e.g. workspace/notes.md)",
      ),
    content: z.string().describe("Content to write"),
  }),
  async ({ path: p, content }, ctx) => {
    const full = resolvePath(p, ctx.volumeRoot);
    assertNotUnderRegisteredTool(full, ctx);
    ctx.fs.mkdirp(path.dirname(full));
    ctx.fs.writeFile(full, content);
    return { ok: true, path: p };
  },
);

export const fileAppendTool = makeFileTool(
  "file_append",
  "Append content to a file. REQUIRED: Use file_list to check the directory first; use file_exists or file_read to verify the file exists before appending. Example: file_append({ path: 'workspace/log.txt', content: '\\nNew line' }).",
  z.object({
    path: z
      .string()
      .describe(
        "Path relative to your agent directory; use workspace/ for your working files",
      ),
    content: z.string().describe("Content to append"),
  }),
  async ({ path: p, content }, ctx) => {
    const full = resolvePath(p, ctx.volumeRoot);
    assertNotUnderRegisteredTool(full, ctx);
    ctx.fs.mkdirp(path.dirname(full));
    ctx.fs.appendFile(full, content);
    return { ok: true, path: p };
  },
);

export const fileDeleteTool = makeFileTool(
  "file_delete",
  "Delete a file or empty directory. REQUIRED: Use file_list to check the directory first and verify the exact path before deleting. Example: file_delete({ path: 'workspace/temp.txt' }).",
  z.object({
    path: z
      .string()
      .describe(
        "Path relative to your agent directory; use workspace/ for your working files",
      ),
  }),
  async ({ path: p }, ctx) => {
    const full = resolvePath(p, ctx.volumeRoot);
    assertNotUnderRegisteredTool(full, ctx);
    ctx.fs.deleteFile(full);
    return { ok: true, path: p };
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
  "List all files and folders under your agent directory (identity files and workspace/). Your working directory for saving files is workspace/—paths there appear as workspace/.... REQUIRED before any write: call file_list first to verify paths. Example: file_list({}).",
  z.object({}),
  async (_args, ctx) => {
    return listRecursive(ctx.fs, ctx.volumeRoot, ctx.volumeRoot, "");
  },
);

export const fileMoveTool = makeFileTool(
  "file_move",
  "Move or rename a file. REQUIRED: Use file_list to check the directory first and verify both source and destination paths exist (or parent of destination). Example: file_move({ from: 'workspace/old.md', to: 'workspace/new.md' }).",
  z.object({
    from: z
      .string()
      .describe(
        "Source path relative to your agent directory; use workspace/ for your files",
      ),
    to: z
      .string()
      .describe(
        "Destination path relative to your agent directory; use workspace/ for your files",
      ),
  }),
  async ({ from, to }, ctx) => {
    const fullFrom = resolvePath(from, ctx.volumeRoot);
    const fullTo = resolvePath(to, ctx.volumeRoot);
    assertNotUnderRegisteredTool(fullFrom, ctx);
    assertNotUnderRegisteredTool(fullTo, ctx);
    ctx.fs.mkdirp(path.dirname(fullTo));
    ctx.fs.rename(fullFrom, fullTo);
    return { ok: true, from, to };
  },
);

export const fileExistsTool = makeFileTool(
  "file_exists",
  "Check whether a file or directory exists. Use before file_append or when you need to confirm a path from file_list. Example: file_exists({ path: 'workspace/notes.md' }).",
  z.object({
    path: z
      .string()
      .describe(
        "Path relative to your agent directory; use workspace/ for your working files",
      ),
  }),
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
  "Create a directory (and parents as needed). REQUIRED: Use file_list to check the directory first and verify the parent path. Prefer this over terminal for mkdir. Example: directory_create({ path: 'workspace/docs' }).",
  z.object({
    path: z
      .string()
      .describe(
        "Directory path relative to your agent directory (e.g. workspace/docs) or under knowledge/ (e.g. knowledge/jurisdictions)",
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
