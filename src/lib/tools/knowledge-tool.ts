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
  "Semantic search over indexed files (workspace, memory, user). Returns relevant docs with last_modified. Use scope: self, user, global, or agent id. Example: knowledge_search({ q: 'deployment steps', scope: 'self' }).",
  z.object({
    q: z.string().describe("Search query"),
    limit: z.number().min(1).max(20).optional().describe("Max results (default 5)"),
    scope: z.enum(["self", "user", "global"]).or(z.string()).optional().describe("self, user, global, or agent id"),
    include_archived: z.boolean().optional().describe("Include archived files"),
  }),
  async ({ q: query, limit, scope, include_archived }, ctx) => {
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
  "Semantic search over past session history. Example: history_semantic_search({ q: 'what did we decide about the API?' }).",
  z.object({
    q: z.string().describe("Search query"),
    limit: z.number().min(1).max(20).optional().describe("Max results (default 5)"),
  }),
  async ({ q: query, limit }, ctx) => {
    const settings = getSettings(ctx);
    const embedder = createEmbeddingAdapter(settings, ctx.http);
    return searchHistory(ctx, embedder, query, limit ?? 5);
  }
);

export const chatFindTool = makeTool(
  "chat_find",
  "Semantic search over chat history (current and past sessions). Returns relevant past messages. Example: chat_find({ q: 'what did we decide about the API?' }).",
  z.object({
    q: z.string().describe("Search query"),
    limit: z.number().min(1).max(20).optional().describe("Max results (default 5)"),
  }),
  async ({ q: query, limit }, ctx) => {
    const settings = getSettings(ctx);
    const embedder = createEmbeddingAdapter(settings, ctx.http);
    return searchHistory(ctx, embedder, query, limit ?? 5);
  }
);

export const knowledgeTools: Tool[] = [knowledgeSearchTool, historySemanticSearchTool, chatFindTool];
