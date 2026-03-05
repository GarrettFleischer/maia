/**
 * @fileoverview API route to migrate existing knowledge_vectors and history_vectors to MuninnDB.
 * @module app/api/embeddings/migrate-to-muninn
 *
 * POST /api/embeddings/migrate-to-muninn — Reads all rows from both vector tables,
 * writes them as engrams to Muninn in batches of 50. Returns counts or error.
 * Requires Muninn URL to be set in Settings and Muninn to be reachable.
 */

import { NextResponse } from "next/server";
import { ensureAppContext } from "@/instrumentation";
import { migrateVectorsToMuninn } from "@/lib/muninn/migrate-vectors-to-muninn";

export async function POST() {
  try {
    const ctx = await ensureAppContext();
    const result = await migrateVectorsToMuninn(ctx);
    if (result.error) {
      return NextResponse.json(
        {
          ok: false,
          error: result.error,
          knowledgeWritten: result.knowledgeWritten,
          historyWritten: result.historyWritten,
        },
        { status: 400 },
      );
    }
    return NextResponse.json({
      ok: true,
      knowledgeWritten: result.knowledgeWritten,
      historyWritten: result.historyWritten,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[Embeddings migrate-to-muninn] Failed:", message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
