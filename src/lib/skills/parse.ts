/**
 * @fileoverview Parse skill markdown: YAML frontmatter (name, description) and body.
 * @module lib/skills/parse
 */

export interface ParsedSkill {
  name: string;
  description: string;
  body: string;
}

/**
 * Parse frontmatter from a skill markdown string.
 * Expects first line ---, then YAML-like lines with name: and description:, then ---, then body.
 * @param content - Full file content
 * @returns Parsed name, description, and body, or null if invalid/missing frontmatter
 */
export function parseSkillFrontmatter(content: string): ParsedSkill | null {
  const trimmed = content.trim();
  if (!trimmed.startsWith("---")) return null;
  const afterFirst = trimmed.slice(3).trimStart();
  const endIdx = afterFirst.indexOf("\n---");
  if (endIdx === -1) return null;
  const frontBlock = afterFirst.slice(0, endIdx);
  const body = afterFirst.slice(endIdx + 4).trimStart();

  let name: string | undefined;
  let description: string | undefined;
  for (const line of frontBlock.split("\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (key === "name") name = value;
    else if (key === "description") description = value;
  }
  if (name === undefined || description === undefined) return null;
  return { name, description, body };
}

/**
 * Serialize name, description, and body to skill markdown (frontmatter + body).
 * @param name - Skill name
 * @param description - Skill description
 * @param body - Markdown body
 * @returns Full file content
 */
export function skillToMarkdown(name: string, description: string, body: string): string {
  const front = `---
name: ${name}
description: ${description}
---

`;
  return front + (body.trimStart() ? body : "\n");
}
