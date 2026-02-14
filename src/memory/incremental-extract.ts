/**
 * @fileoverview Per-message incremental memory extraction. After each chat
 * exchange, sends the user+assistant pair to the LLM along with current
 * workspace files (MEMORY.md, USER.md, SOUL.md) and applies any updates.
 * @module memory/incremental-extract
 *
 * @note This replaces the need for batch consolidation for real-time updates.
 * The LLM is asked to return structured JSON with updates for each workspace
 * file tier. All file writes are fire-and-forget with error logging.
 */

import type {
  Database,
  FileSystem,
  LLMProvider,
  Logger,
  MemoryCategory,
} from "../core/types.js";
import type { ContextBuilder } from "../agent/context.js";

/**
 * @brief Dependencies for createIncrementalExtract.
 */
export interface IncrementalExtractDeps {
  fs: FileSystem;
  db: Database;
  logger: Logger;
  llm: LLMProvider;
  workspacePath: string;
  contextBuilder: ContextBuilder;
}

/**
 * @brief Parsed extraction response from LLM.
 * @note Exported for use by periodic-merge when applying batch extraction.
 */
export interface ExtractionResponse {
  memories: Array<{
    text: string;
    category: MemoryCategory;
    importance: number;
  }>;
  memoryMdUpdates: string;
  userMdUpdates: string;
  soulMdUpdates: string;
  knowledgeNotes: Array<{ path: string; content: string }>;
}

/** @brief Deps for applyExtractionResponse (fs, db, workspacePath, logger). */
export interface ApplyExtractionDeps {
  fs: FileSystem;
  db: Database;
  logger: Logger;
  workspacePath: string;
}

/**
 * @brief IncrementalExtract interface.
 */
export interface IncrementalExtract {
  /**
   * @brief Extracts and persists memory/knowledge from a single exchange.
   * @param userContent - The user's message
   * @param responseContent - The assistant's response
   */
  extract(userContent: string, responseContent: string): Promise<void>;
}

/**
 * @brief The extraction prompt sent to the LLM.
 * @note Instructs the model to return only valid JSON. Each field is optional
 * (empty string or empty array when nothing to update).
 */
const EXTRACTION_PROMPT = `You are a memory extraction assistant. You are given a single chat exchange between a user and an AI assistant, along with the current contents of three workspace files. Your job is to decide what (if anything) should be persisted.

Return ONLY valid JSON (no markdown fences, no commentary) with these fields:

1. **memories**: Array of { "text": string, "category": "preference"|"fact"|"decision"|"entity"|"other", "importance": 0.0-1.0 }
   Only include genuinely important information worth remembering long-term. Empty array if nothing notable.

2. **memoryMdUpdates**: Markdown text to APPEND to MEMORY.md. Only add genuinely new curated notes (not duplicates of what already exists). Empty string if nothing to add.

3. **userMdUpdates**: Markdown text to APPEND to USER.md. Include new facts about the user: preferences, context, projects, relationships. Empty string if nothing new.

4. **soulMdUpdates**: Markdown text to APPEND to SOUL.md. Only update if the conversation reveals something about how the AI should evolve its persona or values. Almost always empty string.

5. **knowledgeNotes**: Array of { "path": string, "content": string } for knowledge vault files (e.g. "people/Alice.md", "topics/TypeScript.md"). Empty array if nothing to add.

Be conservative: only extract what is clearly worth remembering. Do not repeat information already present in the workspace files. Most exchanges will produce empty or minimal updates.`;

/**
 * @brief Applies a parsed extraction response to the workspace and DB.
 * @param parsed - Parsed ExtractionResponse from LLM
 * @param deps - fs, db, workspacePath, logger
 * @returns Promise that resolves when all writes are done
 *
 * @note Used by both incremental extract and periodic-merge. Ensures defaults
 * for missing fields before applying.
 */
export async function applyExtractionResponse(
  parsed: ExtractionResponse,
  deps: ApplyExtractionDeps
): Promise<void> {
  const { fs, db, logger, workspacePath } = deps;
  const memoryPath = `${workspacePath}/MEMORY.md`;
  const userPath = `${workspacePath}/USER.md`;
  const soulPath = `${workspacePath}/SOUL.md`;
  const knowledgePath = `${workspacePath}/knowledge`;

  if (!parsed.memories) parsed.memories = [];
  if (!parsed.memoryMdUpdates) parsed.memoryMdUpdates = "";
  if (!parsed.userMdUpdates) parsed.userMdUpdates = "";
  if (!parsed.soulMdUpdates) parsed.soulMdUpdates = "";
  if (!parsed.knowledgeNotes) parsed.knowledgeNotes = [];

  async function readFileSafe(filePath: string): Promise<string> {
    try {
      const exists = await fs.exists(filePath);
      if (!exists) return "";
      return await fs.readFile(filePath);
    } catch {
      return "";
    }
  }

  async function appendToFile(filePath: string, content: string): Promise<void> {
    const lastSep = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
    if (lastSep > 0) {
      const dir = filePath.slice(0, lastSep);
      try {
        await fs.mkdir(dir);
      } catch {
        /* directory may already exist */
      }
    }
    const existing = await readFileSafe(filePath);
    const updated = existing ? `${existing}\n${content}` : content;
    await fs.writeFile(filePath, updated);
  }

  for (const mem of parsed.memories) {
    try {
      await db.execute(
        `INSERT INTO memories (id, text, category, importance, source_date, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          crypto.randomUUID(),
          mem.text,
          mem.category,
          mem.importance,
          new Date().toISOString().split("T")[0],
          new Date().toISOString(),
          new Date().toISOString(),
        ]
      );
    } catch (dbErr) {
      logger.warn("Incremental extract: failed to insert memory", {
        error: dbErr instanceof Error ? dbErr.message : String(dbErr),
      });
    }
  }

  if (parsed.memoryMdUpdates.trim()) await appendToFile(memoryPath, parsed.memoryMdUpdates);
  if (parsed.userMdUpdates.trim()) await appendToFile(userPath, parsed.userMdUpdates);
  if (parsed.soulMdUpdates.trim()) await appendToFile(soulPath, parsed.soulMdUpdates);

  for (const note of parsed.knowledgeNotes) {
    try {
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
    } catch (noteErr) {
      logger.warn("Incremental extract: failed to write knowledge note", {
        path: note.path,
        error: noteErr instanceof Error ? noteErr.message : String(noteErr),
      });
    }
  }

  const totalUpdates =
    parsed.memories.length +
    (parsed.memoryMdUpdates.trim() ? 1 : 0) +
    (parsed.userMdUpdates.trim() ? 1 : 0) +
    (parsed.soulMdUpdates.trim() ? 1 : 0) +
    parsed.knowledgeNotes.length;

  if (totalUpdates > 0) {
    logger.info("Incremental extract complete", {
      memories: parsed.memories.length,
      memoryMd: parsed.memoryMdUpdates.trim() ? "updated" : "none",
      userMd: parsed.userMdUpdates.trim() ? "updated" : "none",
      soulMd: parsed.soulMdUpdates.trim() ? "updated" : "none",
      knowledgeNotes: parsed.knowledgeNotes.length,
    });
  }
}

/**
 * @brief Creates an incremental extract instance.
 * @param deps - Dependencies: fs, db, logger, llm, workspacePath, contextBuilder
 * @returns IncrementalExtract interface
 *
 * @example
 * const extractor = createIncrementalExtract({ fs, db, logger, llm, workspacePath, contextBuilder });
 * await extractor.extract("What's your favorite color?", "I don't have preferences, but I can help you pick one!");
 */
export function createIncrementalExtract(deps: IncrementalExtractDeps): IncrementalExtract {
  const { fs, db, logger, llm, workspacePath, contextBuilder } = deps;

  return {
    async extract(userContent: string, responseContent: string): Promise<void> {
      try {
        // Load current workspace files for context
        const [currentMemory, currentUser, currentSoul] = await Promise.all([
          contextBuilder.loadWorkspaceFile("MEMORY.md"),
          contextBuilder.loadWorkspaceFile("USER.md"),
          contextBuilder.loadWorkspaceFile("SOUL.md"),
        ]);

        // Build the user message with the exchange and current file contents
        const userMessage = `## Current Workspace Files

### MEMORY.md
${currentMemory || "(empty)"}

### USER.md
${currentUser || "(empty)"}

### SOUL.md
${currentSoul || "(empty)"}

## Chat Exchange

**User**: ${userContent}

**Assistant**: ${responseContent}`;

        const messages = [
          { role: "system" as const, content: EXTRACTION_PROMPT },
          { role: "user" as const, content: userMessage },
        ];

        // Call LLM for extraction
        let fullResponse = "";
        const stream = llm.chat(messages);
        for await (const chunk of stream) {
          if (chunk.content) fullResponse += chunk.content;
        }

        // Parse response
        let parsed: ExtractionResponse;
        try {
          const jsonStr = fullResponse
            .replace(/^```json\s*/i, "")
            .replace(/\s*```$/i, "")
            .trim();
          parsed = JSON.parse(jsonStr) as ExtractionResponse;
        } catch (parseErr) {
          logger.warn("Incremental extract: failed to parse LLM response", {
            error: parseErr instanceof Error ? parseErr.message : String(parseErr),
            response: fullResponse.slice(0, 200),
          });
          return;
        }

        await applyExtractionResponse(parsed, { fs, db, workspacePath, logger });
      } catch (err) {
        logger.warn("Incremental extract failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };
}
