/**
 * @fileoverview Discover and load skills from global and per-agent directories.
 * @module lib/skills/discovery
 */

import path from "path";
import type { FileSystemAdapter } from "../context";
import type { SkillMetadata, Skill } from "./types";
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
 * Load skill metadata (name, description, sourcePath) from a file; no body.
 * @param fs - File system adapter
 * @param filePath - Absolute path to the skill file
 * @returns SkillMetadata or null if file missing or invalid frontmatter
 */
export function loadSkillMetadata(fs: FileSystemAdapter, filePath: string): SkillMetadata | null {
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
 * @param fs - File system adapter
 * @param filePath - Absolute path to the skill file
 * @returns Skill with content (body only) or null
 */
export function loadSkillContent(fs: FileSystemAdapter, filePath: string): Skill | null {
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
 * Get all available skill metadata for an agent (global + per-agent).
 * Does not throw when directories are missing; returns [].
 * @param ctx - App context (fs)
 * @param agentId - Agent identifier for per-agent skills dir
 * @returns Combined list of skill metadata (agent skills first, then global)
 */
export function getAvailableSkillsMetadata(ctx: AppContext, agentId: string): SkillMetadata[] {
  const result: SkillMetadata[] = [];
  const globalDir = getSkillsDir();
  const agentDir = getAgentSkillsDir(agentId);

  if (ctx.fs.exists(agentDir)) {
    const agentFiles = listSkillFiles(ctx.fs, agentDir);
    for (const f of agentFiles) {
      const full = path.join(agentDir, f);
      const meta = loadSkillMetadata(ctx.fs, full);
      if (meta) result.push(meta);
    }
  }

  if (ctx.fs.exists(globalDir)) {
    const globalFiles = listSkillFiles(ctx.fs, globalDir);
    for (const f of globalFiles) {
      const full = path.join(globalDir, f);
      const meta = loadSkillMetadata(ctx.fs, full);
      if (meta) result.push(meta);
    }
  }

  return result;
}
