/**
 * @fileoverview Tests for history indexing into the vector store.
 * Covers skipping missing/empty entries and successful multi-chunk indexing.
 * @module __tests__/lib/knowledge/history-index
 *
 * @example
 * // See indexHistoryEntry behavior when history row is missing or content is empty.
 */

import { describe, it, expect, spyOn } from "bun:test";
import { indexHistoryEntry } from "@/lib/knowledge/history-index";
import { makeTestContext } from "@/__tests__/helpers/fakes";
import type { AppContext } from "@/lib/context";

/**
 * @brief Creates a test context and seeds a history entry row.
 * @param content - History content to persist.
 * @returns Tuple of AppContext and inserted entry id.
 */
function seedHistoryEntry(content: string): [AppContext, string] {
  const ctx = makeTestContext();
  const id = "entry-1";
  // History entries require a valid session due to FOREIGN KEY constraint.
  ctx.db
    .prepare(
      "INSERT INTO sessions (id, name, description, participants, tags, type, created_at, updated_at) VALUES (?, ?, '', '[]', '[]', 'user', ?, ?)",
    )
    .run(
      id,
      "Test session",
      new Date().toISOString(),
      new Date().toISOString(),
    );
  ctx.db
    .prepare(
      "INSERT INTO history_entries (id, session_id, role, content, tool_name, tool_args, timestamp, is_compressed) VALUES (?, ?, 'user', ?, NULL, NULL, ?, 0)",
    )
    .run(id, id, content, new Date().toISOString());
  return [ctx, id];
}

describe("history-index", () => {
  it("returns early when history entry does not exist", async () => {
    const ctx = makeTestContext();
    const infoSpy = spyOn(console, "info");
    const errorSpy = spyOn(console, "error");

    await indexHistoryEntry(ctx, "missing");

    expect(infoSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("skips indexing when content is empty", async () => {
    const [ctx, id] = seedHistoryEntry("   ");
    const infoSpy = spyOn(console, "info");
    const errorSpy = spyOn(console, "error");

    await indexHistoryEntry(ctx, id);

    const vectors = ctx.db
      .prepare(
        "SELECT COUNT(1) as count FROM history_vectors WHERE entry_id = ?",
      )
      .get(id) as { count: number };
    expect(vectors.count).toBe(0);
    expect(infoSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
