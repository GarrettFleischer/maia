// Server initialization — called once on startup
// Seeds Maia agent record into DB if not already present, and copies default identity files when the agent dir is missing

import path from "path";
import type { AppContext } from "./context";
import {
  getAgentsDir,
  getDefaultSkillsDir,
  getDefaultMaiaSkillsDir,
  getSkillsDir,
  getAgentSkillsDir,
} from "./data-dir";
import { copyDefaultAgentFiles } from "./tools/agent-management";
import { listSkillFiles } from "./skills";

/**
 * Seed global skills from defaults/skills into the root skills directory.
 * Copies only when the skills directory has no .md files yet; existing skills
 * are never overwritten.
 * @param ctx - Application context (fs)
 */
function seedDefaultGlobalSkills(ctx: AppContext): void {
  const skillsDir = getSkillsDir();
  const defaultSkillsDir = getDefaultSkillsDir();

  // If any skills already exist, do not seed defaults.
  if (ctx.fs.exists(skillsDir)) {
    const existing = listSkillFiles(ctx.fs, skillsDir);
    if (existing.length > 0) return;
  }

  if (!ctx.fs.exists(defaultSkillsDir)) return;

  ctx.fs.mkdirp(skillsDir);
  const defaultFiles = listSkillFiles(ctx.fs, defaultSkillsDir);
  for (const name of defaultFiles) {
    const srcPath = path.join(defaultSkillsDir, name);
    const content = ctx.fs.readFile(srcPath);
    if (typeof content !== "string") continue;
    const destPath = path.join(skillsDir, name);
    if (!ctx.fs.exists(destPath)) {
      ctx.fs.writeFile(destPath, content);
    }
  }
}

/**
 * Seed Maia's skills from defaults/maia/skills into data/agents/maia/skills.
 * Copies only when Maia's skills directory is missing or has no .md files; existing skills are never overwritten.
 * @param ctx - Application context (fs)
 */
function seedDefaultMaiaSkills(ctx: AppContext): void {
  const maiaSkillsDir = getAgentSkillsDir("maia");
  const defaultMaiaSkillsDir = getDefaultMaiaSkillsDir();

  if (!ctx.fs.exists(defaultMaiaSkillsDir)) return;

  if (ctx.fs.exists(maiaSkillsDir)) {
    const existing = listSkillFiles(ctx.fs, maiaSkillsDir);
    if (existing.length > 0) return;
  }

  ctx.fs.mkdirp(maiaSkillsDir);
  const defaultFiles = listSkillFiles(ctx.fs, defaultMaiaSkillsDir);
  for (const name of defaultFiles) {
    const srcPath = path.join(defaultMaiaSkillsDir, name);
    const content = ctx.fs.readFile(srcPath);
    if (typeof content !== "string") continue;
    const destPath = path.join(maiaSkillsDir, name);
    if (!ctx.fs.exists(destPath)) {
      ctx.fs.writeFile(destPath, content);
    }
  }
}

export function initMaiaAgent(ctx: AppContext): void {
  const existing = ctx.db
    .prepare("SELECT id FROM agents WHERE id = 'maia'")
    .get();
  if (!existing) {
    const now = new Date().toISOString();
    ctx.db
      .prepare(
        `INSERT INTO agents (id, name, model, status, system_prompt_extra, created_at, updated_at)
       VALUES ('maia', 'Maia', 'ollama/llama3.2', 'active', NULL, ?, ?)`,
      )
      .run(now, now);

    const maiaDir = path.join(getAgentsDir(), "maia");
    if (!ctx.fs.exists(maiaDir)) {
      copyDefaultAgentFiles(ctx, maiaDir, "Maia", "maia");
    }

    console.log("Maia agent initialized");
  }

  // Always attempt to seed global skills; no-op when skills already exist.
  seedDefaultGlobalSkills(ctx);
  // Seed Maia's skills when her skills dir is empty or missing.
  seedDefaultMaiaSkills(ctx);
}
