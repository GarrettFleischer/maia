/**
 * @fileoverview API route to clear all embeddings and rebuild from knowledge and history.
 * @module app/api/embeddings/rebuild
 *
 * POST /api/embeddings/rebuild — Clears knowledge_vectors and history_vectors,
 * then re-indexes all knowledge files and history entries.
 */

import { NextResponse } from "next/server";
import { ensureAppContext } from "@/instrumentation";
import { enqueue } from "@/lib/queue/llm-queue";

export async function POST() {
  try {
    const ctx = await ensureAppContext();
    const result = (await enqueue(
      { tool: "rebuildEmbeddings", args: {}, caller: "system" },
      () => ctx,
    )) as { knowledgeIndexed: number; knowledgeRemoved: number; historyIndexed: number };
    return NextResponse.json({
      ok: true,
      knowledgeIndexed: result.knowledgeIndexed,
      knowledgeRemoved: result.knowledgeRemoved,
      historyIndexed: result.historyIndexed,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[Embeddings rebuild] Failed:", message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
