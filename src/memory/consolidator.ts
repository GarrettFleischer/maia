/**
 * @fileoverview End-of-day consolidation: daily log → memories + MEMORY.md + knowledge notes.
 * @module memory/consolidator
 * @brief Sends daily log to LLM, parses response, persists memories and knowledge.
 */

import type {
  Clock,
  Database,
  FileSystem,
  LLMProvider,
  Logger,
  MemoryCategory,
} from "../core/types.js";

/** @brief Dependencies for createConsolidator */
export interface ConsolidatorDeps {
  fs: FileSystem;
  db: Database;
  clock: Clock;
  logger: Logger;
  llm: LLMProvider;
  workspacePath: string;
}

/** @brief Parsed consolidation response from LLM */
interface ConsolidationResponse {
  memories: Array<{
    text: string;
    category: MemoryCategory;
    importance: number;
    sourceDate?: string;
  }>;
  memoryMdUpdates: string;
  knowledgeNotes: Array<{ path: string; content: string }>;
}

/** @brief Consolidator interface */
export interface Consolidator {
  consolidate(date: string): Promise<void>;
}

const CONSOLIDATION_PROMPT = `You are a memory consolidation assistant. Given a daily log, extract:
1. **memories**: Array of { text, category, importance, sourceDate? } where category is one of: preference, fact, decision, entity, other. importance 0-1.
2. **memoryMdUpdates**: Markdown text to append to MEMORY.md (curated long-term notes).
3. **knowledgeNotes**: Array of { path, content } for new/updated knowledge files (e.g. people/John.md, topics/ProjectX.md).

Respond with valid JSON only, no markdown fences:
{ "memories": [...], "memoryMdUpdates": "...", "knowledgeNotes": [...] }`;

/**
 * @brief Creates a consolidator instance.
 * @param deps - Dependencies: fs, db, clock, logger, llm, workspacePath
 * @returns Consolidator interface
 */
export function createConsolidator(deps: ConsolidatorDeps): Consolidator {
  const { fs, db, logger, llm, workspacePath } = deps;
  const memoryDir = `${workspacePath}/memory`;
  const memoryPath = `${workspacePath}/MEMORY.md`;
  const knowledgePath = `${workspacePath}/knowledge`;

  return {
    async consolidate(date: string): Promise<void> {
      const logPath = `${memoryDir}/${date}.md`;
      const exists = await fs.exists(logPath);
      if (!exists) {
        logger.debug("Consolidation skipped: daily log missing", { date });
        return;
      }

      const content = await fs.readFile(logPath);
      const trimmed = content.trim();
      if (!trimmed) {
        logger.debug("Consolidation skipped: daily log empty", { date });
        return;
      }

      logger.info("Consolidating daily log", { date });

      const messages = [
        { role: "system" as const, content: CONSOLIDATION_PROMPT },
        { role: "user" as const, content: trimmed },
      ];

      let fullResponse = "";
      const stream = llm.chat(messages);
      for await (const chunk of stream) {
        if (chunk.content) fullResponse += chunk.content;
      }

      let parsed: ConsolidationResponse;
      try {
        const jsonStr = fullResponse.replace(/^```json\s*/i, "").replace(/\s*```$/i, "").trim();
        parsed = JSON.parse(jsonStr) as ConsolidationResponse;
      } catch (err) {
        logger.error("Consolidation failed: invalid LLM response", {
          date,
          error: err instanceof Error ? err.message : String(err),
        });
        return;
      }

      if (!parsed.memories) parsed.memories = [];
      if (!parsed.memoryMdUpdates) parsed.memoryMdUpdates = "";
      if (!parsed.knowledgeNotes) parsed.knowledgeNotes = [];

      for (const mem of parsed.memories) {
        await db.execute(
          `INSERT INTO memories (id, text, category, importance, source_date, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            crypto.randomUUID(),
            mem.text,
            mem.category,
            mem.importance,
            mem.sourceDate ?? date,
            new Date().toISOString(),
            new Date().toISOString(),
          ]
        );
      }

      if (parsed.memoryMdUpdates) {
        const existing = await fs.exists(memoryPath) ? await fs.readFile(memoryPath) : "";
        const updated = existing ? `${existing}\n${parsed.memoryMdUpdates}` : parsed.memoryMdUpdates;
        const lastSep = Math.max(memoryPath.lastIndexOf("/"), memoryPath.lastIndexOf("\\"));
        if (lastSep > 0) {
          const dir = memoryPath.slice(0, lastSep);
          try {
            await fs.mkdir(dir);
          } catch {
            /* directory may already exist */
          }
        }
        await fs.writeFile(memoryPath, updated);
      }

      for (const note of parsed.knowledgeNotes) {
        const notePath = `${knowledgePath}/${note.path}`;
        const lastSep = Math.max(notePath.lastIndexOf("/"), notePath.lastIndexOf("\\"));
        if (lastSep > 0) {
          const dir = notePath.slice(0, lastSep);
          try {
            await fs.mkdir(dir);
          } catch {
            /* directory may already exist */
          }
        }
        await fs.writeFile(notePath, note.content);
      }

      logger.info("Consolidation complete", {
        date,
        memoriesCount: parsed.memories.length,
        knowledgeNotesCount: parsed.knowledgeNotes.length,
      });
    },
  };
}
