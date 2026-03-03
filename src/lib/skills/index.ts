/**
 * @fileoverview Skills module: load and match markdown skills to user messages (semantic),
 * and assemble content for the system prompt.
 * @module lib/skills
 */

export type { SkillMetadata, Skill } from "./types";
export { parseSkillFrontmatter } from "./parse";
export type { ParsedSkill } from "./parse";
export {
  listSkillFiles,
  loadSkillMetadata,
  loadSkillContent,
  getAvailableSkillsMetadata,
} from "./discovery";
export {
  matchSkillsToMessage,
  getMatchedSkillsContent,
} from "./match";
export type { MatchSkillsOptions, GetMatchedSkillsResult } from "./match";
