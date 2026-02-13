/**
 * @fileoverview Memory subsystem public exports.
 * @module memory
 */

export { createDailyLog } from "./daily-log.js";
export { createCuratedMemory } from "./curated.js";
export { createMemoryStore } from "./store.js";
export { createHybridSearch } from "./search.js";
export { createConsolidator } from "./consolidator.js";
export { createAutoRecall } from "./auto-recall.js";
export { createEmbeddingProvider } from "./embeddings.js";
export type { EmbeddingProvider, EmbeddingProviderDeps } from "./embeddings.js";
export { createTextChunker } from "./chunker.js";
export type { TextChunker, TextChunk, ChunkerOptions } from "./chunker.js";
