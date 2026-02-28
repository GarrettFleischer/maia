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
import { agentDebug } from "./agent-logger";

/** Per-query result limits used when building raw context. */
const HISTORY_LIMIT_PER_QUERY = 5;
const KNOWLEDGE_LIMIT_PER_QUERY = 5;

/** Max characters of raw response to log when falling back (avoids huge logs). */
const FALLBACK_RAW_LOG_MAX_LEN = 500;

/** Max characters per section when logging SYSTEM/CONTEXT/QUERY (readable, line-wrapped). */
const DEBUG_SECTION_MAX_LEN = 1200;

/**
 * Logs a clearly labeled section with real line breaks (no literal \n). Truncates long body.
 * @param title - Section label (e.g. "SYSTEM", "CONTEXT", "USER / QUERY")
 * @param body - Content to log (newlines render as actual line breaks)
 * @param maxLen - Truncate body to this length (default DEBUG_SECTION_MAX_LEN)
 */
function logDebugSection(title: string, body: string, maxLen = DEBUG_SECTION_MAX_LEN): void {
  const truncated =
    body.length > maxLen
      ? body.slice(0, maxLen) + "\n\n... [truncated, total " + body.length + " chars]"
      : body;
  agentDebug("\n--- " + title + " ---\n" + truncated);
}

/** Default retries on 429 (e.g. 2 = try up to 3 times total). */
const DEFAULT_RATE_LIMIT_RETRIES = 2;

/** Default delay in ms before retrying after 429. */
const DEFAULT_RATE_LIMIT_DELAY_MS = 2000;

/** Max characters from each source to include in relevance-filter previews. */
const FILTER_PREVIEW_MAX_CHARS = 500;

/** Max characters per source before chunking for quote extraction. */
const MAX_SOURCE_CHARS_QUOTE_EXTRACTION = 12000;

/** Chunk size when splitting large sources for quote extraction. */
const QUOTE_CHUNK_SIZE = 8000;

/** Overlap between chunks (chars) so relevant text is not cut at boundary. */
const QUOTE_CHUNK_OVERLAP = 800;

/** True if the error is a 429 / rate-limit from the provider (avoids noisy stack traces in logs). */
function isRateLimitError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /429|rate-limit|rate limit/i.test(msg);
}

/** Options for 429 retry behavior. Used by callCheapModelWithRetry; tests can pass rateLimitDelayMs: 0. */
export interface RateLimitRetryOptions {
  maxRetries?: number;
  delayMs?: number;
}

/** Factory type matching runner.ts ProviderFactory. */
export type ProviderFactory = (model: string, ctx: AppContext) => AIProvider;

/** A source reference to a history entry or knowledge document included in retrieved context. */
export interface ContextSource {
  type: "history" | "knowledge";
  /** Stable id, e.g. "history:sessionId/entryId" or "knowledge:path" */
  id: string;
}

const QUERY_EXTRACTION_PROMPT = `You are a search query extraction assistant.
You may be given recent conversation context and the current user message. Use the conversation ONLY as context to resolve references (e.g. "that", "it", "the bug we discussed")—do NOT base queries on topics from previous messages.
Generate search queries ONLY from the most recent user message: what the user is asking for right now. Output ONLY a JSON array of short search query strings (no prose, no code fences, no markdown).
Each query should target a different relevant topic from the current request so that semantic search over past conversations and a knowledge base returns the most relevant results.
Example output: ["topic one", "topic two"]`;

const CONTEXT_COMMAND_QUERY_PROMPT = `You are a search query extraction assistant.
You will be given:
1. Context: what to base the search queries on (e.g. the user's question, prior discussion topics, relevant background).
2. Command: what the agent is trying to accomplish with this search.

Generate search queries from the context and command. Each query should target a different relevant topic so that semantic search over past session history and the knowledge base returns the most useful results.
Output ONLY a JSON array of short search query strings (no prose, no code fences, no markdown).
Example output: ["topic one", "topic two"]`;

const SUMMARIZE_PROMPT_PREFIX = `You are a context summarization assistant.
Summarize the retrieved context below into a concise markdown section titled "## Smart context".
For every fact you include, cite the source id in brackets, e.g. [history:sessionId/entryId] or [knowledge:path].
Only cite source ids that are listed in the Sources section.
Output ONLY the markdown section — no preamble, no postamble.

Sources available:`;

const QUOTE_EXTRACTION_PROMPT = `You are a quote extraction assistant.
You will be given the user's current query and the full content of ONE source (history or knowledge).
Identify the verbatim spans that are relevant to the query. Include surrounding context (e.g. the relevant sentence plus the sentence or paragraph before/after) so the quote is self-contained.
Output ONLY a JSON array of objects with a "text" field. Each "text" must be a verbatim copy of a span from the source—no paraphrasing.
Example: [{"text": "First sentence. Relevant part here. Next sentence."}]
If nothing is relevant, output [].`;

/**
 * Calls the given provider with no tools, accumulating response content.
 * @param provider - AI provider to call
 * @param messages - Messages to send
 * @returns Response content string, or throws on error
 */
async function callCheapModel(provider: AIProvider, messages: Message[]): Promise<string> {
  let raw = "";
  const result = await provider.complete(messages, [], (token) => { raw += token; });
  return result.content || raw;
}

/**
 * Calls the cheap model with retry on 429: sleeps then retries up to maxRetries times.
 * Non-429 errors are thrown immediately. After all retries exhausted on 429, throws the last error.
 * @param provider - AI provider to call
 * @param messages - Messages to send
 * @param options - maxRetries (default 2), delayMs (default 2000)
 * @returns Response content string
 */
async function callCheapModelWithRetry(
  provider: AIProvider,
  messages: Message[],
  options?: RateLimitRetryOptions,
): Promise<string> {
  const maxRetries = options?.maxRetries ?? DEFAULT_RATE_LIMIT_RETRIES;
  const delayMs = options?.delayMs ?? DEFAULT_RATE_LIMIT_DELAY_MS;
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await callCheapModel(provider, messages);
    } catch (e) {
      lastError = e;
      if (!isRateLimitError(e) || attempt === maxRetries) {
        throw e;
      }
      agentDebug(`[Smart context] rate limit (429), sleeping ${delayMs}ms then retry (attempt ${attempt + 1}/${maxRetries + 1})`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastError;
}

/**
 * Sends the user message (and optional recent conversation) to the contextQueryModel and returns
 * a deduplicated array of search query strings. Queries are derived only from the current user
 * message; recent conversation is used as context for disambiguation (e.g. resolving "that",
 * "it") but queries are not based on previous messages. Falls back to [userMessage] if the
 * model returns invalid JSON, an empty array, or throws.
 * @param ctx - Application context
 * @param providerFactory - Factory to create an AI provider for a given model
 * @param userMessage - The current user message (queries are based on this only)
 * @param recentConversation - Optional formatted recent thread turns for context only (disambiguation)
 * @param retryOptions - Optional 429 retry config (tests can pass rateLimitDelayMs: 0)
 * @returns Non-empty deduplicated array of search query strings
 */
export async function extractSearchQueries(
  ctx: AppContext,
  providerFactory: ProviderFactory,
  userMessage: string,
  recentConversation?: string,
  retryOptions?: RateLimitRetryOptions,
): Promise<string[]> {
  const settings = getSettings(ctx);
  const model = settings.contextQueryModel;

  const fallback = [userMessage.slice(0, 500)];

  if (!model || !settings.whitelistedModels.includes(model)) {
    agentDebug("[Smart context] extractSearchQueries: skipped (no model or not whitelisted), using fallback");
    return fallback;
  }

  const userContent =
    recentConversation && recentConversation.trim().length > 0
      ? `Recent conversation:\n\n${recentConversation.trim()}\n\nCurrent user message:\n${userMessage}`
      : userMessage;

  try {
    const provider = providerFactory(model, ctx);
    agentDebug("[Smart context] extractSearchQueries: sending to model");
    logDebugSection("SYSTEM PROMPT", QUERY_EXTRACTION_PROMPT);
    logDebugSection("USER / QUERY (context + current message)", userContent);
    const messages: Message[] = [
      { role: "system", content: QUERY_EXTRACTION_PROMPT },
      { role: "user", content: userContent },
    ];
    const raw = await callCheapModelWithRetry(provider, messages, retryOptions);
    agentDebug("[Smart context] extractSearchQueries: raw response length", raw.length);

    // Try to parse the whole response first (expected: a top-level JSON array).
    // If that fails, look for the first top-level array in the text (handles code fences etc.).
    let parsed: unknown;
    const trimmed = raw.trim();
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      const jsonMatch = trimmed.match(/\[[\s\S]*?\]/);
      if (!jsonMatch) {
        const rawSnippet = raw.length > FALLBACK_RAW_LOG_MAX_LEN ? raw.slice(0, FALLBACK_RAW_LOG_MAX_LEN) + " [truncated]" : raw;
        agentDebug("[Smart context] extractSearchQueries: no JSON array in response, using fallback. raw length:", raw.length, "snippet:", rawSnippet);
        return fallback;
      }
      parsed = JSON.parse(jsonMatch[0]);
    }

    if (!Array.isArray(parsed)) {
      const rawSnippet = raw.length > FALLBACK_RAW_LOG_MAX_LEN ? raw.slice(0, FALLBACK_RAW_LOG_MAX_LEN) + " [truncated]" : raw;
      agentDebug("[Smart context] extractSearchQueries: response not an array, using fallback. raw length:", raw.length, "snippet:", rawSnippet);
      return fallback;
    }

    const queries = [...new Set(
      (parsed as unknown[])
        .filter((q): q is string => typeof q === "string")
        .map((q) => q.trim())
        .filter((q) => q.length > 0)
    )];

    if (queries.length === 0) {
      const rawSnippet = raw.length > FALLBACK_RAW_LOG_MAX_LEN ? raw.slice(0, FALLBACK_RAW_LOG_MAX_LEN) + " [truncated]" : raw;
      agentDebug("[Smart context] extractSearchQueries: empty queries after parse, using fallback. raw length:", raw.length, "snippet:", rawSnippet);
      return fallback;
    }
    return queries;
  } catch (e) {
    if (isRateLimitError(e)) {
      agentDebug("[Smart context] extractSearchQueries: rate limit (429) after retries, using fallback");
    } else {
      const msg = e instanceof Error ? e.message : String(e);
      agentDebug("[Smart context] extractSearchQueries: error, using fallback", msg);
    }
    return fallback;
  }
}

/**
 * Extracts search queries from context and command for the smart_context tool.
 * Uses the contextQueryModel when available; otherwise falls back to [command, context].
 * @param ctx - Application context
 * @param providerFactory - Factory to create an AI provider (optional; when absent, uses fallback queries)
 * @param context - What to base the queries on (e.g. user's question, prior discussion)
 * @param command - What the agent is trying to accomplish
 * @param retryOptions - Optional 429 retry configuration
 * @returns Non-empty deduplicated array of search query strings
 */
export async function extractSearchQueriesFromContextAndCommand(
  ctx: AppContext,
  providerFactory: ProviderFactory | undefined,
  context: string,
  command: string,
  retryOptions?: RateLimitRetryOptions,
): Promise<string[]> {
  const fallback = [
    command.slice(0, 500).trim() || "search",
    context.slice(0, 500).trim(),
  ].filter(Boolean);

  if (!providerFactory) {
    agentDebug("[Smart context] extractSearchQueriesFromContextAndCommand: no providerFactory, using fallback");
    return fallback.length > 0 ? fallback : ["search"];
  }

  const settings = getSettings(ctx);
  const model = settings.contextQueryModel;

  if (!model || !settings.whitelistedModels.includes(model)) {
    agentDebug("[Smart context] extractSearchQueriesFromContextAndCommand: skipped (no model or not whitelisted), using fallback");
    return fallback;
  }

  const userContent = `Context (what to base queries on):\n${context}\n\nCommand (what the agent is trying to accomplish):\n${command}`;

  try {
    const provider = providerFactory(model, ctx);
    agentDebug("[Smart context] extractSearchQueriesFromContextAndCommand: sending to model");
    logDebugSection("SYSTEM PROMPT", CONTEXT_COMMAND_QUERY_PROMPT);
    logDebugSection("USER / QUERY (context + command)", userContent);
    const messages: Message[] = [
      { role: "system", content: CONTEXT_COMMAND_QUERY_PROMPT },
      { role: "user", content: userContent },
    ];
    const raw = await callCheapModelWithRetry(provider, messages, retryOptions);
    agentDebug("[Smart context] extractSearchQueriesFromContextAndCommand: raw response length", raw.length);

    const trimmed = raw.trim();
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      const jsonMatch = trimmed.match(/\[[\s\S]*?\]/);
      if (!jsonMatch) {
        agentDebug("[Smart context] extractSearchQueriesFromContextAndCommand: no JSON array, using fallback");
        return fallback;
      }
      parsed = JSON.parse(jsonMatch[0]);
    }

    if (!Array.isArray(parsed)) {
      agentDebug("[Smart context] extractSearchQueriesFromContextAndCommand: response not array, using fallback");
      return fallback;
    }

    const queries = [
      ...new Set(
        (parsed as unknown[])
          .filter((q): q is string => typeof q === "string")
          .map((q) => q.trim())
          .filter((q) => q.length > 0),
      ),
    ];

    if (queries.length === 0) {
      agentDebug("[Smart context] extractSearchQueriesFromContextAndCommand: empty queries, using fallback");
      return fallback;
    }
    return queries;
  } catch (e) {
    if (isRateLimitError(e)) {
      agentDebug("[Smart context] extractSearchQueriesFromContextAndCommand: rate limit after retries, using fallback");
    } else {
      const msg = e instanceof Error ? e.message : String(e);
      agentDebug("[Smart context] extractSearchQueriesFromContextAndCommand: error, using fallback", msg);
    }
    return fallback;
  }
}

/**
 * Runs semantic search over history and the knowledge base for each query, aggregating
 * and deduplicating results across queries.
 * @param ctx - Application context
 * @param queries - Array of search query strings
 * @param options - Optional per-query limits
 * @returns Raw context text block, a sources array for citation, and full per-source contents in the same order
 */
export async function buildRawRetrievedContext(
  ctx: AppContext,
  queries: string[],
  options?: { historyLimit?: number; knowledgeLimit?: number },
): Promise<{ text: string; sources: ContextSource[]; contents: string[] }> {
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

  for (let i = 0; i < queries.length; i++) {
    const query = queries[i];
    agentDebug("[Smart context] buildRawRetrievedContext: searching query", i + 1, "of", queries.length, query);
    try {
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
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      agentDebug(
        "[Smart context] buildRawRetrievedContext: query failed, skipping",
        { query, error: msg },
      );
    }
  }

  agentDebug(
    "[Smart context] buildRawRetrievedContext: per-query hits",
    debugPerQuery,
    "total history:",
    historyEntries.length,
    "total knowledge:",
    knowledgeEntries.length,
  );

  if (historyEntries.length === 0 && knowledgeEntries.length === 0) {
    return { text: "No relevant prior context found.", sources: [], contents: [] };
  }

  const idToContent = new Map<string, string>();
  for (const h of historyEntries) {
    const id = `history:${h.sessionId}/${h.entryId}`;
    idToContent.set(id, h.content);
  }
  for (const k of knowledgeEntries) {
    const id = `knowledge:${k.path}`;
    idToContent.set(id, k.content);
  }

  const contents = sources.map((s) => idToContent.get(s.id) ?? "");
  const text = buildRawTextFromChunks(sources, contents);

  return { text, sources, contents };
}

/**
 * @brief Builds the raw retrieved-context text block from per-source contents.
 * @param sources Source descriptors included in the block.
 * @param contents Full text content for each source, in the same order as `sources`.
 * @returns Raw context text suitable for passing to the summarizer.
 * @note This helper is used both for the initial retrieval output and after relevance filtering.
 * @example
 * const text = buildRawTextFromChunks(sources, contents);
 */
export function buildRawTextFromChunks(sources: ContextSource[], contents: string[]): string {
  if (sources.length === 0 || contents.length === 0) {
    return "No relevant prior context found.";
  }

  const lines: string[] = [];
  const historyIndices: number[] = [];
  const knowledgeIndices: number[] = [];

  for (let i = 0; i < sources.length; i++) {
    const source = sources[i];
    if (source.type === "history") {
      historyIndices.push(i);
    } else if (source.type === "knowledge") {
      knowledgeIndices.push(i);
    }
  }

  if (historyIndices.length > 0) {
    lines.push("## History results");
    for (const idx of historyIndices) {
      const source = sources[idx];
      const content = contents[idx] ?? "";
      lines.push(`[${source.id}]\n${content}`);
    }
  }

  if (knowledgeIndices.length > 0) {
    lines.push("## Knowledge results");
    for (const idx of knowledgeIndices) {
      const source = sources[idx];
      const content = contents[idx] ?? "";
      lines.push(`[${source.id}]\n${content}`);
    }
  }

  return lines.join("\n\n");
}

/**
 * @brief Filters retrieved context sources using a cheap model and short previews.
 * @param ctx Application context.
 * @param providerFactory Factory to create an AI provider for a given model.
 * @param userMessage The current user message / query driving retrieval.
 * @param sources Full list of candidate sources to filter.
 * @param contents Full content for each source, in the same order as `sources`.
 * @param retryOptions Optional 429 retry configuration.
 * @returns Filtered sources and contents, preserving order among kept items.
 * @note When the model is not configured, not whitelisted, or its output cannot be parsed as a string array,
 *       the original sources and contents are returned unchanged.
 * @example
 * const filtered = await filterRelevantSources(ctx, providerFactory, userMessage, sources, contents);
 */
export async function filterRelevantSources(
  ctx: AppContext,
  providerFactory: ProviderFactory,
  userMessage: string,
  sources: ContextSource[],
  contents: string[],
  retryOptions?: RateLimitRetryOptions,
): Promise<{ sources: ContextSource[]; contents: string[] }> {
  if (sources.length === 0 || contents.length === 0) {
    return { sources: [], contents: [] };
  }

  const settings = getSettings(ctx);
  const model = settings.contextQueryModel;

  if (!model || !settings.whitelistedModels.includes(model)) {
    agentDebug("[Smart context] filterRelevantSources: skipped (no query model or not whitelisted)");
    return { sources, contents };
  }

  const previewLines: string[] = [];
  previewLines.push("User query:");
  previewLines.push(userMessage);
  previewLines.push("");
  previewLines.push("Candidate sources (id and first 500 characters):");
  previewLines.push("");

  for (let i = 0; i < sources.length; i++) {
    const source = sources[i];
    const content = contents[i] ?? "";
    const preview = content.slice(0, FILTER_PREVIEW_MAX_CHARS);
    previewLines.push(`Source ${i + 1}: ${source.id}`);
    previewLines.push("Preview:");
    previewLines.push(preview);
    previewLines.push("");
  }

  const userContent = previewLines.join("\n");

  const FILTER_PROMPT = `You are a source relevance filtering assistant.
You will be given the user's current query and a list of candidate sources.
Each source has an id and the first part of its content.

Decide which sources are relevant for answering the user's question.
Output ONLY a JSON array of source ids to KEEP, using exactly the ids shown in the list.

Examples:
- ["history:session-1/entry-3", "knowledge:docs/guide.md"]
- []`;

  try {
    const provider = providerFactory(model, ctx);
    agentDebug(
      "[Smart context] filterRelevantSources: sending",
      sources.length,
      "sources to model for relevance filtering",
    );
    logDebugSection("SYSTEM (relevance filter instructions)", FILTER_PROMPT);
    logDebugSection("USER / QUERY (sources with previews)", userContent);

    const messages: Message[] = [
      { role: "system", content: FILTER_PROMPT },
      { role: "user", content: userContent },
    ];

    const raw = await callCheapModelWithRetry(provider, messages, retryOptions);
    agentDebug("[Smart context] filterRelevantSources: raw response length", raw.length);

    const trimmed = raw.trim();
    let parsed: unknown;

    try {
      parsed = JSON.parse(trimmed);
    } catch {
      const jsonMatch = trimmed.match(/\[[\s\S]*?\]/);
      if (!jsonMatch) {
        const rawSnippet =
          raw.length > FALLBACK_RAW_LOG_MAX_LEN
            ? raw.slice(0, FALLBACK_RAW_LOG_MAX_LEN) + " [truncated]"
            : raw;
        agentDebug(
          "[Smart context] filterRelevantSources: no JSON array in response, returning all sources. raw length:",
          raw.length,
          "snippet:",
          rawSnippet,
        );
        return { sources, contents };
      }
      parsed = JSON.parse(jsonMatch[0]);
    }

    if (!Array.isArray(parsed)) {
      const rawSnippet =
        raw.length > FALLBACK_RAW_LOG_MAX_LEN
          ? raw.slice(0, FALLBACK_RAW_LOG_MAX_LEN) + " [truncated]"
          : raw;
      agentDebug(
        "[Smart context] filterRelevantSources: response not an array, returning all sources. raw length:",
        raw.length,
        "snippet:",
        rawSnippet,
      );
      return { sources, contents };
    }

    const ids = [...new Set(
      (parsed as unknown[])
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter((value) => value.length > 0),
    )];

    if (ids.length === 0) {
      agentDebug("[Smart context] filterRelevantSources: model returned an empty id list; treating as no relevant sources");
      return { sources: [], contents: [] };
    }

    const keep = new Set(ids);
    const filteredSources: ContextSource[] = [];
    const filteredContents: string[] = [];

    for (let i = 0; i < sources.length; i++) {
      const source = sources[i];
      if (keep.has(source.id)) {
        filteredSources.push(source);
        filteredContents.push(contents[i] ?? "");
      }
    }

    agentDebug(
      "[Smart context] filterRelevantSources: kept",
      filteredSources.length,
      "of",
      sources.length,
      "sources",
    );

    return { sources: filteredSources, contents: filteredContents };
  } catch (e) {
    if (isRateLimitError(e)) {
      agentDebug("[Smart context] filterRelevantSources: rate limit (429) after retries, returning all sources");
    } else {
      const msg = e instanceof Error ? e.message : String(e);
      agentDebug("[Smart context] filterRelevantSources: error, returning all sources", msg);
    }
    return { sources, contents };
  }
}

/** Normalize whitespace for snippet comparison (collapse runs to single space). */
function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Scan backward from index to find the start of the current sentence (after . ! ? or start of string). */
function findSentenceStart(content: string, index: number): number {
  if (index <= 0) return 0;
  const before = content.slice(0, index);
  const match = before.match(/[.!?]\s+[^.!?]*$/);
  if (match) return index - match[0].length;
  return 0;
}

/** Scan forward from index to find the end of the current sentence (at . ! ? or end of string). */
function findSentenceEnd(content: string, index: number): number {
  if (index >= content.length) return content.length;
  const after = content.slice(index);
  const match = after.match(/^[^.!?]*[.!?]\s*/);
  if (match) return index + match[0].length;
  return content.length;
}

/**
 * Deduplicates and extends quote snippets to sentence boundaries using the original source content.
 * Pure JS—no LLM. Used after extractRelevantQuotes to merge overlapping chunks and fix cut-offs.
 * @param quotes Raw quotes from extraction (may contain duplicates or mid-sentence cuts).
 * @param sourceContentById Map of sourceId to full content.
 * @returns Cleaned quotes: no duplicates, extended to sentence boundaries where found in source.
 */
export function cleanupQuotes(
  quotes: Array<{ sourceId: string; text: string }>,
  sourceContentById: Map<string, string>,
): Array<{ sourceId: string; text: string }> {
  const out: Array<{ sourceId: string; text: string }> = [];
  const sourceIds = [...new Set(quotes.map((q) => q.sourceId))];
  for (const sourceId of sourceIds) {
    const content = sourceContentById.get(sourceId) ?? "";
    const snippets = quotes
      .filter((q) => q.sourceId === sourceId)
      .map((q) => normalizeWhitespace(q.text))
      .filter((s) => s.length > 0);

    let deduped: string[] = [];
    for (const s of snippets) {
      const isSubstring = deduped.some((d) => d.includes(s) && d !== s);
      const isSuperset = deduped.some((d) => s.includes(d) && s !== d);
      if (isSubstring) continue;
      if (isSuperset) deduped = deduped.filter((d) => !s.includes(d) || s === d);
      deduped.push(s);
    }

    for (const s of deduped) {
      const normContent = normalizeWhitespace(content);
      const start = normContent.indexOf(s);
      if (start === -1) {
        out.push({ sourceId, text: s });
        continue;
      }
      const end = start + s.length;
      const startBoundary = findSentenceStart(normContent, start);
      const endBoundary = findSentenceEnd(normContent, end);
      const extended = normContent.slice(startBoundary, endBoundary).trim();
      out.push({ sourceId, text: extended });
    }
  }
  return out;
}

/**
 * Splits content into overlapping chunks for quote extraction.
 * @param content Full source content.
 * @param chunkSize Max chars per chunk.
 * @param overlap Chars to overlap between consecutive chunks.
 * @returns Array of chunk strings.
 */
function chunkContent(content: string, chunkSize: number, overlap: number): string[] {
  if (content.length <= chunkSize) return [content];
  const chunks: string[] = [];
  let start = 0;
  while (start < content.length) {
    const end = Math.min(start + chunkSize, content.length);
    chunks.push(content.slice(start, end));
    if (end >= content.length) break;
    start = end - overlap;
  }
  return chunks;
}

/**
 * Extracts verbatim relevant quotes per source (and per chunk when source is large).
 * Uses contextSummaryModel or contextQueryModel. Returns empty array when no model or on parse failure.
 * @param ctx Application context.
 * @param providerFactory Factory to create AI provider.
 * @param userMessage Current user query.
 * @param sources Filtered sources.
 * @param contents Full content per source (same order as sources).
 * @param retryOptions Optional 429 retry config.
 * @returns Array of { sourceId, text } (verbatim snippets); may be empty.
 */
export async function extractRelevantQuotes(
  ctx: AppContext,
  providerFactory: ProviderFactory,
  userMessage: string,
  sources: ContextSource[],
  contents: string[],
  retryOptions?: RateLimitRetryOptions,
): Promise<Array<{ sourceId: string; text: string }>> {
  const settings = getSettings(ctx);
  const model = settings.contextSummaryModel || settings.contextQueryModel;
  if (!model || !settings.whitelistedModels.includes(model)) {
    agentDebug("[Smart context] extractRelevantQuotes: no model or not whitelisted");
    return [];
  }

  const allQuotes: Array<{ sourceId: string; text: string }> = [];

  for (let i = 0; i < sources.length; i++) {
    const source = sources[i];
    const content = contents[i] ?? "";
    const chunks =
      content.length <= MAX_SOURCE_CHARS_QUOTE_EXTRACTION
        ? [content]
        : chunkContent(content, QUOTE_CHUNK_SIZE, QUOTE_CHUNK_OVERLAP);

    for (const chunk of chunks) {
      const userContent = `User query: ${userMessage}\n\nSource id: ${source.id}\n\nContent:\n${chunk}`;
      try {
        const provider = providerFactory(model, ctx);
        const messages: Message[] = [
          { role: "system", content: QUOTE_EXTRACTION_PROMPT },
          { role: "user", content: userContent },
        ];
        const raw = await callCheapModelWithRetry(provider, messages, retryOptions);
        const trimmed = raw.trim();
        let parsed: unknown;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          const jsonMatch = trimmed.match(/\[[\s\S]*?\]/);
          if (!jsonMatch) continue;
          parsed = JSON.parse(jsonMatch[0]);
        }
        const arr = Array.isArray(parsed) ? parsed : [parsed];
        for (const item of arr) {
          if (item && typeof item === "object" && typeof (item as { text?: unknown }).text === "string") {
            const text = ((item as { text: string }).text as string).trim();
            if (text.length > 0) allQuotes.push({ sourceId: source.id, text });
          }
        }
      } catch {
        // Skip this chunk on error
      }
    }
  }

  return allQuotes;
}

/**
 * Builds the smart context block from focused quotes and source lists.
 * @param quotes Cleaned quotes (sourceId + text).
 * @param quotedSourceIds Source ids that were quoted (derived from quotes).
 * @param additionalSourceIds Retrieved but not quoted (e.g. filtered out or unused).
 * @returns Markdown block for the system prompt.
 */
export function buildFocusedContextBlock(
  quotes: Array<{ sourceId: string; text: string }>,
  quotedSourceIds: string[],
  additionalSourceIds: string[],
): string {
  const lines: string[] = ["## Smart context (focused quotes)", ""];
  const bySource = new Map<string, string[]>();
  for (const q of quotes) {
    const arr = bySource.get(q.sourceId) ?? [];
    arr.push(q.text);
    bySource.set(q.sourceId, arr);
  }
  for (const id of quotedSourceIds) {
    const snippets = bySource.get(id) ?? [];
    if (snippets.length === 0) continue;
    lines.push(`[${id}]`);
    lines.push(snippets.join("\n\n"));
    lines.push("");
  }
  lines.push("### Quoted sources");
  lines.push(quotedSourceIds.length > 0 ? quotedSourceIds.map((id) => `- ${id}`).join("\n") : "(none)");
  lines.push("");
  lines.push("### Additional sources (retrieved but not quoted)");
  lines.push(additionalSourceIds.length > 0 ? additionalSourceIds.map((id) => `- ${id}`).join("\n") : "(none)");
  return lines.join("\n").trim();
}

/**
 * Sends raw retrieved context to the contextSummaryModel (or contextQueryModel as fallback)
 * and returns a concise markdown section with inline citations.
 * When optional contents is provided, uses focused quote extraction + cleanup instead of prose summary.
 * Falls back to the raw context text on model failure.
 * @param ctx - Application context
 * @param providerFactory - Factory to create an AI provider for a given model
 * @param rawText - The raw context block returned by buildRawRetrievedContext
 * @param sources - Source list for the summarizer to cite
 * @param options - Optional contents (per-source) and retryOptions; when contents provided, returns focused quotes block and quotes array
 * @returns Markdown section string, or object { block, quotes } when contents was provided
 */
export type SummarizeResult =
  | string
  | { block: string; quotes: Array<{ sourceId: string; text: string }> };

export async function summarizeRetrievedContext(
  ctx: AppContext,
  providerFactory: ProviderFactory,
  rawText: string,
  sources: ContextSource[],
  options?: {
    contents?: string[];
    userMessage?: string;
    allRetrievedSourceIds?: string[];
    retryOptions?: RateLimitRetryOptions;
  },
): Promise<SummarizeResult> {
  const contents = options?.contents;
  const userMessage = options?.userMessage ?? "";
  const retryOptions = options?.retryOptions;
  const allRetrievedSourceIds = options?.allRetrievedSourceIds ?? [];

  if (contents != null && contents.length === sources.length) {
    agentDebug("[Smart context] summarizeRetrievedContext: using quote extraction (focused quotes)");
    const rawQuotes = await extractRelevantQuotes(ctx, providerFactory, userMessage, sources, contents, retryOptions);
    agentDebug("[Smart context] quote extraction: raw quotes count", rawQuotes.length);
    const contentMap = new Map<string, string>();
    for (let i = 0; i < sources.length; i++) contentMap.set(sources[i].id, contents[i] ?? "");
    const quotes = cleanupQuotes(rawQuotes, contentMap);
    const quotedSourceIds = [...new Set(quotes.map((q) => q.sourceId))];
    const additionalSourceIds = allRetrievedSourceIds.filter((id) => !quotedSourceIds.includes(id));
    if (quotes.length === 0) {
      const fallbackBlock = `## Smart context\n\nNo relevant quotes extracted. Raw context:\n\n${rawText}`;
      agentDebug("[Smart context] quote extraction: no quotes after cleanup, using raw context fallback");
      logDebugSection("RESULT (quote extraction)", fallbackBlock);
      return {
        block: fallbackBlock,
        quotes: [],
      };
    }
    const block = buildFocusedContextBlock(quotes, quotedSourceIds, additionalSourceIds);
    agentDebug("[Smart context] quote extraction: result length", block.length, "quotes count", quotes.length);
    logDebugSection("RESULT (quote extraction)", block);
    return { block, quotes };
  }

  const settings = getSettings(ctx);
  const model = settings.contextSummaryModel || settings.contextQueryModel;

  if (!model || !settings.whitelistedModels.includes(model)) {
    agentDebug("[Smart context] summarizeRetrievedContext: no summary model, returning raw");
    return `## Smart context\n\n${rawText}`;
  }

  agentDebug("[Smart context] summarizeRetrievedContext: using model", model, "sources count", sources.length);
  const sourceList = sources.map((s) => `- ${s.id}`).join("\n");
  const systemContent = `${SUMMARIZE_PROMPT_PREFIX}\n${sourceList}`;
  agentDebug("[Smart context] Summarizer: sending", rawText.length, "chars of retrieved content in user message");
  logDebugSection("SYSTEM (instructions + source IDs for citations)", systemContent);
  logDebugSection("USER MESSAGE (retrieved content to summarize)", rawText);

  try {
    const provider = providerFactory(model, ctx);
    const messages: Message[] = [
      { role: "system", content: systemContent },
      { role: "user", content: rawText },
    ];
    const result = await callCheapModelWithRetry(provider, messages, retryOptions);
    const out = result.trim() || `## Smart context\n\n${rawText}`;
    agentDebug("[Smart context] summarizeRetrievedContext: result length", out.length);
    logDebugSection("RESULT (summary)", out);
    return out;
  } catch (e) {
    if (isRateLimitError(e)) {
      agentDebug("[Smart context] summarizeRetrievedContext: rate limit (429) after retries, returning raw context");
    } else {
      const msg = e instanceof Error ? e.message : String(e);
      agentDebug("[Smart context] summarizeRetrievedContext: error, returning raw", msg);
    }
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
  const turns = Math.max(1, count);

  if (entries.length === 0) {
    const heading = `## Recent thread (last ${turns} turns)`;
    return `${heading}\n\nNo recent turns in this session.`;
  }

  const userIndices: number[] = [];
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].role === "user") {
      userIndices.push(i);
      if (userIndices.length === turns) break;
    }
  }

  let take: typeof entries;
  if (userIndices.length > 0) {
    const earliestUserIndex = userIndices[userIndices.length - 1] ?? 0;
    take = entries.slice(earliestUserIndex);
  } else {
    take = entries.slice(-turns);
  }

  const heading = `## Recent thread (last ${turns} turns)`;

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
