/**
 * @fileoverview Context injection: recall relevant memories and format for prompt.
 * @module memory/auto-recall
 * @brief Fetches memories by query and formats them as XML block for context.
 */

import type { Logger, MemorySearchResult, MemoryStore } from "../core/types.js";

/** @brief Dependencies for createAutoRecall */
export interface AutoRecallDeps {
  store: MemoryStore;
  logger: Logger;
  limit: number;
}

/** @brief Auto recall interface */
export interface AutoRecall {
  recall(query: string): Promise<MemorySearchResult[]>;
  formatContextBlock(query: string): Promise<string>;
}

/**
 * @brief Creates an auto recall instance.
 * @param deps - Dependencies: store, logger, limit
 * @returns AutoRecall interface
 */
export function createAutoRecall(deps: AutoRecallDeps): AutoRecall {
  const { store, logger, limit } = deps;

  return {
    async recall(query: string): Promise<MemorySearchResult[]> {
      const results = await store.search(query, { limit });
      const capped = results.slice(0, limit);
      logger.debug("Auto recall", { query, limit, count: capped.length });
      return capped;
    },

    async formatContextBlock(query: string): Promise<string> {
      const results = (await store.search(query, { limit })).slice(0, limit);
      if (results.length === 0) return "";

      const lines = results.map(
        (r) => `- [${r.entry.category}] ${r.entry.text} (importance: ${r.entry.importance})`
      );
      return `<relevant-memories>\n${lines.join("\n")}\n</relevant-memories>`;
    },
  };
}
