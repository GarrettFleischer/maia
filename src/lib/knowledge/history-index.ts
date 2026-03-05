/**
 * @fileoverview Index a single history entry for semantic search (MuninnDB only).
 * @module lib/knowledge/history-index
 *
 * When Muninn URL is set, writes the entry as an engram to Muninn. When not set, no-op.
 * Called fire-and-forget after appending entries (original and compressed).
 */

import { getMuninnConfig } from "../muninn/config";
import { createMuninnClient } from "../muninn/client";
import type { AppContext } from "../context";

const MUNINN_CONCEPT_MAX = 512;
const MUNINN_CONTENT_MAX = 16 * 1024;

/**
 * Load an entry from history_entries and write it to Muninn when configured.
 * Safe to call fire-and-forget; logs errors and does not throw.
 */
export async function indexHistoryEntry(
  ctx: AppContext,
  entryId: string,
): Promise<void> {
  const row = ctx.db
    .prepare(
      "SELECT id, session_id, role, content, tool_name, tool_args, timestamp, is_compressed FROM history_entries WHERE id = ?",
    )
    .get(entryId) as
    | {
        id: string;
        session_id: string;
        content: string;
        is_compressed: number;
      }
    | undefined;

  if (!row) return;

  const role = (row as { role?: string }).role;
  if (role === "smart_context") return;
  if (row.content.trim() === "") return;

  const muninnConfig = getMuninnConfig(ctx);
  if (!muninnConfig.enabled) return;

  try {
    const concept = `session:${row.session_id} entry:${row.id}`.slice(
      0,
      MUNINN_CONCEPT_MAX,
    );
    const content = row.content.slice(0, MUNINN_CONTENT_MAX);
    const tags = [
      "history",
      row.session_id,
      row.id,
      ...(role ? [role] : []),
      row.is_compressed === 1 ? "compressed" : "original",
    ];
    const client = createMuninnClient(ctx.http, muninnConfig.baseUrl);
    await client.writeEngram("default", concept, content, tags);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Muninn history write skipped:", msg, entryId);
  }
}
