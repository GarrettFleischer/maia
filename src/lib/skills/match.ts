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
import type { ProviderFactory } from "../agent/context-query";

const DEFAULT_TOP_K = 5;
const DEFAULT_MIN_SCORE = 0;

export interface MatchSkillsOptions {
  topK?: number;
  minScore?: number;
  /** For tests: inject embedder instead of creating from settings. */
  embedder?: EmbeddingAdapter;
  /** Optional provider factory for LLM-based skill selection. */
  providerFactory?: ProviderFactory;
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
 * @brief Select relevant skills using a cheap LLM over skill metadata.
 * @param ctx App context
 * @param resolvedCommand Context-aware command text
 * @param metadata All available skills (name, description, sourcePath)
 * @param providerFactory Provider factory for the contextQueryModel
 * @returns Subset of metadata chosen by the model (ordered as returned), or [] on error
 */
export async function selectSkillsWithModel(
  ctx: AppContext,
  resolvedCommand: string,
  metadata: SkillMetadata[],
  providerFactory: ProviderFactory,
): Promise<SkillMetadata[]> {
  if (metadata.length === 0) return [];

  const settings = getSettings(ctx);
  const model = settings.contextQueryModel;
  if (!model || !settings.whitelistedModels.includes(model)) {
    return [];
  }

  const lines: string[] = [];
  lines.push("Resolved command:");
  lines.push(resolvedCommand);
  lines.push("");
  lines.push("Available skills (name and description):");
  for (const skill of metadata) {
    lines.push(`- name: ${skill.name}`);
    lines.push(`  description: ${skill.description}`);
  }

  const userContent = lines.join("\n");

  let raw = "";
  try {
    const provider = providerFactory(model, ctx);
    const result = await provider.complete(
      [
        {
          role: "system",
          content:
            "You are a skill selection assistant. Given a user command and a list of skills (name and description), choose the skills that are most relevant.\n" +
            "Return ONLY a JSON array of skill names to activate, exactly matching the names from the list. Example: [\"commit-changes\", \"deploy-app\"].\n" +
            "Do not include any explanations or extra text.",
        },
        { role: "user", content: userContent },
      ],
      [],
      (token) => {
        raw += token;
      },
    );
    if (result.content) raw = result.content;
  } catch {
    return [];
  }

  const trimmed = raw.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/\[[\s\S]*?\]/);
    if (!match) return [];
    try {
      parsed = JSON.parse(match[0]);
    } catch {
      return [];
    }
  }

  if (!Array.isArray(parsed)) return [];

  const allByName = new Map(metadata.map((m) => [m.name, m]));
  const names = [...new Set(
    (parsed as unknown[])
      .filter((v): v is string => typeof v === "string")
      .map((v) => v.trim())
      .filter((v) => v.length > 0),
  )];

  const out: SkillMetadata[] = [];
  for (const name of names) {
    const meta = allByName.get(name);
    if (meta) out.push(meta);
  }
  return out;
}

/**
 * Result of getMatchedSkillsContent: the markdown block and the list of skill names included.
 */
export interface GetMatchedSkillsResult {
  /** Markdown section "## Active skills" with per-skill subsections, or "" if none matched. */
  content: string;
  /** Skill names that were included (for display in smart context sources/skills list). */
  skillNames: string[];
}

/**
 * Get matched skills content for the system prompt: discover skills, match to user message,
 * load full body for matched only, return content and skill names.
 * @param ctx - App context
 * @param agentId - Agent identifier
 * @param userMessage - Current user message
 * @param options - Optional match options (topK, minScore, embedder for tests)
 * @returns Object with content (markdown block) and skillNames (names of included skills)
 */
export async function getMatchedSkillsContent(
  ctx: AppContext,
  agentId: string,
  userMessage: string,
  options: MatchSkillsOptions = {},
): Promise<GetMatchedSkillsResult> {
  const metadata = getAvailableSkillsMetadata(ctx, agentId);
  let matched: SkillMetadata[] = [];

  if (options.providerFactory) {
    try {
      matched = await selectSkillsWithModel(ctx, userMessage, metadata, options.providerFactory);
    } catch {
      matched = [];
    }
  }

  if (matched.length === 0) {
    matched = await matchSkillsToMessage(ctx, metadata, userMessage, options);
  }

  if (matched.length === 0) return { content: "", skillNames: [] };

  const sections: string[] = [];
  const skillNames: string[] = [];
  for (const meta of matched) {
    const skill = loadSkillContent(ctx.fs, meta.sourcePath);
    if (!skill || !skill.content.trim()) continue;
    skillNames.push(skill.name);
    sections.push(`### ${skill.name}\n\n${skill.content.trim()}`);
  }
  if (sections.length === 0) return { content: "", skillNames: [] };
  return {
    content: `## Active skills\n\n${sections.join("\n\n")}`,
    skillNames,
  };
}
