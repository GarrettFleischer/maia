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
export { createIncrementalExtract, applyExtractionResponse } from "./incremental-extract.js";
export type {
  IncrementalExtract,
  IncrementalExtractDeps,
  ExtractionResponse,
  ApplyExtractionDeps,
} from "./incremental-extract.js";
export { createPeriodicMerge } from "./periodic-merge.js";
export type {
  MergeStrategy,
  LastMergeState,
  PeriodicMergeDeps,
} from "./periodic-merge.js";
export { createRememberBlockHandler, REMEMBER_DELIMITER } from "./remember-block.js";
export type {
  RememberBlockHandler,
  RememberBlock,
  RememberedContent,
  ParseRememberResult,
  RememberBlockDeps,
} from "./remember-block.js";
export { createEmbeddingProvider } from "./embeddings.js";
export type { EmbeddingProvider, EmbeddingProviderDeps } from "./embeddings.js";
export { createTextChunker } from "./chunker.js";
export type { TextChunker, TextChunk, ChunkerOptions } from "./chunker.js";
