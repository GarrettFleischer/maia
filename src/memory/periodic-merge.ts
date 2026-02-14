/**
 * @fileoverview Periodic memory merge: runs every N minutes (e.g. 10) when a
 * user message is received. Combines one LLM call that (1) replies to the user
 * and (2) extracts memory from the daily chat history since the last merge.
 * @module memory/periodic-merge
 *
 * @note Reduces API usage by batching extraction with the user's chat instead
 * of running incremental extract after every message. Uses a marker file
 * (.last-merge.json) to track how much of today's daily log has been merged.
 */

import type {
  Clock,
  Database,
  FileSystem,
  LLMProvider,
  Logger,
} from "../core/types.js";
import type { ContextBuilder } from "../agent/context.js";
import type { DailyLog } from "./daily-log.js";
import {
  applyExtractionResponse,
  type ExtractionResponse,
  type ApplyExtractionDeps,
} from "./incremental-extract.js";
import { redactSecretsFromResponse } from "../security/content-sanitizer.js";

/** @brief Delimiter between reply text and extraction JSON in LLM output. */
const MEMORY_EXTRACTION_DELIMITER = "---MEMORY_EXTRACTION---";

/** @brief Default interval between merges (10 minutes). */
const DEFAULT_MERGE_INTERVAL_MS = 10 * 60 * 1000;

/**
 * @brief Persisted state for the last merge (marker for "point merged last").
 */
export interface LastMergeState {
  /** Date of the log file (YYYY-MM-DD). */
  date: string;
  /** Byte offset into that day's log; next merge reads from here. */
  byteOffset: number;
  /** ISO timestamp when the merge ran. */
  mergedAt: string;
}

/**
 * @brief Dependencies for createPeriodicMerge.
 */
export interface PeriodicMergeDeps {
  fs: FileSystem;
  db: Database;
  logger: Logger;
  llm: LLMProvider;
  workspacePath: string;
  contextBuilder: ContextBuilder;
  dailyLog: DailyLog;
  clock: Clock;
  /** Optional: recall memory for context when building system prompt. */
  recallMemory?: (query: string) => Promise<string>;
  /** Optional: thread summary for the session. */
  getThreadSummary?: (sessionId: string) => string | undefined;
  /** Min ms between merges (default 10 min). */
  mergeIntervalMs?: number;
}

/**
 * @brief Merge strategy used by the runtime: decide whether to merge and run merge.
 */
export interface MergeStrategy {
  /** True if the next user message should trigger a merge (time + state). */
  shouldRunMerge(): Promise<boolean>;
  /**
   * Runs one combined LLM call: reply to user + extract memory from log since last merge.
   * Appends the exchange to the daily log and updates last-merge state.
   * @param userMessage - Current user message
   * @param sessionId - Session ID (for thread summary if available)
   * @returns The assistant reply to send to the user
   */
  runMerge(userMessage: string, sessionId: string): Promise<string>;
}

/**
 * @brief Instructions appended to the system prompt for the combined reply+extract format.
 */
const MERGE_RESPONSE_FORMAT = `

## Response format (you must follow this exactly)
1. First, write your reply to the user in natural language.
2. Then on a new line write exactly: ${MEMORY_EXTRACTION_DELIMITER}
3. Then a newline, then valid JSON with these fields only (no markdown fences):
   - memories: array of { "text": string, "category": "preference"|"fact"|"decision"|"entity"|"other", "importance": 0.0-1.0 }
   - memoryMdUpdates: string (markdown to append to MEMORY.md, or "")
   - userMdUpdates: string (markdown to append to USER.md, or "")
   - soulMdUpdates: string (markdown to append to SOUL.md, or "")
   - knowledgeNotes: array of { "path": string, "content": string }
Extract only what is worth remembering from the conversation since last merge. Be conservative.`;

/**
 * @brief Creates a periodic merge strategy.
 * @param deps - Dependencies including dailyLog, clock, contextBuilder, llm
 * @returns MergeStrategy for the runtime
 *
 * @example
 * const strategy = createPeriodicMerge({ fs, db, logger, llm, workspacePath, contextBuilder, dailyLog, clock, mergeIntervalMs: 600000 });
 * if (await strategy.shouldRunMerge()) {
 *   const reply = await strategy.runMerge(message.content, sessionId);
 *   // send reply, skip onAfterReply
 * }
 */
export function createPeriodicMerge(deps: PeriodicMergeDeps): MergeStrategy {
  const {
    fs,
    db,
    logger,
    llm,
    workspacePath,
    contextBuilder,
    dailyLog,
    clock,
    recallMemory,
    getThreadSummary,
    mergeIntervalMs = DEFAULT_MERGE_INTERVAL_MS,
  } = deps;

  const statePath = `${workspacePath}/memory/.last-merge.json`;

  /**
   * @brief Reads last-merge state from disk.
   * @returns State or null if missing/invalid; resets byteOffset to 0 if date !== today.
   */
  async function readState(): Promise<LastMergeState | null> {
    try {
      const exists = await fs.exists(statePath);
      if (!exists) return null;
      const raw = await fs.readFile(statePath);
      const state = JSON.parse(raw) as LastMergeState;
      const today = clock.todayString();
      if (state.date !== today) {
        return { date: today, byteOffset: 0, mergedAt: state.mergedAt ?? "" };
      }
      return state;
    } catch {
      return null;
    }
  }

  /**
   * @brief Writes last-merge state to disk.
   */
  async function writeState(state: LastMergeState): Promise<void> {
    try {
      const dir = statePath.slice(0, statePath.lastIndexOf("/"));
      await fs.mkdir(dir).catch(() => {});
      await fs.writeFile(statePath, JSON.stringify(state));
    } catch (err) {
      logger.warn("Failed to write last-merge state", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    async shouldRunMerge(): Promise<boolean> {
      const state = await readState();
      if (!state || !state.mergedAt) return true;
      const mergedAtMs = new Date(state.mergedAt).getTime();
      if (Number.isNaN(mergedAtMs)) return true;
      return Date.now() - mergedAtMs >= mergeIntervalMs;
    },

    async runMerge(userMessage: string, sessionId: string): Promise<string> {
      const today = clock.todayString();
      const state = await readState();
      const byteOffset = state?.date === today ? state.byteOffset : 0;

      const logSinceMerge = await dailyLog.readTodayFromOffset(byteOffset);

      const memoryContext = recallMemory ? await recallMemory(userMessage).catch(() => "") : "";
      const threadSummary = getThreadSummary?.(sessionId);
      const systemMessage = await contextBuilder.buildSystemPrompt({
        memoryContext: memoryContext || undefined,
        threadSummary,
      });
      systemMessage.content += MERGE_RESPONSE_FORMAT;

      const conversationBlock = logSinceMerge.trim()
        ? `## Conversation since last merge\n${logSinceMerge}\n\n`
        : "";
      const userPrompt = `${conversationBlock}## Current user message\n${userMessage}`;

      const messages = [
        systemMessage,
        { role: "user" as const, content: userPrompt },
      ];

      let fullResponse = "";
      const stream = llm.chat(messages);
      for await (const chunk of stream) {
        if (chunk.content) fullResponse += chunk.content;
      }
      fullResponse = redactSecretsFromResponse(fullResponse);

      const delimiterIndex = fullResponse.indexOf(MEMORY_EXTRACTION_DELIMITER);
      let reply: string;
      let jsonStr: string;

      if (delimiterIndex >= 0) {
        reply = fullResponse.slice(0, delimiterIndex).trim();
        jsonStr = fullResponse
          .slice(delimiterIndex + MEMORY_EXTRACTION_DELIMITER.length)
          .replace(/^```json\s*/i, "")
          .replace(/\s*```$/i, "")
          .trim();
      } else {
        reply = fullResponse.trim();
        jsonStr = "";
      }

      if (jsonStr) {
        try {
          const parsed = JSON.parse(jsonStr) as ExtractionResponse;
          await applyExtractionResponse(parsed, {
            fs,
            db,
            workspacePath,
            logger,
          } as ApplyExtractionDeps);
        } catch (parseErr) {
          logger.warn("Periodic merge: failed to parse extraction JSON", {
            error: parseErr instanceof Error ? parseErr.message : String(parseErr),
            snippet: jsonStr.slice(0, 150),
          });
        }
      }

      const exchange = `User: ${userMessage}\nAssistant: ${reply}`;
      await dailyLog.append(exchange);

      const newContent = await dailyLog.readToday();
      const newOffset = newContent.length;
      await writeState({
        date: today,
        byteOffset: newOffset,
        mergedAt: clock.now().toISOString(),
      });

      logger.info("Periodic merge complete", {
        replyLength: reply.length,
        logBytesMerged: logSinceMerge.length,
      });

      return reply;
    },
  };
}
