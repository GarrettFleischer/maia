/**
 * @fileoverview Discover and load skills from global and per-agent directories.
 * @module lib/skills/discovery
 */

import path from "path";
import type { FileSystemAdapter } from "../context";
import type { SkillMetadata, SkillMetadataBase, Skill } from "./types";
import { parseSkillFrontmatter } from "./parse";
import { getSkillsDir, getAgentSkillsDir } from "../data-dir";
import type { AppContext } from "../context";

/**
 * List .md files in a directory (flat, non-recursive).
 * @param fs - File system adapter
 * @param dir - Absolute path to directory
 * @returns Array of filenames ending in .md
 */
export function listSkillFiles(fs: FileSystemAdapter, dir: string): string[] {
  try {
    const entries = fs.listDir(dir);
    return entries.filter((e) => typeof e === "string" && e.endsWith(".md"));
  } catch {
    return [];
  }
}

/**
 * Load skill metadata (name, description, sourcePath) from a file; no body or scope.
 * @param fs - File system adapter
 * @param filePath - Absolute path to the skill file
 * @returns SkillMetadataBase or null if file missing or invalid frontmatter
 */
export function loadSkillMetadata(
  fs: FileSystemAdapter,
  filePath: string,
): SkillMetadataBase | null {
  try {
    const raw = fs.readFile(filePath);
    const parsed = parseSkillFrontmatter(raw);
    if (!parsed) return null;
    return {
      name: parsed.name,
      description: parsed.description,
      sourcePath: filePath,
    };
  } catch {
    return null;
  }
}

/**
 * Load full skill (metadata + body content for injection).
 * Caller must ensure scope/agentId are not required for the use case; content loading does not set scope.
 * @param fs - File system adapter
 * @param filePath - Absolute path to the skill file
 * @returns Skill with content (body only) or null; Skill extends SkillMetadata but loadSkillContent does not set scope (use for loading body only)
 */
export function loadSkillContent(
  fs: FileSystemAdapter,
  filePath: string,
): (SkillMetadataBase & { content: string }) | null {
  try {
    const raw = fs.readFile(filePath);
    const parsed = parseSkillFrontmatter(raw);
    if (!parsed) return null;
    return {
      name: parsed.name,
      description: parsed.description,
      sourcePath: filePath,
      content: parsed.body,
    };
  } catch {
    return null;
  }
}

/**
 * Load skill metadata and assign scope/agentId. Used internally by getAvailableSkillsMetadata.
 * @param fs - File system adapter
 * @param filePath - Absolute path to the skill file
 * @param scope - 'global' or 'agent'
 * @param agentId - When scope is 'agent', the owning agent id
 * @returns SkillMetadata with scope (and agentId when scope is 'agent') or null
 */
function loadSkillMetadataWithScope(
  fs: FileSystemAdapter,
  filePath: string,
  scope: "global" | "agent",
  agentId?: string,
): SkillMetadata | null {
  const meta = loadSkillMetadata(fs, filePath);
  if (!meta) return null;
  return {
    ...meta,
    scope,
    ...(scope === "agent" && agentId !== undefined ? { agentId } : {}),
  };
}

/**
 * Get all available skill metadata for an agent (global + per-agent).
 * Does not throw when directories are missing; returns [].
 * Each skill has scope 'global' or 'agent' and optional agentId for filtering.
 * @param ctx - App context (fs)
 * @param agentId - Agent identifier for per-agent skills dir
 * @returns Combined list of skill metadata (agent skills first, then global)
 */
export function getAvailableSkillsMetadata(
  ctx: AppContext,
  agentId: string,
): SkillMetadata[] {
  const result: SkillMetadata[] = [];
  const globalDir = getSkillsDir();
  const agentDir = getAgentSkillsDir(agentId);

  if (ctx.fs.exists(agentDir)) {
    const agentFiles = listSkillFiles(ctx.fs, agentDir);
    for (const f of agentFiles) {
      const full = path.join(agentDir, f);
      const meta = loadSkillMetadataWithScope(ctx.fs, full, "agent", agentId);
      if (meta) result.push(meta);
    }
  }

  if (ctx.fs.exists(globalDir)) {
    const globalFiles = listSkillFiles(ctx.fs, globalDir);
    for (const f of globalFiles) {
      const full = path.join(globalDir, f);
      const meta = loadSkillMetadataWithScope(ctx.fs, full, "global");
      if (meta) result.push(meta);
    }
  }

  return result;
}
