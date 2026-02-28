/**
 * @fileoverview Types for skills: metadata and full skill with content.
 * @module lib/skills/types
 */

/** Metadata for a skill (name, description, path); used for matching without loading body. */
export interface SkillMetadata {
  name: string;
  description: string;
  sourcePath: string;
}

/** Full skill with body content (for injection into system prompt). */
export interface Skill extends SkillMetadata {
  content: string;
}
