/**
 * @fileoverview Parses optional structured blocks (REMEMBER, SECURITY, PROGRESS) from LLM responses.
 * @module agent/response-blocks
 *
 * @brief Single pass over raw response to extract display content and optional blocks
 * so the runtime can strip blocks, apply remember, and act on security/progress.
 */

import { REMEMBER_DELIMITER } from "../memory/remember-block.js";

/** @brief Delimiter for security block in LLM output. */
export const SECURITY_DELIMITER = "---SECURITY---";

/** @brief Delimiter for progress block in LLM output. */
export const PROGRESS_DELIMITER = "---PROGRESS---";

const BLOCK_DELIMITERS = [
  REMEMBER_DELIMITER,
  SECURITY_DELIMITER,
  PROGRESS_DELIMITER,
] as const;

/**
 * @brief Parsed security block (when LLM reports a concern).
 */
export interface SecurityBlock {
  flagged: boolean;
  reason?: string;
  snippet?: string;
}

/**
 * @brief Parsed progress block (when agent self-reports status).
 */
export interface ProgressBlock {
  status: string;
  summary: string;
}

/**
 * @brief Result of parsing the raw LLM response.
 */
export interface ParsedResponseBlocks {
  /** Reply text only (before any block delimiter). */
  displayContent: string;
  /** Raw string after ---REMEMBER--- up to next delimiter or end (for parseRemember). */
  rememberBlockRaw?: string;
  /** Parsed security block if present. */
  security?: SecurityBlock;
  /** Parsed progress block if present. */
  progress?: ProgressBlock;
}

/**
 * @brief Extracts JSON from a block body (strips ```json fences and trims).
 */
function extractJson(str: string): string {
  return str
    .replace(/^```json\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

/**
 * @brief Finds the earliest occurrence of any block delimiter in the string.
 * @returns [index, whichDelimiter] or [Infinity, null] if none
 */
function findFirstDelimiter(raw: string): [number, (typeof BLOCK_DELIMITERS)[number] | null] {
  let minIdx = Infinity;
  let which: (typeof BLOCK_DELIMITERS)[number] | null = null;
  for (const d of BLOCK_DELIMITERS) {
    const idx = raw.indexOf(d);
    if (idx >= 0 && idx < minIdx) {
      minIdx = idx;
      which = d;
    }
  }
  return [minIdx, which];
}

/**
 * @brief Parses the raw LLM response into display content and optional blocks.
 * Display content is everything before the first occurrence of ---REMEMBER---,
 * ---SECURITY---, or ---PROGRESS---. Blocks are then extracted from the remainder.
 *
 * @param rawContent - Full LLM response that may contain structured blocks
 * @returns Parsed display content and optional remember/security/progress blocks
 *
 * @example
 * const parsed = parseResponseBlocks(llmResponse);
 * // parsed.displayContent = reply text only
 * // if parsed.security?.flagged, act on it; if parsed.progress, send DM
 * // pass (displayContent + REMEMBER_DELIMITER + parsed.rememberBlockRaw) to parseRemember
 */
export function parseResponseBlocks(rawContent: string): ParsedResponseBlocks {
  const raw = rawContent;
  const [firstIdx, _firstDelim] = findFirstDelimiter(raw);

  const displayContent =
    firstIdx < raw.length ? raw.slice(0, firstIdx).trim() : raw.trim();

  const rest = firstIdx < raw.length ? raw.slice(firstIdx) : "";
  if (!rest) {
    return { displayContent };
  }

  const result: ParsedResponseBlocks = { displayContent };

  /** Splits rest into segments: delimiter + content until next delimiter. */
  const segments: Array<{ delim: string; content: string }> = [];
  let pos = 0;
  while (pos < rest.length) {
    let found: string | null = null;
    for (const d of BLOCK_DELIMITERS) {
      if (rest.startsWith(d, pos)) {
        found = d;
        break;
      }
    }
    if (!found) break;
    const contentStart = pos + found.length;
    let contentEnd = rest.length;
    for (const d of BLOCK_DELIMITERS) {
      const i = rest.indexOf(d, contentStart);
      if (i >= contentStart && i < contentEnd) contentEnd = i;
    }
    const content = rest.slice(contentStart, contentEnd).trim();
    segments.push({ delim: found, content });
    pos = contentEnd;
  }

  for (const { delim, content } of segments) {
    if (delim === REMEMBER_DELIMITER) {
      result.rememberBlockRaw = content;
      continue;
    }
    if (delim === SECURITY_DELIMITER && content) {
      try {
        const obj = JSON.parse(extractJson(content)) as Record<string, unknown>;
        result.security = {
          flagged: !!obj.flagged,
          reason: typeof obj.reason === "string" ? obj.reason : undefined,
          snippet: typeof obj.snippet === "string" ? obj.snippet : undefined,
        };
      } catch {
        result.security = { flagged: false };
      }
      continue;
    }
    if (delim === PROGRESS_DELIMITER && content) {
      try {
        const obj = JSON.parse(extractJson(content)) as Record<string, unknown>;
        result.progress = {
          status: typeof obj.status === "string" ? obj.status : "",
          summary: typeof obj.summary === "string" ? obj.summary : "",
        };
      } catch {
        // ignore invalid progress block
      }
    }
  }

  return result;
}
