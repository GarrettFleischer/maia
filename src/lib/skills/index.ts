/**
 * @fileoverview Skills module: load and match markdown skills to user messages (semantic),
 * and assemble content for the system prompt.
 * @module lib/skills
 */

export type {
  SkillMetadata,
  SkillMetadataBase,
  Skill,
  SkillScope,
} from "./types";
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
  filterSkillsForAgent,
} from "./match";
export type { MatchSkillsOptions, GetMatchedSkillsResult } from "./match";
