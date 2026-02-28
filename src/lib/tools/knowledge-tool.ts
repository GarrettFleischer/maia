/**
 * @fileoverview Tools for semantic search over the knowledge base and session history.
 * @module lib/tools/knowledge-tool
 */

import { z } from "zod";
import { zodToJsonSchema } from "../zod-to-json";
import { createEmbeddingAdapter } from "../knowledge/embedding";
import { searchKnowledge, searchHistory } from "../knowledge/search";
import { getSettings } from "../settings";
import type { Tool, ToolContext } from "./types";

function makeTool<S extends z.ZodTypeAny>(
  name: string,
  description: string,
  schema: S,
  execute: (args: z.infer<S>, ctx: ToolContext) => Promise<unknown>
): Tool<z.infer<S>> {
  return {
    name,
    description,
    schema,
    execute,
    toDefinition: () => ({ name, description, parameters: zodToJsonSchema(schema) }),
  };
}

export const knowledgeSearchTool = makeTool(
  "knowledge_search",
  "Semantic search over indexed files under the data folder (agent workspace, memory, user folders, and data/user). Returns the most relevant documents with last_modified. Use scope: self for your own files, user for data/user, global for all, or an agent id for another agent. By default archived files (older than the configured duration) are excluded; set include_archived true to include them.",
  z.object({
    query: z.string().describe("Natural language search query"),
    limit: z.number().min(1).max(20).optional().describe("Max results (default 5)"),
    scope: z
      .enum(["self", "user", "global"])
      .or(z.string())
      .optional()
      .describe("Scope: self (current agent), user (data/user), global (all), or another agent id. Default self."),
    include_archived: z
      .boolean()
      .optional()
      .describe("Include files older than the archive duration. Default false. Results always include last_modified."),
  }),
  async ({ query, limit, scope, include_archived }, ctx) => {
    const settings = getSettings(ctx);
    const embedder = createEmbeddingAdapter(settings, ctx.http);
    return searchKnowledge(ctx, embedder, query, limit ?? 5, {
      scope: scope ?? "self",
      includeArchived: include_archived ?? false,
      agentId: ctx.agentId,
    });
  }
);

export const historySemanticSearchTool = makeTool(
  "history_semantic_search",
  "Semantic search over past session history. Returns the most relevant past messages or tool results. Use when you need to find something by meaning rather than keywords.",
  z.object({
    query: z.string().describe("Natural language search query"),
    limit: z.number().min(1).max(20).optional().describe("Max results (default 5)"),
  }),
  async ({ query, limit }, ctx) => {
    const settings = getSettings(ctx);
    const embedder = createEmbeddingAdapter(settings, ctx.http);
    return searchHistory(ctx, embedder, query, limit ?? 5);
  }
);

export const chatFindTool = makeTool(
  "chat_find",
  "Semantic search over chat history (current and past sessions). Returns relevant past messages with sessionId, entryId, content, and score. Use when you need to find something by meaning rather than keywords.",
  z.object({
    query: z.string().describe("Natural language search query"),
    limit: z.number().min(1).max(20).optional().describe("Max results (default 5)"),
  }),
  async ({ query, limit }, ctx) => {
    const settings = getSettings(ctx);
    const embedder = createEmbeddingAdapter(settings, ctx.http);
    return searchHistory(ctx, embedder, query, limit ?? 5);
  }
);

export const knowledgeTools: Tool[] = [knowledgeSearchTool, historySemanticSearchTool, chatFindTool];
