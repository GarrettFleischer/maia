/**
 * @fileoverview Central data directory root. Production uses process.cwd()/data;
 * tests set MAIA_DATA_DIR to a temp dir that is cleaned up after the run.
 * @module lib/data-dir
 */

import path from "path";

/**
 * Root directory for all app data (db, agents, workspace, knowledge).
 * Use MAIA_DATA_DIR in tests so real files are never touched.
 * @returns Absolute path to the data directory
 */
export function getDataDir(): string {
  const root = process.env.MAIA_DATA_DIR ?? path.join(process.cwd(), "data");
  return path.resolve(root);
}

/** Agents identity files: getDataDir()/agents */
export function getAgentsDir(): string {
  return path.join(getDataDir(), "agents");
}

/** Per-agent workspaces: getDataDir()/workspace */
export function getWorkspaceRoot(): string {
  return path.join(getDataDir(), "workspace");
}

/** Knowledge base markdown: getDataDir()/knowledge */
export function getKnowledgeDir(): string {
  return path.join(getDataDir(), "knowledge");
}
