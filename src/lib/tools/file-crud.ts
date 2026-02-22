/**
 * @fileoverview File CRUD tools for workspace and knowledge base.
 * @module lib/tools/file-crud
 *
 * Paths starting with "knowledge/" resolve to the shared knowledge base (data/knowledge/),
 * so agents can read/write reports there with the same file tools.
 */
import { z } from "zod";
import path from "path";
import { zodToJsonSchema } from "../zod-to-json";
import type { Tool, ToolContext } from "./types";

const KNOWLEDGE_DIR = path.join(process.cwd(), "data", "knowledge");
const KNOWLEDGE_PREFIX = "knowledge/";

/**
 * Resolve user path to a full path. If path is "knowledge" or "knowledge/...", resolve to data/knowledge/.
 * Otherwise resolve relative to volumeRoot and ensure it stays under volumeRoot.
 */
function resolvePath(userPath: string, volumeRoot: string): string {
  const normalized = userPath.replace(/\\/g, "/").trim();
  if (normalized === "knowledge" || normalized.startsWith(KNOWLEDGE_PREFIX)) {
    const suffix = normalized === "knowledge" ? "" : normalized.slice(KNOWLEDGE_PREFIX.length);
    return path.join(KNOWLEDGE_DIR, suffix);
  }
  const resolved = path.resolve(volumeRoot, userPath);
  if (!resolved.startsWith(path.resolve(volumeRoot))) {
    throw new Error("Path escapes workspace");
  }
  return resolved;
}

const MAX_OUTPUT = 50 * 1024; // 50KB

function makeFileTool<TSchema extends z.ZodTypeAny>(
  name: string,
  description: string,
  schema: TSchema,
  execute: (args: z.infer<TSchema>, context: ToolContext) => Promise<unknown>
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
    return content.length > MAX_OUTPUT ? content.slice(0, MAX_OUTPUT) + "\n[truncated]" : content;
  }
);

export const fileWriteTool = makeFileTool(
  "file_write",
  "Write content to a file within the workspace volume. Creates or overwrites.",
  z.object({
    path: z.string().describe("Path relative to workspace root"),
    content: z.string().describe("Content to write"),
  }),
  async ({ path: p, content }, ctx) => {
    const full = resolvePath(p, ctx.volumeRoot);
    ctx.fs.mkdirp(path.dirname(full));
    ctx.fs.writeFile(full, content);
  }
);

export const fileAppendTool = makeFileTool(
  "file_append",
  "Append content to a file within the workspace volume.",
  z.object({
    path: z.string().describe("Path relative to workspace root"),
    content: z.string().describe("Content to append"),
  }),
  async ({ path: p, content }, ctx) => {
    const full = resolvePath(p, ctx.volumeRoot);
    ctx.fs.mkdirp(path.dirname(full));
    ctx.fs.appendFile(full, content);
  }
);

export const fileDeleteTool = makeFileTool(
  "file_delete",
  "Delete a file or empty directory within the workspace volume.",
  z.object({ path: z.string().describe("Path relative to workspace root") }),
  async ({ path: p }, ctx) => {
    const full = resolvePath(p, ctx.volumeRoot);
    ctx.fs.deleteFile(full);
  }
);

export const fileListTool = makeFileTool(
  "file_list",
  "List files and directories within a directory in the workspace volume.",
  z.object({ directory: z.string().describe("Directory path relative to workspace root") }),
  async ({ directory }, ctx) => {
    const full = resolvePath(directory, ctx.volumeRoot);
    return ctx.fs.listDir(full);
  }
);

export const fileMoveTool = makeFileTool(
  "file_move",
  "Move or rename a file within the workspace volume.",
  z.object({
    from: z.string().describe("Source path relative to workspace root"),
    to: z.string().describe("Destination path relative to workspace root"),
  }),
  async ({ from, to }, ctx) => {
    const fullFrom = resolvePath(from, ctx.volumeRoot);
    const fullTo = resolvePath(to, ctx.volumeRoot);
    ctx.fs.mkdirp(path.dirname(fullTo));
    ctx.fs.rename(fullFrom, fullTo);
  }
);

export const fileExistsTool = makeFileTool(
  "file_exists",
  "Check whether a file or directory exists within the workspace volume.",
  z.object({ path: z.string().describe("Path relative to workspace root") }),
  async ({ path: p }, ctx) => {
    const full = resolvePath(p, ctx.volumeRoot);
    return ctx.fs.exists(full);
  }
);

export const fileCrudTools: Tool[] = [
  fileReadTool,
  fileWriteTool,
  fileAppendTool,
  fileDeleteTool,
  fileListTool,
  fileMoveTool,
  fileExistsTool,
];
