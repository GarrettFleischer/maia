/**
 * @fileoverview Semantic matching of skills to user message via embeddings and cosine similarity.
 * @module lib/skills/match
 */

import type { AppContext } from "../context";
import type { SkillMetadata } from "./types";
import { getSettings } from "../settings";
import { createEmbeddingAdapter } from "../knowledge/embedding";
import type { EmbeddingAdapter } from "../knowledge/embedding";
import { cosineSimilarity } from "../knowledge/vector-store";
import { getAvailableSkillsMetadata } from "./discovery";
import { loadSkillContent } from "./discovery";

const DEFAULT_TOP_K = 5;
const DEFAULT_MIN_SCORE = 0;

export interface MatchSkillsOptions {
  topK?: number;
  minScore?: number;
  /** For tests: inject embedder instead of creating from settings. */
  embedder?: EmbeddingAdapter;
}

/**
 * Build searchable text for a skill (used for embedding).
 * @param meta - Skill metadata
 * @returns Single string to embed
 */
function skillToSearchText(meta: SkillMetadata): string {
  return `${meta.name} ${meta.description}`;
}

/**
 * Match skills to the user message by semantic similarity.
 * Embeds the message and each skill's name+description, ranks by cosine similarity, returns top-k above minScore.
 * On embed failure (e.g. service down), returns [].
 * @param ctx - App context (settings, http; or use options.embedder for tests)
 * @param metadata - Available skill metadata
 * @param userMessage - Current user message
 * @param options - topK (default 5), minScore (default 0), optional embedder for tests
 * @returns Subset of metadata ordered by score descending
 */
export async function matchSkillsToMessage(
  ctx: AppContext,
  metadata: SkillMetadata[],
  userMessage: string,
  options: MatchSkillsOptions = {},
): Promise<SkillMetadata[]> {
  const { topK = DEFAULT_TOP_K, minScore = DEFAULT_MIN_SCORE, embedder: injectedEmbedder } = options;

  if (metadata.length === 0) return [];

  let embedder: EmbeddingAdapter;
  if (injectedEmbedder) {
    embedder = injectedEmbedder;
  } else {
    try {
      const settings = getSettings(ctx);
      embedder = createEmbeddingAdapter(settings, ctx.http);
    } catch {
      return [];
    }
  }

  try {
    const queryEmbedding = await embedder.embed(userMessage);
    const skillTexts = metadata.map(skillToSearchText);
    const batch =
      typeof embedder.embedBatch === "function"
        ? await embedder.embedBatch(skillTexts)
        : await Promise.all(skillTexts.map((t) => embedder.embed(t)));

    if (batch.length !== metadata.length) return [];

    const scored = metadata.map((meta, i) => ({
      meta,
      score: cosineSimilarity(queryEmbedding, batch[i]),
    }));
    const filtered = scored.filter((s) => s.score >= minScore);
    filtered.sort((a, b) => b.score - a.score);
    return filtered.slice(0, topK).map((s) => s.meta);
  } catch {
    return [];
  }
}

/**
 * Get matched skills content for the system prompt: discover skills, match to user message,
 * load full body for matched only, return a single markdown block.
 * @param ctx - App context
 * @param agentId - Agent identifier
 * @param userMessage - Current user message
 * @param options - Optional match options (topK, minScore, embedder for tests)
 * @returns Markdown section "## Active skills" with per-skill subsections, or "" if none matched
 */
export async function getMatchedSkillsContent(
  ctx: AppContext,
  agentId: string,
  userMessage: string,
  options: MatchSkillsOptions = {},
): Promise<string> {
  const metadata = getAvailableSkillsMetadata(ctx, agentId);
  const matched = await matchSkillsToMessage(ctx, metadata, userMessage, options);
  if (matched.length === 0) return "";

  const sections: string[] = [];
  for (const meta of matched) {
    const skill = loadSkillContent(ctx.fs, meta.sourcePath);
    if (!skill || !skill.content.trim()) continue;
    sections.push(`### ${skill.name}\n\n${skill.content.trim()}`);
  }
  if (sections.length === 0) return "";
  return `## Active skills\n\n${sections.join("\n\n")}`;
}
