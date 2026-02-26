/**
 * @fileoverview Smart context pipeline: extract multi-query search arrays from user messages,
 * retrieve and deduplicate history+knowledge results, and summarize with citations.
 * Also provides formatRecentThreadTurns for including verbatim recent thread turns.
 * @module lib/agent/context-query
 *
 * All cheap-model calls are made with tools:[] so they work on models without tool support.
 */

import { getSettings } from "../settings";
import { searchHistory, searchKnowledge } from "../knowledge/search";
import { createEmbeddingAdapter } from "../knowledge/embedding";
import type { AppContext } from "../context";
import type { AIProvider } from "../ai/types";
import type { Message } from "../ai/types";
import type { Session } from "../types";

/** Maximum ms to wait for a cheap-model call before giving up. */
const CHEAP_MODEL_TIMEOUT_MS = 15_000;

/** Per-query result limits used when building raw context. */
const HISTORY_LIMIT_PER_QUERY = 5;
const KNOWLEDGE_LIMIT_PER_QUERY = 5;

/** Factory type matching runner.ts ProviderFactory. */
export type ProviderFactory = (model: string, ctx: AppContext) => AIProvider;

/** A source reference to a history entry or knowledge document included in retrieved context. */
export interface ContextSource {
  type: "history" | "knowledge";
  /** Stable id, e.g. "history:sessionId/entryId" or "knowledge:path" */
  id: string;
}

const QUERY_EXTRACTION_PROMPT = `You are a search query extraction assistant.
Given the user message below, output ONLY a JSON array of short search query strings (no prose, no code fences, no markdown).
Each query should target a different relevant topic so that semantic search over past conversations and a knowledge base returns the most relevant results for the user.
Example output: ["topic one", "topic two"]`;

const SUMMARIZE_PROMPT_PREFIX = `You are a context summarization assistant.
Summarize the retrieved context below into a concise markdown section titled "## Smart context".
For every fact you include, cite the source id in brackets, e.g. [history:sessionId/entryId] or [knowledge:path].
Only cite source ids that are listed in the Sources section.
Output ONLY the markdown section — no preamble, no postamble.

Sources available:`;

/**
 * Calls the given provider with no tools and a timeout, accumulating response content.
 * @param provider - AI provider to call
 * @param messages - Messages to send
 * @returns Response content string, or throws on timeout/error
 */
async function callCheapModel(provider: AIProvider, messages: Message[]): Promise<string> {
  let raw = "";
  const result = await Promise.race([
    provider.complete(messages, [], (token) => { raw += token; }),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Cheap model timeout")), CHEAP_MODEL_TIMEOUT_MS)
    ),
  ]);
  return result.content || raw;
}

/**
 * Sends the user message to the contextQueryModel and returns a deduplicated array of
 * search query strings. Falls back to [userMessage] if the model returns invalid JSON,
 * an empty array, or throws.
 * @param ctx - Application context
 * @param providerFactory - Factory to create an AI provider for a given model
 * @param userMessage - The current user message
 * @returns Non-empty deduplicated array of search query strings
 */
export async function extractSearchQueries(
  ctx: AppContext,
  providerFactory: ProviderFactory,
  userMessage: string,
): Promise<string[]> {
  const settings = getSettings(ctx);
  const model = settings.contextQueryModel;

  const fallback = [userMessage.slice(0, 500)];

  if (!model || !settings.whitelistedModels.includes(model)) {
    console.debug("[Smart context] extractSearchQueries: skipped (no model or not whitelisted), using fallback");
    return fallback;
  }

  try {
    const provider = providerFactory(model, ctx);
    const messages: Message[] = [
      { role: "system", content: QUERY_EXTRACTION_PROMPT },
      { role: "user", content: userMessage },
    ];
    const raw = await callCheapModel(provider, messages);
    console.debug("[Smart context] extractSearchQueries: raw response length", raw.length);

    // Try to parse the whole response first (expected: a top-level JSON array).
    // If that fails, look for the first top-level array in the text (handles code fences etc.).
    let parsed: unknown;
    const trimmed = raw.trim();
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      const jsonMatch = trimmed.match(/\[[\s\S]*?\]/);
      if (!jsonMatch) {
        console.debug("[Smart context] extractSearchQueries: no JSON array in response, using fallback");
        return fallback;
      }
      parsed = JSON.parse(jsonMatch[0]);
    }

    if (!Array.isArray(parsed)) {
      console.debug("[Smart context] extractSearchQueries: response not an array, using fallback");
      return fallback;
    }

    const queries = [...new Set(
      (parsed as unknown[])
        .filter((q): q is string => typeof q === "string")
        .map((q) => q.trim())
        .filter((q) => q.length > 0)
    )];

    if (queries.length === 0) {
      console.debug("[Smart context] extractSearchQueries: empty queries after parse, using fallback");
      return fallback;
    }
    return queries;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.debug("[Smart context] extractSearchQueries: error, using fallback", msg);
    return fallback;
  }
}

/**
 * Runs semantic search over history and the knowledge base for each query, aggregating
 * and deduplicating results across queries.
 * @param ctx - Application context
 * @param queries - Array of search query strings
 * @param options - Optional per-query limits
 * @returns Raw context text block plus a sources array for citation
 */
export async function buildRawRetrievedContext(
  ctx: AppContext,
  queries: string[],
  options?: { historyLimit?: number; knowledgeLimit?: number },
): Promise<{ text: string; sources: ContextSource[] }> {
  const settings = getSettings(ctx);
  const embedder = createEmbeddingAdapter(settings, ctx.http);
  const historyLimit = options?.historyLimit ?? HISTORY_LIMIT_PER_QUERY;
  const knowledgeLimit = options?.knowledgeLimit ?? KNOWLEDGE_LIMIT_PER_QUERY;

  const seenHistoryKeys = new Set<string>();
  const seenKnowledgeKeys = new Set<string>();

  const historyEntries: Array<{ sessionId: string; entryId: string; content: string; isCompressed: boolean; score: number }> = [];
  const knowledgeEntries: Array<{ path: string; content: string; score: number }> = [];
  const sources: ContextSource[] = [];

  const debugPerQuery: Array<{ query: string; historyHits: number; knowledgeHits: number }> = [];

  for (const query of queries) {
    const [histHits, knowledgeHits] = await Promise.all([
      searchHistory(ctx, embedder, query, historyLimit),
      searchKnowledge(ctx, embedder, query, knowledgeLimit),
    ]);
    debugPerQuery.push({ query, historyHits: histHits.length, knowledgeHits: knowledgeHits.length });

    for (const hit of histHits) {
      const key = `${hit.sessionId}/${hit.entryId}`;
      if (!seenHistoryKeys.has(key)) {
        seenHistoryKeys.add(key);
        historyEntries.push(hit);
        sources.push({ type: "history", id: `history:${key}` });
      }
    }

    for (const hit of knowledgeHits) {
      if (!seenKnowledgeKeys.has(hit.path)) {
        seenKnowledgeKeys.add(hit.path);
        knowledgeEntries.push(hit);
        sources.push({ type: "knowledge", id: `knowledge:${hit.path}` });
      }
    }
  }

  console.debug("[Smart context] buildRawRetrievedContext: per-query hits", debugPerQuery, "total history:", historyEntries.length, "total knowledge:", knowledgeEntries.length);

  if (historyEntries.length === 0 && knowledgeEntries.length === 0) {
    return { text: "No relevant prior context found.", sources: [] };
  }

  const lines: string[] = [];

  if (historyEntries.length > 0) {
    lines.push("## History results");
    for (const h of historyEntries) {
      lines.push(`[history:${h.sessionId}/${h.entryId}]\n${h.content}`);
    }
  }

  if (knowledgeEntries.length > 0) {
    lines.push("## Knowledge results");
    for (const k of knowledgeEntries) {
      lines.push(`[knowledge:${k.path}]\n${k.content}`);
    }
  }

  return { text: lines.join("\n\n"), sources };
}

/**
 * Sends raw retrieved context to the contextSummaryModel (or contextQueryModel as fallback)
 * and returns a concise markdown summary with inline citations.
 * Falls back to the raw context text on model failure.
 * @param ctx - Application context
 * @param providerFactory - Factory to create an AI provider for a given model
 * @param rawText - The raw context block returned by buildRawRetrievedContext
 * @param sources - Source list for the summarizer to cite
 * @returns Summarized markdown section with citations
 */
export async function summarizeRetrievedContext(
  ctx: AppContext,
  providerFactory: ProviderFactory,
  rawText: string,
  sources: ContextSource[],
): Promise<string> {
  const settings = getSettings(ctx);
  const model = settings.contextSummaryModel || settings.contextQueryModel;

  if (!model || !settings.whitelistedModels.includes(model)) {
    console.debug("[Smart context] summarizeRetrievedContext: no summary model, returning raw");
    return `## Smart context\n\n${rawText}`;
  }

  console.debug("[Smart context] summarizeRetrievedContext: using model", model, "sources count", sources.length);

  const sourceList = sources.map((s) => `- ${s.id}`).join("\n");
  const systemContent = `${SUMMARIZE_PROMPT_PREFIX}\n${sourceList}`;

  try {
    const provider = providerFactory(model, ctx);
    const messages: Message[] = [
      { role: "system", content: systemContent },
      { role: "user", content: rawText },
    ];
    const result = await callCheapModel(provider, messages);
    const out = result.trim() || `## Smart context\n\n${rawText}`;
    console.debug("[Smart context] summarizeRetrievedContext: result length", out.length);
    return out;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.debug("[Smart context] summarizeRetrievedContext: error, returning raw", msg);
    return `## Smart context\n\n${rawText}`;
  }
}

/**
 * Formats the last `count` entries from session.original as a labeled markdown section.
 * Includes tool arguments and results for tool_call entries.
 * @param session - The current session
 * @param count - How many recent entries to include (clamped to session length)
 * @returns Formatted markdown section string
 */
export function formatRecentThreadTurns(session: Session, count: number): string {
  const entries = session.original;
  const take = entries.slice(-Math.max(1, count));

  const heading = `## Recent thread (last ${count} turns)`;

  if (take.length === 0) {
    return `${heading}\n\nNo recent turns in this session.`;
  }

  const formatted = take.map((entry) => {
    const label =
      entry.role === "user"
        ? "**User:**"
        : entry.role === "agent"
          ? "**Assistant:**"
          : `**Tool (${entry.toolName ?? "unknown"}):**`;

    if (
      entry.role === "tool_call" &&
      entry.toolArgs != null &&
      Object.keys(entry.toolArgs).length > 0
    ) {
      return `${label}\nArguments: ${JSON.stringify(entry.toolArgs)}\nResult: ${entry.content}`;
    }
    return `${label}\n${entry.content}`;
  });

  return `${heading}\n\n${formatted.join("\n\n")}`;
}
