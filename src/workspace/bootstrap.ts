/**
 * @fileoverview Workspace bootstrap. Creates default workspace files from
 * templates and removes BOOTSTRAP.md when complete.
 * @module workspace/bootstrap
 */

import type { MaiaContext } from "../core/types.js";

/** @brief Bootstrap interface. */
export interface Bootstrap {
  isNeeded(): Promise<boolean>;
  initializeWorkspace(): Promise<void>;
  complete(): Promise<void>;
}

/** @brief Default template content for workspace files. */
const TEMPLATES: Record<string, string> = {
  "SOUL.md": "# Soul\n\nDefine your AI's core identity and values here.\n",
  "AGENTS.md": "# Agents\n\nConfigure agent behaviors and rules here.\n",
  "USER.md": "# User\n\nUser preferences and context.\n",
  "IDENTITY.md": "# Identity\n\nname: Maia\nemoji: 🌙\npersonality: helpful assistant\n",
  "TOOLS.md": "# Tools\n\nConfigure available tools and permissions.\n",
  "BOOTSTRAP.md": "# Bootstrap\n\nThis file indicates the workspace is being set up. It will be removed when setup is complete.\n",
};

/**
 * @brief Creates a bootstrap helper for the given workspace path.
 * @param ctx - Maia context with fs
 * @param workspacePath - Root path of the workspace
 * @returns Bootstrap with isNeeded, initializeWorkspace, and complete methods
 */
export function createBootstrap(
  ctx: MaiaContext,
  workspacePath: string
): Bootstrap {
  const base = workspacePath.replace(/\/?$/, "");
  const bootstrapPath = `${base}/BOOTSTRAP.md`;

  return {
    async isNeeded(): Promise<boolean> {
      return ctx.fs.exists(bootstrapPath);
    },
    async initializeWorkspace(): Promise<void> {
      const dirExists = await ctx.fs.exists(base);
      if (!dirExists) {
        await ctx.fs.mkdir(base);
      }
      for (const [filename, content] of Object.entries(TEMPLATES)) {
        await ctx.fs.writeFile(`${base}/${filename}`, content);
      }
    },
    async complete(): Promise<void> {
      await ctx.fs.remove(bootstrapPath);
    },
  };
}
