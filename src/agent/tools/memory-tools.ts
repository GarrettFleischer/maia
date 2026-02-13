/**
 * @fileoverview Memory tools for the agent: memory_search, memory_store, memory_forget.
 * @module agent/tools/memory-tools
 *
 * @note These tools allow the LLM to interact with the memory subsystem:
 * - memory_search: Query stored memories by text and optional category
 * - memory_store: Persist a new memory entry (respects privacy mode)
 * - memory_forget: Remove a memory entry by ID
 */

import type {
  Logger,
  MemoryCategory,
  MemoryStore,
} from "../../core/types.js";
import type { AgentTool, ToolContext, ToolResult } from "./base.js";

/**
 * @brief Dependencies for creating memory tools.
 */
export interface MemoryToolsDeps {
  store: MemoryStore;
  logger: Logger;
}

/** @brief Valid memory categories for validation */
const VALID_CATEGORIES: MemoryCategory[] = [
  "preference",
  "fact",
  "decision",
  "entity",
  "other",
];

/**
 * @brief Creates the memory_search tool.
 * @param deps - Dependencies: store, logger
 * @returns AgentTool for searching memories
 *
 * @example
 * const tool = createMemorySearchTool({ store, logger });
 * // LLM calls: memory_search({ query: "favorite color", category: "preference" })
 */
export function createMemorySearchTool(deps: MemoryToolsDeps): AgentTool {
  const { store, logger } = deps;

  return {
    name: "memory_search",
    description: "Search stored memories by query text and optional category.",

    definition() {
      return {
        name: "memory_search",
        description:
          "Search the memory database for relevant stored information. Returns matching memories ranked by relevance.",
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Search query text",
            },
            category: {
              type: "string",
              enum: VALID_CATEGORIES,
              description: "Optional category filter",
            },
            limit: {
              type: "number",
              description: "Maximum number of results (default: 5)",
            },
          },
          required: ["query"],
        },
      };
    },

    async execute(
      args: Record<string, unknown>,
      _context: ToolContext
    ): Promise<ToolResult> {
      const query = String(args.query ?? "");
      if (!query) {
        return { content: "Error: query is required.", success: false };
      }

      const category = args.category as MemoryCategory | undefined;
      const limit = typeof args.limit === "number" ? args.limit : 5;

      try {
        const results = await store.search(query, { category, limit });

        if (results.length === 0) {
          return {
            content: "No memories found matching the query.",
            success: true,
            data: { count: 0 },
          };
        }

        const formatted = results
          .map(
            (r, i) =>
              `${i + 1}. [${r.entry.category}] (importance: ${r.entry.importance}) ${r.entry.text}`
          )
          .join("\n");

        logger.debug("Memory search completed", {
          query,
          resultsCount: results.length,
        });

        return {
          content: `Found ${results.length} memories:\n${formatted}`,
          success: true,
          data: {
            count: results.length,
            ids: results.map((r) => r.entry.id),
          },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error("Memory search failed", { query, error: message });
        return { content: `Memory search error: ${message}`, success: false };
      }
    },
  };
}

/**
 * @brief Creates the memory_store tool.
 * @param deps - Dependencies: store, logger
 * @returns AgentTool for storing memories
 *
 * @note Respects privacy mode: when active, returns a message instead of storing.
 *
 * @example
 * const tool = createMemoryStoreTool({ store, logger });
 * // LLM calls: memory_store({ text: "User likes blue", category: "preference", importance: 7 })
 */
export function createMemoryStoreTool(deps: MemoryToolsDeps): AgentTool {
  const { store, logger } = deps;

  return {
    name: "memory_store",
    description: "Store a new memory entry in the database.",

    definition() {
      return {
        name: "memory_store",
        description:
          "Store a new piece of information in long-term memory. Use this to remember important facts, preferences, decisions, or entities.",
        parameters: {
          type: "object",
          properties: {
            text: {
              type: "string",
              description: "The information to remember",
            },
            category: {
              type: "string",
              enum: VALID_CATEGORIES,
              description: "Category: preference, fact, decision, entity, or other",
            },
            importance: {
              type: "number",
              description: "Importance level 1-10 (default: 5)",
            },
          },
          required: ["text", "category"],
        },
      };
    },

    async execute(
      args: Record<string, unknown>,
      context: ToolContext
    ): Promise<ToolResult> {
      // Respect privacy mode
      if (context.privacyMode) {
        logger.debug("Memory store skipped: privacy mode active", {
          sessionId: context.sessionId,
        });
        return {
          content: "Privacy mode is active. Memory was not stored.",
          success: true,
          data: { skipped: true, reason: "privacy_mode" },
        };
      }

      const text = String(args.text ?? "");
      if (!text) {
        return { content: "Error: text is required.", success: false };
      }

      const category = String(args.category ?? "other") as MemoryCategory;
      if (!VALID_CATEGORIES.includes(category)) {
        return {
          content: `Error: invalid category. Must be one of: ${VALID_CATEGORIES.join(", ")}`,
          success: false,
        };
      }

      const importance =
        typeof args.importance === "number"
          ? Math.min(10, Math.max(1, args.importance))
          : 5;

      try {
        const entry = await store.store({
          text,
          category,
          importance,
        });

        logger.debug("Memory stored via tool", {
          id: entry.id,
          category,
          importance,
        });

        return {
          content: `Memory stored (id: ${entry.id}, category: ${category}, importance: ${importance}).`,
          success: true,
          data: { id: entry.id },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error("Memory store failed", { error: message });
        return { content: `Memory store error: ${message}`, success: false };
      }
    },
  };
}

/**
 * @brief Creates the memory_forget tool.
 * @param deps - Dependencies: store, logger
 * @returns AgentTool for removing memories by ID
 *
 * @example
 * const tool = createMemoryForgetTool({ store, logger });
 * // LLM calls: memory_forget({ id: "abc-123" })
 */
export function createMemoryForgetTool(deps: MemoryToolsDeps): AgentTool {
  const { store, logger } = deps;

  return {
    name: "memory_forget",
    description: "Remove a memory entry by its ID.",

    definition() {
      return {
        name: "memory_forget",
        description: "Remove a stored memory by its ID. Use this when information is outdated or incorrect.",
        parameters: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description: "The memory entry ID to remove",
            },
          },
          required: ["id"],
        },
      };
    },

    async execute(
      args: Record<string, unknown>,
      _context: ToolContext
    ): Promise<ToolResult> {
      const id = String(args.id ?? "");
      if (!id) {
        return { content: "Error: id is required.", success: false };
      }

      try {
        // Verify it exists first
        const existing = await store.get(id);
        if (!existing) {
          return {
            content: `Memory with id '${id}' not found.`,
            success: false,
          };
        }

        await store.remove(id);
        logger.debug("Memory removed via tool", { id });

        return {
          content: `Memory '${id}' has been removed.`,
          success: true,
          data: { id },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error("Memory forget failed", { id, error: message });
        return { content: `Memory forget error: ${message}`, success: false };
      }
    },
  };
}
