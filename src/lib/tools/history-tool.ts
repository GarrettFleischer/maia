import { z } from "zod";
import { zodToJsonSchema } from "../zod-to-json";
import {
  entriesForConversation,
  searchEntries,
  searchAcrossSessions,
  getSession,
} from "../history";
import {
  formatRecentThreadTurns,
  formatRoundsByIndex,
} from "../agent/context-query";
import type { Tool, ToolContext } from "./types";

function makeTool<S extends z.ZodTypeAny>(
  name: string,
  description: string,
  schema: S,
  execute: (args: z.infer<S>, ctx: ToolContext) => Promise<unknown>,
): Tool<z.infer<S>> {
  return {
    name,
    description,
    schema,
    execute,
    toDefinition: () => ({
      name,
      description,
      parameters: zodToJsonSchema(schema),
    }),
  };
}

export const historyFindTool = makeTool(
  "history_find",
  "Fuzzy search within the current session history. Example: history_find({ q: 'deployment steps' }).",
  z.object({
    q: z.string().describe("Search query"),
    mode: z.enum(["compressed", "original", "both"]).optional(),
  }),
  async ({ q: query, mode }, ctx) =>
    searchEntries(ctx, query, ctx.sessionId, mode),
);

export const historySearchAllTool = makeTool(
  "history_search_all",
  "Fuzzy search across all sessions in the knowledge base. Example: history_search_all({ q: 'API key' }).",
  z.object({
    q: z.string().describe("Search query"),
    tags: z.string().optional().describe("Comma-separated tags"),
    mode: z.enum(["compressed", "original", "both"]).optional(),
  }),
  async ({ q: query, tags, mode }, ctx) => {
    const tagList = tags
      ?.split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    return searchAcrossSessions(ctx, query, mode, tagList);
  },
);

/**
 * Resolves requested indices: from explicit list or inclusive range. Clamps to valid session indices.
 * @param indexes - Optional list of turn indices
 * @param rangeStart - Optional start of inclusive range
 * @param rangeEnd - Optional end of inclusive range
 * @param length - Session array length
 * @returns Sorted, deduplicated list of indices in [0, length), or null if no selection (full session).
 */
function resolveRequestedIndices(
  indexes: number[] | undefined,
  rangeStart: number | undefined,
  rangeEnd: number | undefined,
  length: number,
): number[] | null {
  if (length === 0) return null;
  const maxIndex = length - 1;
  if (indexes != null && indexes.length > 0) {
    const set = new Set(
      indexes
        .filter((i) => Number.isInteger(i) && i >= 0 && i <= maxIndex)
        .sort((a, b) => a - b),
    );
    return [...set];
  }
  if (rangeStart != null || rangeEnd != null) {
    const start = Math.max(0, rangeStart ?? 0);
    const end = Math.min(maxIndex, rangeEnd ?? maxIndex);
    if (start > end) return [];
    const out: number[] = [];
    for (let i = start; i <= end; i++) out.push(i);
    return out;
  }
  return null;
}

export const historyGetSessionTool = makeTool(
  "history_get_session",
  "Get session history. By default returns the full session. Pass indexes or start/end range. Example: history_get_session({ id: 's1', start: 0, end: 4 }).",
  z.object({
    id: z.string().describe("Session ID"),
    mode: z
      .enum(["compressed", "original", "both"])
      .optional()
      .describe("Layer: original, compressed, or both"),
    indexes: z
      .array(z.number().int().min(0))
      .optional()
      .describe("Turn indices"),
    start: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Range start (inclusive)"),
    end: z.number().int().min(0).optional().describe("Range end (inclusive)"),
  }),
  async (
    { id: sessionId, mode, indexes, start: rangeStart, end: rangeEnd },
    ctx,
  ) => {
    const session = getSession(ctx, sessionId);
    if (!session) return null;
    const length = session.original.length;
    const indices = resolveRequestedIndices(
      indexes,
      rangeStart,
      rangeEnd,
      length,
    );
    const includeOriginal = mode !== "compressed";
    const includeCompressed = mode === "compressed" || mode === "both";

    if (indices == null) {
      if (mode === "compressed") return { ...session, original: [] };
      if (mode === "original") return { ...session, compressed: [] };
      return session;
    }

    const entries = indices.map((index) => {
      const row: {
        index: number;
        original?: (typeof session.original)[0];
        compressed?: (typeof session.compressed)[0];
      } = { index };
      if (includeOriginal && session.original[index])
        row.original = session.original[index];
      if (includeCompressed && session.compressed[index])
        row.compressed = session.compressed[index];
      return row;
    });
    return { sessionId, mode: mode ?? "both", entries };
  },
);

export const chatReadTool = makeTool(
  "chat_read",
  "Return full context for specific conversation rounds from the current session. You must specify which round(s) you need by 1-based round number. By default reasoning/thinking entries are omitted; set include_reasoning to true to include the agent's reasoning for those rounds. The current (most recent) round is excluded so you only get prior context. Example: chat_read({ rounds: [1, 2] }) or chat_read({ rounds: [3], include_reasoning: true }).",
  z.object({
    rounds: z
      .array(z.number().int().min(1))
      .min(1)
      .describe(
        "1-based round number(s) to read (e.g. [1, 2, 5]). Current round is excluded.",
      ),
    include_reasoning: z
      .boolean()
      .optional()
      .describe(
        "When true, include reasoning/thinking entries for each round; omit for shorter context",
      ),
  }),
  async (
    { rounds: requestedRounds, include_reasoning: includeReasoning = false },
    ctx,
  ) => {
    const session = getSession(ctx, ctx.sessionId);
    if (!session) return "No session or no recent turns.";
    const entries = entriesForConversation(session.original);
    const totalUserRounds = entries.filter((e) => e.role === "user").length;
    if (totalUserRounds === 0) return "No prior turns in this session.";
    const currentRoundIndex = totalUserRounds;
    const priorRounds = requestedRounds.filter(
      (r) => r >= 1 && r < currentRoundIndex,
    );
    if (priorRounds.length === 0) {
      return (
        "No prior rounds in that range. Current round is " +
        currentRoundIndex +
        ". Request round numbers less than that (e.g. rounds: [1, 2])."
      );
    }
    return formatRoundsByIndex(session, priorRounds, {
      skipThinking: !includeReasoning,
    });
  },
);

export const historyTools: Tool[] = [
  historyFindTool,
  historySearchAllTool,
  historyGetSessionTool,
  chatReadTool,
];
