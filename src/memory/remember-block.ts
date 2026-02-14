/**
 * @fileoverview Parses optional "remember" blocks from LLM responses and appends
 * content to MEMORY.md, USER.md, or SOUL.md. Used so every chat can optionally
 * persist something the user said without a separate extraction call.
 * @module memory/remember-block
 *
 * @note The LLM is instructed to append ---REMEMBER--- and JSON to its response
 * only when something is genuinely worth remembering. The chat interface can
 * show "Maia will remember that" when this block was present and applied.
 */

import type { FileSystem, Logger } from "../core/types.js";

/** @brief Delimiter between reply text and the remember JSON in LLM output. */
export const REMEMBER_DELIMITER = "---REMEMBER---";

/**
 * @brief Parsed remember block (optional fields; only non-empty are applied).
 */
export interface RememberBlock {
  /** Markdown to append to MEMORY.md */
  memoryMd?: string;
  /** Markdown to append to USER.md */
  userMd?: string;
  /** Markdown to append to SOUL.md */
  soulMd?: string;
}

/**
 * @brief Content that was appended to each workspace file (for hover/tooltip in UI).
 */
export interface RememberedContent {
  memoryMd?: string;
  userMd?: string;
  soulMd?: string;
}

/**
 * @brief Result of parsing and applying a remember block.
 */
export interface ParseRememberResult {
  /** Reply text only (without the remember block). */
  displayContent: string;
  /** True if a remember block was present and at least one field was applied. */
  remembered: boolean;
  /** When remembered is true, the content that was appended to each file (for UI tooltip). */
  rememberedContent?: RememberedContent;
}

/**
 * @brief Dependencies for createRememberBlockHandler.
 */
export interface RememberBlockDeps {
  fs: FileSystem;
  logger: Logger;
  workspacePath: string;
}

/**
 * @brief Handler that parses a response for ---REMEMBER--- and applies appends.
 */
export interface RememberBlockHandler {
  /**
   * @brief Parses the raw LLM response, applies any remember block to workspace files, returns clean content.
   * @param rawContent - Full LLM response that may end with ---REMEMBER--- and JSON
   * @returns Display content (reply only) and whether something was remembered
   */
  parseAndApply(rawContent: string): Promise<ParseRememberResult>;
}

/**
 * @brief Safely appends content to a workspace file, creating parent dir if needed.
 */
async function appendToFile(
  fs: FileSystem,
  filePath: string,
  content: string,
  logger: Logger
): Promise<void> {
  if (!content.trim()) return;
  const lastSep = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  if (lastSep > 0) {
    const dir = filePath.slice(0, lastSep);
    try {
      await fs.mkdir(dir);
    } catch {
      /* directory may already exist */
    }
  }
  let existing = "";
  try {
    if (await fs.exists(filePath)) {
      existing = await fs.readFile(filePath);
    }
  } catch {
    /* ignore read errors */
  }
  const updated = existing ? `${existing}\n${content.trim()}` : content.trim();
  await fs.writeFile(filePath, updated);
  logger.debug("Remember block: appended to file", { file: filePath.split(/[/\\]/).pop() });
}

/**
 * @brief Applies previously parsed remembered content to a workspace (e.g. the other agent in agent-agent "both remember").
 * @param fs - File system
 * @param workspacePath - Workspace root (MEMORY.md, USER.md, SOUL.md live here)
 * @param rememberedContent - Content to append (memoryMd, userMd, soulMd)
 * @param logger - Logger
 *
 * @example
 * await applyRememberedContent(fs, otherAgentWorkspacePath, response.rememberedContent!, logger);
 */
export async function applyRememberedContent(
  fs: RememberBlockDeps["fs"],
  workspacePath: string,
  rememberedContent: RememberedContent,
  logger: RememberBlockDeps["logger"]
): Promise<void> {
  const memoryPath = `${workspacePath}/MEMORY.md`;
  const userPath = `${workspacePath}/USER.md`;
  const soulPath = `${workspacePath}/SOUL.md`;
  if (rememberedContent.memoryMd?.trim()) {
    await appendToFile(fs, memoryPath, rememberedContent.memoryMd.trim(), logger);
  }
  if (rememberedContent.userMd?.trim()) {
    await appendToFile(fs, userPath, rememberedContent.userMd.trim(), logger);
  }
  if (rememberedContent.soulMd?.trim()) {
    await appendToFile(fs, soulPath, rememberedContent.soulMd.trim(), logger);
  }
}

/**
 * @brief Creates a remember-block handler that parses LLM output and appends to workspace files.
 * @param deps - fs, logger, workspacePath
 * @returns RememberBlockHandler
 *
 * @example
 * const handler = createRememberBlockHandler({ fs, logger, workspacePath });
 * const { displayContent, remembered } = await handler.parseAndApply(llmResponse);
 * // Send displayContent to user; if remembered, show "Maia will remember that"
 */
export function createRememberBlockHandler(deps: RememberBlockDeps): RememberBlockHandler {
  const { fs, logger, workspacePath } = deps;
  const memoryPath = `${workspacePath}/MEMORY.md`;
  const userPath = `${workspacePath}/USER.md`;
  const soulPath = `${workspacePath}/SOUL.md`;

  return {
    async parseAndApply(rawContent: string): Promise<ParseRememberResult> {
      const delimiterIndex = rawContent.indexOf(REMEMBER_DELIMITER);
      const displayContent =
        delimiterIndex >= 0
          ? rawContent.slice(0, delimiterIndex).trim()
          : rawContent.trim();
      if (delimiterIndex < 0) {
        return { displayContent, remembered: false };
      }

      const jsonStr = rawContent
        .slice(delimiterIndex + REMEMBER_DELIMITER.length)
        .replace(/^```json\s*/i, "")
        .replace(/\s*```$/i, "")
        .trim();

      if (!jsonStr) {
        return { displayContent, remembered: false };
      }

      let block: RememberBlock;
      try {
        block = JSON.parse(jsonStr) as RememberBlock;
      } catch (err) {
        logger.warn("Remember block: invalid JSON", {
          error: err instanceof Error ? err.message : String(err),
          snippet: jsonStr.slice(0, 100),
        });
        return { displayContent, remembered: false };
      }

      const rememberedContent: RememberedContent = {};
      try {
        if (block.memoryMd?.trim()) {
          const trimmed = block.memoryMd.trim();
          await appendToFile(fs, memoryPath, trimmed, logger);
          rememberedContent.memoryMd = trimmed;
        }
        if (block.userMd?.trim()) {
          const trimmed = block.userMd.trim();
          await appendToFile(fs, userPath, trimmed, logger);
          rememberedContent.userMd = trimmed;
        }
        if (block.soulMd?.trim()) {
          const trimmed = block.soulMd.trim();
          await appendToFile(fs, soulPath, trimmed, logger);
          rememberedContent.soulMd = trimmed;
        }
      } catch (err) {
        logger.warn("Remember block: failed to append", {
          error: err instanceof Error ? err.message : String(err),
        });
        return { displayContent, remembered: false };
      }

      const applied =
        !!rememberedContent.memoryMd ||
        !!rememberedContent.userMd ||
        !!rememberedContent.soulMd;
      return {
        displayContent,
        remembered: applied,
        rememberedContent: applied ? rememberedContent : undefined,
      };
    },
  };
}
