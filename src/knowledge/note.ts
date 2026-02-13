/**
 * @fileoverview Note model for Obsidian-style knowledge notes.
 * @module knowledge/note
 *
 * @note Provides helpers for creating, parsing, and serializing notes
 * with YAML frontmatter, wikilinks, and markdown content.
 */

import type { KnowledgeNote } from "../core/types.js";

/**
 * @brief Creates a new KnowledgeNote with sensible defaults.
 * @param params - Partial note data; path and title are required
 * @returns A fully populated KnowledgeNote
 *
 * @example
 * const note = createNote({
 *   path: "people/alice.md",
 *   title: "Alice",
 *   content: "Alice is a friend. See [[Bob]].",
 *   tags: ["person"],
 *   category: "people",
 * });
 */
export function createNote(params: {
  path: string;
  title: string;
  content?: string;
  tags?: string[];
  category?: string;
}): KnowledgeNote {
  const now = new Date().toISOString().slice(0, 10);
  const content = params.content ?? "";
  const wikilinks = extractWikilinks(content);

  return {
    path: params.path,
    title: params.title,
    content,
    frontmatter: {
      tags: params.tags ?? [],
      created: now,
      updated: now,
      category: params.category,
    },
    wikilinks,
  };
}

/**
 * @brief Extracts unique [[wikilinks]] from markdown content.
 * @param content - Markdown string to parse
 * @returns Array of unique wikilink target names
 *
 * @example
 * extractWikilinks("See [[Alice]] and [[Bob|Robert]]");
 * // => ["Alice", "Bob"]
 */
export function extractWikilinks(content: string): string[] {
  if (!content) return [];
  const matches = content.matchAll(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g);
  const targets = [...matches].map((m) => m[1].trim());
  return [...new Set(targets)];
}

/**
 * @brief Serializes YAML frontmatter to a string block.
 * @param fm - Frontmatter object from a KnowledgeNote
 * @returns YAML frontmatter string including --- delimiters
 *
 * @example
 * serializeFrontmatter({ tags: ["person"], created: "2026-02-13", updated: "2026-02-13" });
 * // => "---\ntags: [\"person\"]\ncreated: 2026-02-13\nupdated: 2026-02-13\n---"
 */
export function serializeFrontmatter(fm: KnowledgeNote["frontmatter"]): string {
  const lines: string[] = ["---"];
  lines.push(`tags: [${fm.tags.map((t) => `"${t}"`).join(", ")}]`);
  lines.push(`created: ${fm.created}`);
  lines.push(`updated: ${fm.updated}`);
  if (fm.category) {
    lines.push(`category: "${fm.category}"`);
  }
  lines.push("---");
  return lines.join("\n");
}

/**
 * @brief Parses simple YAML frontmatter from a markdown file.
 * @param raw - Raw file content
 * @returns Object with frontmatter record and body content
 *
 * @note This uses regex-based parsing; not a full YAML parser.
 * Supports simple key: value pairs and [array] values.
 */
export function parseFrontmatter(raw: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, body: raw };
  }

  const [, yamlStr, body] = match;
  const frontmatter: Record<string, unknown> = {};

  if (yamlStr) {
    for (const line of yamlStr.split(/\r?\n/)) {
      const colonIdx = line.indexOf(":");
      if (colonIdx === -1) continue;
      const key = line.slice(0, colonIdx).trim();
      let value: unknown = line.slice(colonIdx + 1).trim();
      if (typeof value === "string" && value.startsWith("[") && value.endsWith("]")) {
        value = value
          .slice(1, -1)
          .split(",")
          .map((s) => s.trim().replace(/^["']|["']$/g, ""));
      }
      frontmatter[key] = value;
    }
  }

  return { frontmatter, body: body ?? "" };
}

/**
 * @brief Converts a KnowledgeNote to its full markdown file content.
 * @param note - The KnowledgeNote to serialize
 * @returns Complete file content with frontmatter and body
 */
export function serializeNote(note: KnowledgeNote): string {
  const fm = serializeFrontmatter(note.frontmatter);
  const body = note.content.includes(`# ${note.title}`)
    ? note.content
    : `# ${note.title}\n\n${note.content}`;
  return `${fm}\n\n${body}\n`;
}
