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
  console.debug("\n--- " + title + " ---\n" + truncated);
}

/** Default retries on 429 (e.g. 2 = try up to 3 times total). */
const DEFAULT_RATE_LIMIT_RETRIES = 2;

/** Default delay in ms before retrying after 429. */
const DEFAULT_RATE_LIMIT_DELAY_MS = 2000;

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
You may be given recent conversation context and the current user message. Output ONLY a JSON array of short search query strings (no prose, no code fences, no markdown).
Each query should target a different relevant topic so that semantic search over past conversations and a knowledge base returns the most relevant results for the user.
Example output: ["topic one", "topic two"]`;

const SUMMARIZE_PROMPT_PREFIX = `You are a context summarization assistant.
Summarize the retrieved context below into a concise markdown section titled "## Smart context".
For every fact you include, cite the source id in brackets, e.g. [history:sessionId/entryId] or [knowledge:path].
Only cite source ids that are listed in the Sources section.
Output ONLY the markdown section — no preamble, no postamble.

Sources available:`;

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
      console.debug(`[Smart context] rate limit (429), sleeping ${delayMs}ms then retry (attempt ${attempt + 1}/${maxRetries + 1})`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastError;
}

/**
 * Sends the user message (and optional recent conversation) to the contextQueryModel and returns
 * a deduplicated array of search query strings. Falls back to [userMessage] if the model returns
 * invalid JSON, an empty array, or throws.
 * @param ctx - Application context
 * @param providerFactory - Factory to create an AI provider for a given model
 * @param userMessage - The current user message
 * @param recentConversation - Optional formatted recent thread turns (e.g. last 3 rounds) for context
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
    console.debug("[Smart context] extractSearchQueries: skipped (no model or not whitelisted), using fallback");
    return fallback;
  }

  const userContent =
    recentConversation && recentConversation.trim().length > 0
      ? `Recent conversation:\n\n${recentConversation.trim()}\n\nCurrent user message:\n${userMessage}`
      : userMessage;

  try {
    const provider = providerFactory(model, ctx);
    console.debug("[Smart context] extractSearchQueries: sending to model");
    logDebugSection("SYSTEM PROMPT", QUERY_EXTRACTION_PROMPT);
    logDebugSection("USER / QUERY (context + current message)", userContent);
    const messages: Message[] = [
      { role: "system", content: QUERY_EXTRACTION_PROMPT },
      { role: "user", content: userContent },
    ];
    const raw = await callCheapModelWithRetry(provider, messages, retryOptions);
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
        const rawSnippet = raw.length > FALLBACK_RAW_LOG_MAX_LEN ? raw.slice(0, FALLBACK_RAW_LOG_MAX_LEN) + " [truncated]" : raw;
        console.debug("[Smart context] extractSearchQueries: no JSON array in response, using fallback. raw length:", raw.length, "snippet:", rawSnippet);
        return fallback;
      }
      parsed = JSON.parse(jsonMatch[0]);
    }

    if (!Array.isArray(parsed)) {
      const rawSnippet = raw.length > FALLBACK_RAW_LOG_MAX_LEN ? raw.slice(0, FALLBACK_RAW_LOG_MAX_LEN) + " [truncated]" : raw;
      console.debug("[Smart context] extractSearchQueries: response not an array, using fallback. raw length:", raw.length, "snippet:", rawSnippet);
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
      console.debug("[Smart context] extractSearchQueries: empty queries after parse, using fallback. raw length:", raw.length, "snippet:", rawSnippet);
      return fallback;
    }
    return queries;
  } catch (e) {
    if (isRateLimitError(e)) {
      console.debug("[Smart context] extractSearchQueries: rate limit (429) after retries, using fallback");
    } else {
      const msg = e instanceof Error ? e.message : String(e);
      console.debug("[Smart context] extractSearchQueries: error, using fallback", msg);
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

  for (let i = 0; i < queries.length; i++) {
    const query = queries[i];
    console.debug("[Smart context] buildRawRetrievedContext: searching query", i + 1, "of", queries.length, query);
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
 * @param retryOptions - Optional 429 retry config (tests can pass rateLimitDelayMs: 0)
 * @returns Summarized markdown section with citations
 */
export async function summarizeRetrievedContext(
  ctx: AppContext,
  providerFactory: ProviderFactory,
  rawText: string,
  sources: ContextSource[],
  retryOptions?: RateLimitRetryOptions,
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
  console.debug("[Smart context] Summarizer: sending", rawText.length, "chars of retrieved content in user message");
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
    console.debug("[Smart context] summarizeRetrievedContext: result length", out.length);
    logDebugSection("RESULT (summary)", out);
    return out;
  } catch (e) {
    if (isRateLimitError(e)) {
      console.debug("[Smart context] summarizeRetrievedContext: rate limit (429) after retries, returning raw context");
    } else {
      const msg = e instanceof Error ? e.message : String(e);
      console.debug("[Smart context] summarizeRetrievedContext: error, returning raw", msg);
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
