/**
 * @fileoverview One-time migration: transfer knowledge_vectors and history_vectors
 * into MuninnDB engrams via the batch API.
 * @module lib/muninn/migrate-vectors-to-muninn
 *
 * Reads every row from both tables, builds engram payloads (concept ≤512B, content ≤16KB),
 * and writes in batches of 50. Idempotent on retry (re-running may create duplicates in Muninn
 * unless Muninn supports idempotent_id; caller may clear vault first if needed).
 */

import type { AppContext } from "../context";
import { getMuninnConfig } from "./config";
import { createMuninnClient } from "./client";
import type { EngramBatchItem } from "./client";
import { vaultFromKnowledgePath } from "./vault";

const CONCEPT_MAX = 512;
const CONTENT_MAX = 16 * 1024;

export interface MigrateVectorsResult {
  /** Number of knowledge engrams written to Muninn. */
  knowledgeWritten: number;
  /** Number of history engrams written to Muninn. */
  historyWritten: number;
  /** Error message if migration failed (e.g. Muninn unreachable). */
  error?: string;
}

/**
 * Reads knowledge_vectors and history_vectors from the app DB and writes them as engrams to Muninn.
 * Requires Muninn to be configured (muninnUrl set) and reachable.
 * @param ctx - Application context (db, http)
 * @returns Counts of engrams written, or error message on failure
 */
export async function migrateVectorsToMuninn(
  ctx: AppContext,
): Promise<MigrateVectorsResult> {
  const config = getMuninnConfig(ctx);
  if (!config.enabled) {
    return {
      knowledgeWritten: 0,
      historyWritten: 0,
      error: "Muninn is not configured (muninnUrl is empty)",
    };
  }

  const client = createMuninnClient(ctx.http, config.baseUrl);
  const items: EngramBatchItem[] = [];

  const knowledgeRows = ctx.db
    .prepare("SELECT path, content FROM knowledge_vectors")
    .all() as { path: string; content: string }[];

  for (const row of knowledgeRows) {
    const vault = vaultFromKnowledgePath(row.path);
    items.push({
      vault,
      concept: row.path.slice(0, CONCEPT_MAX),
      content: row.content.slice(0, CONTENT_MAX),
      tags: ["knowledge", row.path],
    });
  }

  const knowledgeCount = items.length;

  const historyRows = ctx.db
    .prepare(
      "SELECT session_id, entry_id, content, is_compressed FROM history_vectors",
    )
    .all() as {
    session_id: string;
    entry_id: string;
    content: string;
    is_compressed: number;
  }[];

  for (const row of historyRows) {
    const concept = `session:${row.session_id} entry:${row.entry_id}`.slice(
      0,
      CONCEPT_MAX,
    );
    items.push({
      vault: "default",
      concept,
      content: row.content.slice(0, CONTENT_MAX),
      tags: [
        "history",
        row.session_id,
        row.entry_id,
        row.is_compressed === 1 ? "compressed" : "original",
      ],
    });
  }

  try {
    const { written } = await client.writeEngramBatch(items);
    const historyCount = items.length - knowledgeCount;
    return {
      knowledgeWritten: knowledgeCount,
      historyWritten: historyCount,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      knowledgeWritten: 0,
      historyWritten: 0,
      error: msg,
    };
  }
}
