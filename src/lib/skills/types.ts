/**
 * @fileoverview Types for skills: metadata and full skill with content.
 * @module lib/skills/types
 */

/**
 * Scope of a skill: global (all agents) or agent (only that agent).
 * Used to filter skills before passing options to the LLM so only global + current agent's local skills are offered.
 */
export type SkillScope = "global" | "agent";

/** Base metadata (name, description, path) returned by loadSkillMetadata before scope is assigned. */
export interface SkillMetadataBase {
  name: string;
  description: string;
  sourcePath: string;
}

/** Metadata for a skill (name, description, path, scope); used for matching without loading body. */
export interface SkillMetadata extends SkillMetadataBase {
  /** Whether the skill is global or per-agent. */
  scope: SkillScope;
  /** Set when scope is 'agent': the agent id that owns this skill. */
  agentId?: string;
}

/** Full skill with body content (for injection into system prompt). */
export interface Skill extends SkillMetadata {
  content: string;
}
