/**
 * @fileoverview Smart context pipeline: extract multi-query search arrays from user messages,
 * retrieve and deduplicate history+knowledge results, and summarize with citations.
 * Also provides formatRecentThreadTurns for including verbatim recent thread turns.
 * @module lib/agent/context-query
 *
 * All cheap-model calls are made with tools:[] so they work on models without tool support.
 */

import { getSettings } from "../settings";
import {
  searchHistory,
  searchKnowledge,
  type HistorySearchResult,
  type KnowledgeSearchResult,
} from "../knowledge/search";
import { createEmbeddingAdapter } from "../knowledge/embedding";
import type { AppContext } from "../context";
import type { AIProvider } from "../ai/types";
import type { Message } from "../ai/types";
import type { Session } from "../types";
import { agentDebug } from "./agent-logger";

/** Per-query result limits used when building raw context. */
const HISTORY_LIMIT_PER_QUERY = 5;
const KNOWLEDGE_LIMIT_PER_QUERY = 5;

/** Skip relevance filter when source count is at or below this. */
const SKIP_FILTER_SOURCE_COUNT_THRESHOLD = 3;

/** Skip relevance filter when max retrieval score is above this and source count is at or below HIGH_SCORE_SOURCE_CAP. */
const SKIP_FILTER_MAX_SCORE_THRESHOLD = 0.85;

/** Max source count for skipping filter when max score is high. */
const HIGH_SCORE_SOURCE_CAP = 5;

/** Maximum number of search queries to use for retrieval (keeps cost bounded). */
const MAX_QUERIES_CAP = 3;

/** Multiplier added to score when content contains query terms (hybrid keyword boost). E.g. 0.15 => score * 1.15. */
const KEYWORD_BOOST_FACTOR = 0.15;

/** Recency boost for history: score is multiplied by (1 + this * normalizedRecency) where newest entry = 1, oldest = 0. */
const RECENCY_BOOST_FACTOR = 0.15;

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
Generate 1–3 short search queries ONLY from the most recent user message: what the user is asking for right now. Avoid generic phrases; use specific terms that will match relevant history and knowledge. Output ONLY a JSON array of short search query strings (no prose, no code fences, no markdown).
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
Include only content directly relevant to the user's question; omit tangents. Keep the section under 20 lines.
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

export interface PriorResolvedCommand {
  roundIndex: number;
  resolvedCommand: string;
}

export interface RewriteCommandResult {
  roundIndex: number;
  resolvedCommand: string;
}

export interface RewriteCommandOptions extends RateLimitRetryOptions {
  /** When true, logs SYSTEM/USER/RESULT sections for debugging. */
  debug?: boolean;
}

const REWRITE_COMMAND_PROMPT = `You are a context-aware command rewriting assistant.
You will be given:
- A list of prior context-aware user commands with their round indices.
- The current raw user message for a new round.

Your job is to:
1. Decide which prior round (if any) the user is referring to.
2. Rewrite the current user message into a single, explicit, self-contained command that does not rely on pronouns like "that", "it", or vague references.

Output STRICTLY a JSON object with the following shape and NOTHING else:
{"roundIndex": <number>, "resolvedCommand": "<rewritten command>"}

Rules:
- roundIndex must be a positive integer corresponding to one of the prior rounds, or the current round index provided in the prompt when the user is not clearly referring to an earlier round.
- resolvedCommand must be a non-empty string.
- Do not include explanations, comments, or markdown. Only output the JSON object.`;

/**
 * @brief Rewrite the current user message into a context-aware command using prior resolved commands.
 * @param ctx Application context (settings, http).
 * @param providerFactory Factory to create AI provider for the contextQueryModel.
 * @param priorCommands List of prior resolved commands with round indices (ordered oldest→newest).
 * @param currentRoundIndex 1-based index for the current round.
 * @param rawMessage Raw user message for the current round.
 * @param options Optional retry/debug options.
 * @returns Parsed RewriteCommandResult; on failure falls back to { roundIndex: currentRoundIndex, resolvedCommand: rawMessage }.
 */
export async function rewriteCommandWithContext(
  ctx: AppContext,
  providerFactory: ProviderFactory,
  priorCommands: PriorResolvedCommand[],
  currentRoundIndex: number,
  rawMessage: string,
  options?: RewriteCommandOptions,
): Promise<RewriteCommandResult> {
  const settings = getSettings(ctx);
  const model = settings.contextQueryModel;

  const fallback: RewriteCommandResult = {
    roundIndex: currentRoundIndex,
    resolvedCommand: rawMessage,
  };

  if (!model || !settings.whitelistedModels.includes(model)) {
    agentDebug("[Smart context] rewriteCommandWithContext: skipped (no model or not whitelisted), using fallback");
    return fallback;
  }

  const lines: string[] = [];
  lines.push("Prior context-aware commands:");
  if (priorCommands.length === 0) {
    lines.push("(none)");
  } else {
    for (const cmd of priorCommands) {
      lines.push(`Round ${cmd.roundIndex}: ${cmd.resolvedCommand}`);
    }
  }
  lines.push("");
  lines.push(`Current round index: ${currentRoundIndex}`);
  lines.push("Current raw user message:");
  lines.push(rawMessage);

  const userContent = lines.join("\n");

  try {
    const provider = providerFactory(model, ctx);
    if (options?.debug) {
      logDebugSection("SYSTEM PROMPT (rewrite command)", REWRITE_COMMAND_PROMPT);
      logDebugSection("USER / QUERY (prior commands + current message)", userContent);
    }
    const messages: Message[] = [
      { role: "system", content: REWRITE_COMMAND_PROMPT },
      { role: "user", content: userContent },
    ];
    const raw = await callCheapModelWithRetry(provider, messages, options);
    const trimmed = raw.trim();
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        agentDebug("[Smart context] rewriteCommandWithContext: no JSON object in response, using fallback");
        return fallback;
      }
      parsed = JSON.parse(jsonMatch[0]);
    }

    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof (parsed as { resolvedCommand?: unknown }).resolvedCommand !== "string" ||
      typeof (parsed as { roundIndex?: unknown }).roundIndex !== "number"
    ) {
      agentDebug("[Smart context] rewriteCommandWithContext: parsed object missing fields, using fallback");
      return fallback;
    }

    const resolvedCommand = ((parsed as { resolvedCommand: string }).resolvedCommand || rawMessage).trim();
    const roundIndex = (parsed as { roundIndex: number }).roundIndex || currentRoundIndex;

    if (!resolvedCommand) {
      agentDebug("[Smart context] rewriteCommandWithContext: empty resolvedCommand, using fallback");
      return fallback;
    }

    const safeRoundIndex = Number.isInteger(roundIndex) && roundIndex > 0 ? roundIndex : currentRoundIndex;
    const result: RewriteCommandResult = {
      roundIndex: safeRoundIndex,
      resolvedCommand,
    };

    if (options?.debug) {
      logDebugSection("RESULT (rewrite command)", JSON.stringify(result));
    }

    return result;
  } catch (e) {
    if (isRateLimitError(e)) {
      agentDebug("[Smart context] rewriteCommandWithContext: rate limit after retries, using fallback");
    } else {
      const msg = e instanceof Error ? e.message : String(e);
      agentDebug("[Smart context] rewriteCommandWithContext: error, using fallback", msg);
    }
    return fallback;
  }
}

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
 * @returns Raw context text block, sources, contents, and maxScore (max similarity score across hits; for skip-filter heuristic).
 */
export async function buildRawRetrievedContext(
  ctx: AppContext,
  queries: string[],
  options?: { historyLimit?: number; knowledgeLimit?: number },
): Promise<{ text: string; sources: ContextSource[]; contents: string[]; maxScore: number }> {
  const settings = getSettings(ctx);
  const embedder = createEmbeddingAdapter(settings, ctx.http);
  const historyLimit = options?.historyLimit ?? HISTORY_LIMIT_PER_QUERY;
  const knowledgeLimit = options?.knowledgeLimit ?? KNOWLEDGE_LIMIT_PER_QUERY;

  const seenHistoryKeys = new Set<string>();
  const seenKnowledgeKeys = new Set<string>();

  const historyEntries: Array<{ sessionId: string; entryId: string; content: string; isCompressed: boolean; score: number; createdAt: string }> = [];
  const knowledgeEntries: Array<{ path: string; content: string; score: number }> = [];
  const sources: ContextSource[] = [];

  const debugPerQuery: Array<{ query: string; historyHits: number; knowledgeHits: number }> = [];

  const perQueryResults = await Promise.all(
    queries.map(async (query, i) => {
      agentDebug("[Smart context] buildRawRetrievedContext: searching query", i + 1, "of", queries.length, query);
      try {
        const queryEmbedding = await embedder.embed(query);
        const [histHits, knowledgeHits] = await Promise.all([
          searchHistory(ctx, embedder, query, historyLimit, queryEmbedding),
          searchKnowledge(ctx, embedder, query, knowledgeLimit, { scope: "global", queryEmbedding }),
        ]);
        return { query, histHits, knowledgeHits };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        agentDebug(
          "[Smart context] buildRawRetrievedContext: query failed, skipping",
          { query, error: msg },
        );
        return { query, histHits: [] as HistorySearchResult[], knowledgeHits: [] as KnowledgeSearchResult[] };
      }
    }),
  );

  for (const { query, histHits, knowledgeHits } of perQueryResults) {
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

  agentDebug(
    "[Smart context] buildRawRetrievedContext: per-query hits",
    debugPerQuery,
    "total history:",
    historyEntries.length,
    "total knowledge:",
    knowledgeEntries.length,
  );

  if (historyEntries.length === 0 && knowledgeEntries.length === 0) {
    return { text: "No relevant prior context found.", sources: [], contents: [], maxScore: 0 };
  }

  const queryTerms = [...new Set(queries.flatMap((q) => extractKeywords(q)))];
  const hasKeywordMatch = (content: string): boolean =>
    queryTerms.length > 0 && queryTerms.some((t) => content.toLowerCase().includes(t));

  for (const h of historyEntries) {
    if (hasKeywordMatch(h.content)) {
      h.score *= 1 + KEYWORD_BOOST_FACTOR;
    }
  }
  for (const k of knowledgeEntries) {
    if (hasKeywordMatch(k.content)) {
      k.score *= 1 + KEYWORD_BOOST_FACTOR;
    }
  }
  if (historyEntries.length >= 2) {
    const createdDates = historyEntries.map((h) => new Date(h.createdAt).getTime());
    const minT = Math.min(...createdDates);
    const maxT = Math.max(...createdDates);
    const range = maxT - minT || 1;
    for (const h of historyEntries) {
      const normalizedRecency = (new Date(h.createdAt).getTime() - minT) / range;
      h.score *= 1 + RECENCY_BOOST_FACTOR * normalizedRecency;
    }
  }
  historyEntries.sort((a, b) => b.score - a.score);
  knowledgeEntries.sort((a, b) => b.score - a.score);

  const sortedSources: ContextSource[] = [];
  const idToContent = new Map<string, string>();
  for (const h of historyEntries) {
    const id = `history:${h.sessionId}/${h.entryId}`;
    idToContent.set(id, h.content);
    sortedSources.push({ type: "history", id });
  }
  for (const k of knowledgeEntries) {
    const id = `knowledge:${k.path}`;
    idToContent.set(id, k.content);
    sortedSources.push({ type: "knowledge", id });
  }

  const allScores = [
    ...historyEntries.map((h) => h.score),
    ...knowledgeEntries.map((k) => k.score),
  ];
  const maxScore = allScores.length > 0 ? Math.max(...allScores) : 0;

  const contents = sortedSources.map((s) => idToContent.get(s.id) ?? "");
  const text = buildRawTextFromChunks(sortedSources, contents);

  return { text, sources: sortedSources, contents, maxScore };
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

/** Minimum length for a token to be used as a keyword (avoids single letters). */
const MIN_KEYWORD_LENGTH = 2;

/** Max paragraph length (chars) before we split into sentences for matching. */
const MAX_PARAGRAPH_LENGTH_FOR_MATCH = 500;

/**
 * Extracts significant terms from text for keyword matching: split on non-alphanumeric,
 * keep terms at least MIN_KEYWORD_LENGTH, dedupe. Returns lowercase for case-insensitive match.
 * @param text - Raw text (e.g. user message or search query).
 * @returns Array of lowercase keyword strings.
 */
function extractKeywords(text: string): string[] {
  const terms = text
    .split(/[\s\p{P}\p{S}]+/u)
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length >= MIN_KEYWORD_LENGTH);
  return [...new Set(terms)];
}

/**
 * Extracts relevant spans from source contents using a keyword/regex pass (no LLM).
 * Splits each content into paragraphs (or sentences when paragraph is long); includes
 * any paragraph or sentence that contains any of the keywords derived from userMessage
 * and searchQueries. Output shape matches quote extraction for use with cleanupQuotes and
 * buildFocusedContextBlock.
 * @param userMessage - Current user message; used to derive keywords.
 * @param searchQueries - Optional search queries; terms are added to the keyword set.
 * @param sources - Filtered sources (same order as contents).
 * @param contents - Full content per source.
 * @returns Array of { sourceId, text } for matching paragraphs/sentences.
 */
export function extractRelevantSpansByKeyword(
  userMessage: string,
  searchQueries: string[],
  sources: ContextSource[],
  contents: string[],
): Array<{ sourceId: string; text: string }> {
  const allKeywords = [
    ...extractKeywords(userMessage),
    ...searchQueries.flatMap((q) => extractKeywords(q)),
  ];
  const uniqueKeywords = [...new Set(allKeywords)];
  if (uniqueKeywords.length === 0) {
    return [];
  }

  function hasAnyKeyword(text: string): boolean {
    const lower = text.toLowerCase();
    return uniqueKeywords.some((kw) => lower.includes(kw));
  }

  const result: Array<{ sourceId: string; text: string }> = [];

  for (let i = 0; i < sources.length; i++) {
    const sourceId = sources[i].id;
    const content = contents[i] ?? "";
    if (!content.trim()) continue;

    const paragraphs = content.split(/\n\n+/);
    for (const para of paragraphs) {
      const trimmed = para.trim();
      if (!trimmed) continue;
      if (trimmed.length <= MAX_PARAGRAPH_LENGTH_FOR_MATCH) {
        if (hasAnyKeyword(trimmed)) {
          result.push({ sourceId, text: trimmed });
        }
      } else {
        const sentences = trimmed.split(/(?<=[.!?])\s+/);
        for (const sent of sentences) {
          const s = sent.trim();
          if (s.length === 0) continue;
          if (hasAnyKeyword(s)) {
            result.push({ sourceId, text: s });
          }
        }
      }
    }
  }

  return result;
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
    searchQueries?: string[];
    allRetrievedSourceIds?: string[];
    retryOptions?: RateLimitRetryOptions;
  },
): Promise<SummarizeResult> {
  const contents = options?.contents;
  const userMessage = options?.userMessage ?? "";
  const searchQueries = options?.searchQueries ?? [];
  const retryOptions = options?.retryOptions;
  const allRetrievedSourceIds = options?.allRetrievedSourceIds ?? [];

  if (contents != null && contents.length === sources.length) {
    agentDebug("[Smart context] summarizeRetrievedContext: using keyword span extraction (focused quotes)");
    const rawSpans = extractRelevantSpansByKeyword(userMessage, searchQueries, sources, contents);
    agentDebug("[Smart context] keyword span extraction: raw spans count", rawSpans.length);
    const contentMap = new Map<string, string>();
    for (let i = 0; i < sources.length; i++) contentMap.set(sources[i].id, contents[i] ?? "");
    const quotes = cleanupQuotes(rawSpans, contentMap);
    const quotedSourceIds = [...new Set(quotes.map((q) => q.sourceId))];
    const additionalSourceIds = allRetrievedSourceIds.filter((id) => !quotedSourceIds.includes(id));
    if (quotes.length === 0) {
      const fallbackBlock = `## Smart context\n\nNo relevant spans found. Raw context:\n\n${rawText}`;
      agentDebug("[Smart context] keyword span extraction: no spans after cleanup, using raw context fallback");
      logDebugSection("RESULT (keyword span extraction)", fallbackBlock);
      return {
        block: fallbackBlock,
        quotes: [],
      };
    }
    const block = buildFocusedContextBlock(quotes, quotedSourceIds, additionalSourceIds);
    agentDebug("[Smart context] keyword span extraction: result length", block.length, "quotes count", quotes.length);
    logDebugSection("RESULT (keyword span extraction)", block);
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
 * Result of buildSmartContextBlock: the markdown block and the list of source IDs included.
 */
export interface BuildSmartContextResult {
  /** Markdown section (e.g. "## Smart context\n\n...") or "" when no results. */
  block: string;
  /** Source IDs that were included in the summary (history:..., knowledge:...). */
  sourceIds: string[];
}

/**
 * Builds the smart context block for the agent system prompt: extract queries from the user
 * message (and optional recent conversation), retrieves history and knowledge, filters and
 * summarizes with citations. Used by the agent runner to inject relevant context upfront.
 * @param ctx - Application context
 * @param providerFactory - Factory to create an AI provider (for query extraction, filtering, summarization)
 * @param userMessage - Current user message to base search queries on
 * @param recentConversation - Optional formatted recent thread for disambiguation (e.g. "that", "it")
 * @returns Object with block (markdown section or "") and sourceIds (IDs included in the summary)
 * @note When no model is configured or retrieval returns nothing, returns { block: "", sourceIds: [] }.
 * @example
 * const { block, sourceIds } = await buildSmartContextBlock(ctx, providerFactory, userMessage, recentThreadBlock);
 * const combined = transformContext(recentThreadBlock, block, systemPromptContent);
 */
export async function buildSmartContextBlock(
  ctx: AppContext,
  providerFactory: ProviderFactory,
  userMessage: string,
  recentConversation?: string,
): Promise<BuildSmartContextResult> {
  const rawQueries = await extractSearchQueries(ctx, providerFactory, userMessage, recentConversation);
  const queries = rawQueries.slice(0, MAX_QUERIES_CAP);
  const { text: rawContext, sources, contents, maxScore } = await buildRawRetrievedContext(ctx, queries);
  if (sources.length === 0) {
    return { block: "", sourceIds: [] };
  }
  const skipFilter =
    sources.length <= SKIP_FILTER_SOURCE_COUNT_THRESHOLD ||
    (maxScore >= SKIP_FILTER_MAX_SCORE_THRESHOLD && sources.length <= HIGH_SCORE_SOURCE_CAP);
  let finalSources: ContextSource[];
  let finalContents: string[];
  if (skipFilter) {
    finalSources = sources;
    finalContents = contents;
  } else {
    const filtered = await filterRelevantSources(ctx, providerFactory, userMessage, sources, contents);
    finalSources = filtered.sources;
    finalContents = filtered.contents;
  }
  if (finalSources.length === 0) {
    return {
      block: "## Smart context\n\nNo relevant prior context found.",
      sourceIds: [],
    };
  }
  const filteredRawContext = buildRawTextFromChunks(finalSources, finalContents);
  const allRetrievedSourceIds = sources.map((s) => s.id);
  const summarizeResult = await summarizeRetrievedContext(
    ctx,
    providerFactory,
    filteredRawContext,
    finalSources,
    {
      contents: finalContents,
      userMessage,
      searchQueries: queries,
      allRetrievedSourceIds,
    },
  );
  const block = typeof summarizeResult === "string" ? summarizeResult : summarizeResult.block;
  const sourceIds = finalSources.map((s) => s.id);
  return { block, sourceIds };
}

/**
 * Counts conversation rounds (user messages) in the session.
 * Used to tell the agent how many rounds exist before the last N included in the prompt.
 * @param session - The current session
 * @returns Number of entries with role "user" in session.original
 */
export function countUserRounds(session: Session): number {
  return session.original.filter((e) => e.role === "user").length;
}

/**
 * @brief Builds a compact history block of context-aware user commands for the system prompt.
 * @param session Current session
 * @returns Markdown block listing rounds and their resolved commands, or a no-context message when empty
 */
export function buildContextAwareCommandsBlock(session: Session): string {
  const userEntries = session.original.filter((e) => e.role === "user");
  if (userEntries.length === 0) {
    return "## Context-aware commands\n\nNo prior user commands in this session.";
  }
  const lines: string[] = ["## Context-aware commands", ""];
  let seenUserRounds = 0;
  for (const entry of userEntries) {
    seenUserRounds += 1;
    const roundIndex = entry.roundIndex ?? seenUserRounds;
    const resolved = (entry.resolvedContent ?? entry.content).trim();
    lines.push(`Round ${roundIndex}: ${resolved}`);
  }
  return lines.join("\n");
}

/** Options for formatRecentThreadTurns. */
export interface FormatRecentThreadOptions {
  /** When true, omit thinking entries from the section (for agent context; thinking is display-only). */
  skipThinking?: boolean;
}

/**
 * Formats the last `count` rounds from session.original as a labeled markdown section.
 * A "round" is anchored by a user message; the section includes that user message and all entries up to the next round or end.
 * Includes tool arguments and results for tool_call entries.
 * @param session - The current session
 * @param count - How many recent rounds to include
 * @param options - Optional: skipThinking to exclude thinking entries (for agent prompt context)
 * @returns Formatted markdown section string
 */
export function formatRecentThreadTurns(
  session: Session,
  count: number,
  options?: FormatRecentThreadOptions,
): string {
  const entries = session.original;
  const turns = Math.max(1, count);
  const skipThinking = options?.skipThinking === true;
  const source = skipThinking ? entries.filter((e) => e.role !== "thinking") : entries;

  if (source.length === 0) {
    const heading = `## Recent thread (last ${turns} turns)`;
    return `${heading}\n\nNo recent turns in this session.`;
  }

  const userIndices: number[] = [];
  for (let i = source.length - 1; i >= 0; i--) {
    if (source[i].role === "user") {
      userIndices.push(i);
      if (userIndices.length === turns) break;
    }
  }

  let take: typeof source;
  if (userIndices.length > 0) {
    const earliestUserIndex = userIndices[userIndices.length - 1] ?? 0;
    take = source.slice(earliestUserIndex);
  } else {
    take = source.slice(-turns);
  }

  const heading = `## Recent thread (last ${turns} turns)`;

  const formatted = take.map((entry) => {
      const label =
        entry.role === "user"
          ? "**User:**"
          : entry.role === "agent"
            ? "**Assistant:**"
            : entry.role === "thinking"
              ? "**Reasoning:**"
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

/** Separator between context blocks and system prompt in the combined system content. */
const CONTEXT_SYSTEM_SEP = "\n\n---\n\n";

/**
 * Transforms context blocks and system prompt into the single string sent as the system message.
 * Pipeline step: recent thread + smart context → combined system content for the LLM.
 * @param recentThreadBlock - Formatted recent thread turns (e.g. from formatRecentThreadTurns).
 * @param smartContextBlock - Optional smart context section (query → retrieve → summarize).
 * @param systemPromptContent - Agent instructions and identity (e.g. from buildSystemPrompt).
 * @returns Combined system content (context + separator + system prompt).
 * @example
 * const combined = transformContext(recentThreadBlock, smartContextBlock, systemPromptContent);
 */
export function transformContext(
  recentThreadBlock: string,
  smartContextBlock: string,
  systemPromptContent: string,
): string {
  const contextBlocks = [recentThreadBlock, smartContextBlock].filter(Boolean).join("\n\n");
  return contextBlocks + CONTEXT_SYSTEM_SEP + systemPromptContent;
}

/**
 * Builds the initial Message[] for the LLM from system content, user message, and optional tool result.
 * Pipeline step: converts "logical" context (system + user + optional tool) to the provider's Message[] format.
 * @param combinedSystemContent - Full system message content (e.g. from transformContext).
 * @param userMessage - The user's message text.
 * @param initialToolResult - Optional first-turn tool result (e.g. from cron initialToolCall).
 * @returns Messages array for the first LLM request.
 * @example
 * const messages = convertToLlm(combinedSystemContent, userMessage, initialToolResult);
 */
export function convertToLlm(
  combinedSystemContent: string,
  userMessage: string,
  initialToolResult?: { content: string; toolName: string },
): Message[] {
  const messages: Message[] = [
    { role: "system", content: combinedSystemContent },
    { role: "user", content: userMessage },
  ];
  if (initialToolResult) {
    messages.push({
      role: "tool",
      content: initialToolResult.content,
      toolCallId: "cron-initial",
      toolName: initialToolResult.toolName,
    });
  }
  return messages;
}
