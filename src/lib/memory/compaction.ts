/**
 * @fileoverview Session compaction records (LCM analogue): summaries with reversible source entry ids.
 * @module lib/memory/compaction
 */

import { v4 as uuidv4 } from "uuid";
import type { AppContext } from "../context";
import type { HistoryEntry } from "../types";

/**
 * @brief Persist a compaction summary for a session.
 * @param ctx App context
 * @param sessionId Session id
 * @param summaryMarkdown Structured summary text
 * @param sourceEntryIds Ordered history entry ids replaced by this summary in context
 * @returns Compaction id
 */
export function insertSessionCompaction(
  ctx: AppContext,
  sessionId: string,
  summaryMarkdown: string,
  sourceEntryIds: string[],
): string {
  const id = uuidv4();
  const now = new Date().toISOString();
  ctx.db
    .prepare(
      `INSERT INTO session_compactions (id, session_id, summary_markdown, source_entry_ids_json, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      sessionId,
      summaryMarkdown,
      JSON.stringify(sourceEntryIds),
      now,
    );
  return id;
}

/**
 * @brief List compaction records for a session (newest first).
 * @param ctx App context
 * @param sessionId Session id
 */
export function listSessionCompactions(
  ctx: AppContext,
  sessionId: string,
): Array<{
  id: string;
  summaryMarkdown: string;
  sourceEntryIds: string[];
  createdAt: string;
}> {
  const rows = ctx.db
    .prepare(
      "SELECT id, summary_markdown, source_entry_ids_json, created_at FROM session_compactions WHERE session_id = ? ORDER BY created_at DESC",
    )
    .all(sessionId) as Array<{
    id: string;
    summary_markdown: string;
    source_entry_ids_json: string;
    created_at: string;
  }>;
  return rows.map((r) => {
    let sourceEntryIds: string[] = [];
    try {
      const p = JSON.parse(r.source_entry_ids_json) as unknown;
      if (Array.isArray(p))
        sourceEntryIds = p.filter((x): x is string => typeof x === "string");
    } catch {
      sourceEntryIds = [];
    }
    return {
      id: r.id,
      summaryMarkdown: r.summary_markdown,
      sourceEntryIds,
      createdAt: r.created_at,
    };
  });
}

/**
 * @brief Load full history entries for a compaction’s source ids (expand).
 * @param ctx App context
 * @param compactionId Compaction row id
 * @returns Summary plus verbatim entries in order
 */
export function expandSessionCompaction(
  ctx: AppContext,
  compactionId: string,
): {
  summary: string;
  entries: HistoryEntry[];
  missingIds: string[];
} | null {
  const row = ctx.db
    .prepare(
      "SELECT summary_markdown, source_entry_ids_json FROM session_compactions WHERE id = ?",
    )
    .get(compactionId) as
    | { summary_markdown: string; source_entry_ids_json: string }
    | undefined;
  if (!row) return null;
  let ids: string[] = [];
  try {
    const p = JSON.parse(row.source_entry_ids_json) as unknown;
    if (Array.isArray(p)) ids = p.filter((x): x is string => typeof x === "string");
  } catch {
    ids = [];
  }
  const entries: HistoryEntry[] = [];
  const missingIds: string[] = [];
  for (const eid of ids) {
    const h = ctx.db
      .prepare(
        "SELECT * FROM history_entries WHERE id = ?",
      )
      .get(eid) as Record<string, unknown> | undefined;
    if (!h) {
      missingIds.push(eid);
      continue;
    }
    entries.push({
      id: String(h.id),
      role: h.role as HistoryEntry["role"],
      content: String(h.content ?? ""),
      resolvedContent:
        h.resolved_content != null ? String(h.resolved_content) : undefined,
      roundIndex:
        h.round_index != null ? Number(h.round_index) : undefined,
      toolName: h.tool_name != null ? String(h.tool_name) : undefined,
      toolArgs: ((): HistoryEntry["toolArgs"] => {
        if (typeof h.tool_args !== "string" || h.tool_args === "") return undefined;
        try {
          const p = JSON.parse(h.tool_args) as unknown;
          return p != null && typeof p === "object" && !Array.isArray(p)
            ? (p as Record<string, unknown>)
            : undefined;
        } catch {
          return undefined;
        }
      })(),
      timestamp: String(h.timestamp ?? ""),
      speakerId: h.speaker_id != null ? String(h.speaker_id) : undefined,
      speakerLabel:
        h.speaker_label != null ? String(h.speaker_label) : undefined,
      personaId: h.persona_id != null ? String(h.persona_id) : undefined,
    });
  }
  return { summary: row.summary_markdown, entries, missingIds };
}
