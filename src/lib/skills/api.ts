/**
 * @fileoverview Helpers for skills API: list by scope, resolve id to path, validate filename.
 * @module lib/skills/api
 */

import path from "path";
import type { AppContext } from "../context";
import { getSkillsDir, getAgentSkillsDir } from "../data-dir";
import { listSkillFiles, loadSkillMetadata } from "./discovery";

export interface SkillListItem {
  id: string;
  name: string;
  description: string;
  sourcePath: string;
  scope: "global" | "agent";
  agentId?: string;
}

/** Safe filename: alphanumeric, hyphen, underscore; must end with .md or be a slug we append .md to. */
const SAFE_FILENAME = /^[a-zA-Z0-9_-]+$/;

/**
 * List skills for API: scope global returns global skills; scope agent + agentId returns that agent's skills.
 * @param ctx - App context
 * @param scope - "global" or "agent"
 * @param agentId - Required when scope is "agent"
 * @returns List of skills with id (for GET/PUT/DELETE)
 */
export function listSkillsForApi(
  ctx: AppContext,
  scope: "global" | "agent",
  agentId?: string,
): SkillListItem[] {
  const result: SkillListItem[] = [];
  if (scope === "global") {
    const dir = getSkillsDir();
    if (!ctx.fs.exists(dir)) return [];
    const files = listSkillFiles(ctx.fs, dir);
    for (const f of files) {
      const full = path.join(dir, f);
      const meta = loadSkillMetadata(ctx.fs, full);
      if (meta) {
        const id = f.replace(/\.md$/i, "");
        result.push({
          id,
          name: meta.name,
          description: meta.description,
          sourcePath: meta.sourcePath,
          scope: "global",
        });
      }
    }
    return result;
  }
  if (scope === "agent" && agentId) {
    const dir = getAgentSkillsDir(agentId);
    if (!ctx.fs.exists(dir)) return [];
    const files = listSkillFiles(ctx.fs, dir);
    for (const f of files) {
      const full = path.join(dir, f);
      const meta = loadSkillMetadata(ctx.fs, full);
      if (meta) {
        const slug = f.replace(/\.md$/i, "");
        result.push({
          id: `${agentId}/${slug}`,
          name: meta.name,
          description: meta.description,
          sourcePath: meta.sourcePath,
          scope: "agent",
          agentId,
        });
      }
    }
    return result;
  }
  return [];
}

/**
 * Resolve API skill id to absolute file path.
 * id is "slug" for global or "agentId/slug" for agent.
 * @param id - Skill id from list
 * @returns Absolute path to the .md file, or null if invalid
 */
export function resolveSkillIdToPath(id: string): string | null {
  const trimmed = id.trim();
  if (!trimmed) return null;
  if (trimmed.includes("..") || trimmed.includes("\\")) return null;
  const parts = trimmed.split("/");
  if (parts.length === 1) {
    const slug = parts[0];
    if (!SAFE_FILENAME.test(slug)) return null;
    return path.join(getSkillsDir(), `${slug}.md`);
  }
  if (parts.length === 2) {
    const [agentId, slug] = parts;
    if (!SAFE_FILENAME.test(agentId) || !SAFE_FILENAME.test(slug)) return null;
    return path.join(getAgentSkillsDir(agentId), `${slug}.md`);
  }
  return null;
}

/**
 * Validate and normalize filename for creating a new skill (slug only; we add .md).
 * @param filename - User-provided filename (with or without .md)
 * @returns Normalized slug (no .md) or null if invalid
 */
export function normalizeSkillFilename(filename: string): string | null {
  const base = filename.replace(/\.md$/i, "").trim();
  if (!base || !SAFE_FILENAME.test(base)) return null;
  return base;
}
