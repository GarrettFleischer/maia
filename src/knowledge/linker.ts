/**
 * @fileoverview Wikilink parser for extracting [[target]] and [[Target|Alias]] patterns.
 * @module knowledge/linker
 * @brief Returns unique wikilink targets from markdown content.
 */

/** @brief Wikilink parser interface */
export interface WikilinkParser {
  /** Extract unique wikilinks from content ([[Target]] or [[Target|Alias]]) */
  extract(content: string): string[];
}

/**
 * @brief Creates a wikilink parser instance.
 * @returns WikilinkParser interface
 */
export function createWikilinkParser(): WikilinkParser {
  return {
    extract(content: string): string[] {
      if (!content || content.length === 0) return [];

      const matches = content.matchAll(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g);
      const targets = [...matches].map((m) => m[1].trim());
      return [...new Set(targets)];
    },
  };
}
