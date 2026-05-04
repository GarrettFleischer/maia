/**
 * @fileoverview Central data directory root. Production uses process.cwd()/data;
 * tests set MAIA_DATA_DIR to a temp dir that is cleaned up after the run.
 * @module lib/data-dir
 */

import path from "path";

/**
 * Root directory for all app data (db, agents, user, tools).
 * Use MAIA_DATA_DIR in tests so real files are never touched.
 * @returns Absolute path to the data directory
 */
export function getDataDir(): string {
  const root = process.env.MAIA_DATA_DIR ?? path.join(process.cwd(), "data");
  return path.resolve(root);
}

/** Agents identity files and workspace: getDataDir()/agents */
export function getAgentsDir(): string {
  return path.join(getDataDir(), "agents");
}

/**
 * Per-agent directory (identity files, workspace, memory, user folders).
 * @param agentId - Agent identifier
 * @returns Absolute path to data/agents/<agentId>
 */
export function getAgentDir(agentId: string): string {
  return path.join(getAgentsDir(), agentId);
}

/**
 * Per-agent workspace for file work: data/agents/<agentId>/workspace.
 * @param agentId - Agent identifier
 * @returns Absolute path to the agent's workspace directory
 */
export function getAgentWorkspace(agentId: string): string {
  return path.join(getAgentDir(agentId), "workspace");
}

/**
 * User-provided files indexed for agents: getDataDir()/user.
 * @returns Absolute path to data/user
 */
export function getUserDir(): string {
  return path.join(getDataDir(), "user");
}

/**
 * Legacy knowledge base root: getDataDir()/knowledge.
 * @deprecated Step 5a will replace with indexing over all data/; avoid new usages.
 * @returns Absolute path to data/knowledge
 */
export function getKnowledgeDir(): string {
  return path.join(getDataDir(), "knowledge");
}

/** Custom agent tools (manifests): getDataDir()/tools */
export function getToolsDir(): string {
  return path.join(getDataDir(), "tools");
}

/** Global skills (all agents): getDataDir()/skills */
export function getSkillsDir(): string {
  return path.join(getDataDir(), "skills");
}

/**
 * Per-agent skills: data/agents/<agentId>/skills.
 * @param agentId - Agent identifier
 * @returns Absolute path to the agent's skills directory
 */
export function getAgentSkillsDir(agentId: string): string {
  return path.join(getAgentDir(agentId), "skills");
}

/**
 * Default agent template files. New agents (non-Maia) get copies of these; user can edit to change templates.
 * Resolved from project root: <cwd>/defaults/agent (MAIA_DATA_DIR does not affect this).
 * @returns Absolute path to defaults/agent directory
 */
export function getDefaultAgentDir(): string {
  return path.resolve(process.cwd(), "defaults", "agent");
}

/**
 * Default template files for the Maia agent. Used when seeding Maia's directory on first run.
 * Resolved from project root: <cwd>/defaults/maia. Maia gets PERSONA.md from here (orchestrator persona).
 * @returns Absolute path to defaults/maia directory
 */
export function getDefaultMaiaDir(): string {
  return path.resolve(process.cwd(), "defaults", "maia");
}

/**
 * Default Maia-only skills directory. Skills here are copied into data/agents/maia/skills
 * when Maia is first created or when her skills directory is empty.
 * Resolved from project root: <cwd>/defaults/maia/skills.
 * @returns Absolute path to defaults/maia/skills directory
 */
export function getDefaultMaiaSkillsDir(): string {
  return path.join(getDefaultMaiaDir(), "skills");
}

/**
 * Default global skills directory. Markdown skills here are copied into the root
 * skills folder on first run when no skills exist yet.
 * Resolved from project root: <cwd>/defaults/skills (MAIA_DATA_DIR does not affect this).
 * @returns Absolute path to defaults/skills directory
 */
export function getDefaultSkillsDir(): string {
  return path.resolve(process.cwd(), "defaults", "skills");
}

/**
 * Bundled Codex-style persona `.toml` files (e.g. from awesome-codex-subagents). Not affected by MAIA_DATA_DIR.
 * @returns `<cwd>/defaults/personas/catalog`
 */
export function getDefaultPersonasCatalogDir(): string {
  return path.resolve(process.cwd(), "defaults", "personas", "catalog");
}

/**
 * User-added persona `.toml` files; same merge rules as defaults, later wins by id.
 * @returns `getDataDir()/personas/catalog`
 */
export function getPersonasDataCatalogDir(): string {
  return path.join(getDataDir(), "personas", "catalog");
}

/**
 * Optional markdown overrides merged after each persona's `[instructions].text`.
 * @returns `getDataDir()/personas/overrides`
 */
export function getPersonasOverridesDir(): string {
  return path.join(getDataDir(), "personas", "overrides");
}
