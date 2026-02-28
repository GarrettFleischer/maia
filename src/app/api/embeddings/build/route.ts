/**
 * @fileoverview API route to index new knowledge and history without clearing.
 * @module app/api/embeddings/build
 *
 * POST /api/embeddings/build — Indexes new/changed knowledge files and unindexed
 * history entries. Does not clear existing embeddings.
 */

import { NextResponse } from "next/server";
import { ensureAppContext } from "@/instrumentation";
import { enqueue } from "@/lib/queue/llm-queue";

export async function POST() {
  try {
    const ctx = await ensureAppContext();
    const result = (await enqueue(
      { tool: "buildEmbeddings", args: {}, caller: "system" },
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
    console.error("[Embeddings build] Failed:", message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
