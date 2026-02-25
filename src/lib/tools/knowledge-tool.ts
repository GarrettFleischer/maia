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
  "Semantic search over the knowledge base (markdown reports under knowledge/). Returns the most relevant documents. Use this to find stored reports and durable knowledge.",
  z.object({
    query: z.string().describe("Natural language search query"),
    limit: z.number().min(1).max(20).optional().describe("Max results (default 5)"),
  }),
  async ({ query, limit }, ctx) => {
    const settings = getSettings(ctx);
    const embedder = createEmbeddingAdapter(settings, ctx.http);
    return searchKnowledge(ctx, embedder, query, limit ?? 5);
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

export const knowledgeTools: Tool[] = [knowledgeSearchTool, historySemanticSearchTool];
