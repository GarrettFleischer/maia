/**
 * @fileoverview Workspace file loader. Loads SOUL, AGENTS, USER, IDENTITY, TOOLS,
 * and MEMORY markdown files from the workspace path.
 * @module workspace/loader
 */

import type { MaiaContext } from "../core/types.js";

/** @brief Result of loadAll. */
export interface WorkspaceContent {
  soul: string;
  agents: string;
  user: string;
  identity: string;
  tools: string;
  memory: string;
}

/** @brief Workspace loader interface. */
export interface WorkspaceLoader {
  loadSoul(): Promise<string>;
  loadAgents(): Promise<string>;
  loadUser(): Promise<string>;
  loadIdentity(): Promise<string>;
  loadTools(): Promise<string>;
  loadMemory(): Promise<string>;
  loadAll(): Promise<WorkspaceContent>;
}

/**
 * @brief Reads a workspace file, returning empty string if it does not exist.
 * @param ctx - Maia context with fs
 * @param basePath - Workspace root path
 * @param filename - Filename without path (e.g. SOUL.md)
 * @returns Promise resolving to file content or empty string
 */
async function readWorkspaceFile(
  ctx: MaiaContext,
  basePath: string,
  filename: string
): Promise<string> {
  const path = `${basePath.replace(/\/?$/, "")}/${filename}`;
  const exists = await ctx.fs.exists(path);
  if (!exists) return "";
  return ctx.fs.readFile(path);
}

/**
 * @brief Creates a workspace loader for the given path.
 * @param ctx - Maia context with fs
 * @param workspacePath - Root path of the workspace
 * @returns WorkspaceLoader with load methods
 */
export function createWorkspaceLoader(
  ctx: MaiaContext,
  workspacePath: string
): WorkspaceLoader {
  return {
    async loadSoul(): Promise<string> {
      return readWorkspaceFile(ctx, workspacePath, "SOUL.md");
    },
    async loadAgents(): Promise<string> {
      return readWorkspaceFile(ctx, workspacePath, "AGENTS.md");
    },
    async loadUser(): Promise<string> {
      return readWorkspaceFile(ctx, workspacePath, "USER.md");
    },
    async loadIdentity(): Promise<string> {
      return readWorkspaceFile(ctx, workspacePath, "IDENTITY.md");
    },
    async loadTools(): Promise<string> {
      return readWorkspaceFile(ctx, workspacePath, "TOOLS.md");
    },
    async loadMemory(): Promise<string> {
      return readWorkspaceFile(ctx, workspacePath, "MEMORY.md");
    },
    async loadAll(): Promise<WorkspaceContent> {
      const [soul, agents, user, identity, tools, memory] = await Promise.all([
        readWorkspaceFile(ctx, workspacePath, "SOUL.md"),
        readWorkspaceFile(ctx, workspacePath, "AGENTS.md"),
        readWorkspaceFile(ctx, workspacePath, "USER.md"),
        readWorkspaceFile(ctx, workspacePath, "IDENTITY.md"),
        readWorkspaceFile(ctx, workspacePath, "TOOLS.md"),
        readWorkspaceFile(ctx, workspacePath, "MEMORY.md"),
      ]);
      return { soul, agents, user, identity, tools, memory };
    },
  };
}
