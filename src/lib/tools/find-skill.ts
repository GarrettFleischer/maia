/**
 * @fileoverview find_skill: vector search over available skills for the current agent.
 * Returns skill name, description, and content that match the query.
 * @module lib/tools/find-skill
 */

import { z } from "zod";
import { zodToJsonSchema } from "../zod-to-json";
import { getSettings } from "../settings";
import { createEmbeddingAdapter } from "../knowledge/embedding";
import { cosineSimilarity } from "../knowledge/vector-store";
import { getAvailableSkillsMetadata } from "../skills/discovery";
import { loadSkillContent } from "../skills/discovery";
import { filterSkillsForAgent } from "../skills/match";
import type { Tool, ToolContext } from "./types";

/** Result for one skill returned by find_skill (name, description, and full markdown content). */
export interface FindSkillResult {
  name: string;
  description: string;
  content: string;
}

const findSkillSchema = z.object({
  q: z
    .string()
    .describe(
      "What you want to do or learn (e.g. 'search the web', 'save memories').",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(20)
    .optional()
    .describe("Max skills to return (default 5)"),
});

export const findSkill: Tool<
  z.infer<typeof findSkillSchema>,
  FindSkillResult[]
> = {
  name: "find_skill",
  description:
    "Find skills by natural language. Returns skill name, description, and full content that match what you want to do or learn. Use this to discover available skills (operational guidance) before or during a task. Example: find_skill({ q: 'how to save memories' }).",
  schema: findSkillSchema,
  async execute(args, ctx): Promise<FindSkillResult[]> {
    const { q: query, limit = 5 } = args;
    const rawMetadata = getAvailableSkillsMetadata(ctx, ctx.agentId);
    const metadata = filterSkillsForAgent(rawMetadata, ctx.agentId);
    if (metadata.length === 0) return [];

    const settings = getSettings(ctx);
    const embedder = createEmbeddingAdapter(settings, ctx.http);
    const texts = metadata.map((m) => `${m.name} ${m.description}`);
    const embedBatch: (texts: string[]) => Promise<number[][]> =
      embedder.embedBatch ??
      (async (texts: string[]) => {
        const out: number[][] = [];
        for (const text of texts) out.push(await embedder.embed(text));
        return out;
      });
    const [skillEmbeddings, queryEmbedding] = await Promise.all([
      embedBatch(texts),
      embedder.embed(query),
    ]);

    const withScore = metadata.map((m, i) => ({
      meta: m,
      score: cosineSimilarity(queryEmbedding, skillEmbeddings[i] ?? []),
    }));
    withScore.sort((a, b) => b.score - a.score);
    const top = withScore.slice(0, limit);

    const results: FindSkillResult[] = [];
    for (const { meta } of top) {
      const skill = loadSkillContent(ctx.fs, meta.sourcePath);
      if (!skill?.content.trim()) continue;
      results.push({
        name: skill.name,
        description: skill.description,
        content: skill.content.trim(),
      });
    }
    return results;
  },
  toDefinition: () => ({
    name: "find_skill",
    description:
      "Find skills by natural language. Returns skill name, description, and full content that match what you want to do or learn. Use this to discover available skills (operational guidance) before or during a task. Example: find_skill({ q: 'how to save memories' }).",
    parameters: zodToJsonSchema(findSkillSchema),
  }),
};
