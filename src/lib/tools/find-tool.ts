/**
 * @fileoverview find_tool: vector search over available tools for the current agent.
 * Returns tool definitions (name, description, parameters) that match the query.
 * @module lib/tools/find-tool
 */

import { z } from "zod";
import { zodToJsonSchema } from "../zod-to-json";
import { getSettings } from "../settings";
import { createEmbeddingAdapter } from "../knowledge/embedding";
import type { Tool, ToolContext } from "./types";
import type { ToolDefinition } from "../ai/types";

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

const findToolSchema = z.object({
  q: z.string().describe("What you want to do"),
  limit: z.number().int().min(1).max(20).optional().describe("Max tools to return (default 5)"),
});

export const findTool: Tool<z.infer<typeof findToolSchema>, ToolDefinition[]> = {
  name: "find_tool",
  description: "Find tools by natural language. Returns tool definitions (name, description, parameters) that match what you want to do. Use this to discover available tools before calling them. Example: find_tool({ q: 'search the web' }).",
  schema: findToolSchema,
  async execute(args, ctx): Promise<ToolDefinition[]> {
    const { q: query, limit = 5 } = args;
    const tools = ctx.getToolsForAgent ? ctx.getToolsForAgent(ctx.agentId) : [];
    if (tools.length === 0) return [];

    const settings = getSettings(ctx);
    const embedder = createEmbeddingAdapter(settings, ctx.http);
    const texts = tools.map((t) => `${t.name} ${t.description}`);
    const embedBatch: (texts: string[]) => Promise<number[][]> =
      embedder.embedBatch ??
      (async (texts: string[]) => {
        const out: number[][] = [];
        for (const text of texts) out.push(await embedder.embed(text));
        return out;
      });
    const [toolEmbeddings, queryEmbedding] = await Promise.all([
      embedBatch(texts),
      embedder.embed(args.q),
    ]);

    const withScore = tools.map((t, i) => ({
      tool: t,
      score: cosineSimilarity(queryEmbedding, toolEmbeddings[i] ?? []),
    }));
    withScore.sort((a, b) => b.score - a.score);
    return withScore.slice(0, limit).map(({ tool }) => tool.toDefinition());
  },
  toDefinition: () => ({
    name: "find_tool",
    description: "Find tools by natural language. Returns tool definitions (name, description, parameters) that match what you want to do. Use this to discover available tools before calling them. Example: find_tool({ q: 'search the web' }).",
    parameters: zodToJsonSchema(findToolSchema),
  }),
};
