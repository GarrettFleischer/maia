/**
 * @fileoverview Unit tests for end-of-day consolidation (daily log -> DB + MEMORY.md + knowledge).
 * @module tests/unit/memory/consolidator
 */

import { describe, it, expect } from "bun:test";
import { createConsolidator } from "../../../src/memory/consolidator.js";
import {
  inMemoryFileSystem,
  fixedClock,
  inMemoryDatabase,
  capturingLogger,
} from "../../helpers/index.js";
import type { LLMProvider, ChatMessage, ChatChunk } from "../../../src/core/types.js";

/**
 * @brief Creates a mock LLM that returns a predictable consolidation response.
 */
function mockConsolidationLLM(): LLMProvider {
  return {
    id: "mock",
    name: "Mock LLM",
    async *chat(_messages: ChatMessage[]): AsyncGenerator<ChatChunk> {
      yield {
        content: JSON.stringify({
          memories: [
            { text: "User prefers dark mode", category: "preference", importance: 0.9 },
            { text: "Using PostgreSQL for the project", category: "decision", importance: 0.8 },
          ],
          memoryMdUpdates: "## Preferences\n- Dark mode\n## Decisions\n- PostgreSQL",
          knowledgeNotes: [
            {
              path: "topics/PostgreSQL.md",
              title: "PostgreSQL",
              content: "# PostgreSQL\nChosen for the project database.",
              tags: ["database", "decision"],
            },
          ],
        }),
        done: true,
      };
    },
    async listModels() { return []; },
    async healthCheck() { return true; },
    contextWindowSize() { return 4096; },
  };
}

describe("Consolidator", () => {
  function makeConsolidator() {
    const fs = inMemoryFileSystem({
      "/workspace/memory/2026-02-13.md": "# 2026-02-13\n- User discussed PostgreSQL\n- Prefers dark mode",
      "/workspace/MEMORY.md": "# Memory\nOld content.",
    });
    const db = inMemoryDatabase();
    const clock = fixedClock(new Date("2026-02-13T23:00:00.000Z"));
    const logger = capturingLogger();
    const llm = mockConsolidationLLM();

    const consolidator = createConsolidator({
      fs,
      db,
      clock,
      logger,
      llm,
      workspacePath: "/workspace",
    });

    return { consolidator, fs, db, logger };
  }

  it("should read the daily log for the given date", async () => {
    const { consolidator } = makeConsolidator();
    await consolidator.consolidate("2026-02-13");
    // If it didn't throw, it read the log successfully
  });

  it("should extract memories and store them in the database", async () => {
    const { consolidator, db } = makeConsolidator();
    await consolidator.consolidate("2026-02-13");

    const inserts = db.executedSql.filter((s) => s.sql.includes("INSERT"));
    expect(inserts.length).toBeGreaterThanOrEqual(1);
  });

  it("should update MEMORY.md with consolidation results", async () => {
    const { consolidator, fs } = makeConsolidator();
    await consolidator.consolidate("2026-02-13");

    const content = await fs.readFile("/workspace/MEMORY.md");
    expect(content).toContain("Preferences");
  });

  it("should create knowledge vault notes", async () => {
    const { consolidator, fs } = makeConsolidator();
    await consolidator.consolidate("2026-02-13");

    const noteExists = await fs.exists("/workspace/knowledge/topics/PostgreSQL.md");
    expect(noteExists).toBe(true);
  });

  it("should not modify the daily log", async () => {
    const { consolidator, fs } = makeConsolidator();
    const before = await fs.readFile("/workspace/memory/2026-02-13.md");

    await consolidator.consolidate("2026-02-13");

    const after = await fs.readFile("/workspace/memory/2026-02-13.md");
    expect(after).toBe(before);
  });

  it("should handle empty daily log gracefully", async () => {
    const fs = inMemoryFileSystem({});
    const consolidator = createConsolidator({
      fs,
      db: inMemoryDatabase(),
      clock: fixedClock(),
      logger: capturingLogger(),
      llm: mockConsolidationLLM(),
      workspacePath: "/workspace",
    });

    // Should not throw
    await consolidator.consolidate("2026-02-13");
  });
});
