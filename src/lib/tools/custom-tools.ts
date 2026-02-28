/**
 * @fileoverview Maia-only tools for approving and deregistering custom agent tools.
 * @module lib/tools/custom-tools
 */

import { z } from "zod";
import { zodToJsonSchema } from "../zod-to-json";
import type { Tool, ToolContext } from "./types";
import {
  loadManifestFromFs,
  isSlugSafe,
} from "./custom-tool-manifest";
import { isToolRegistered } from "./approved-tools";

function makeTool<S extends z.ZodTypeAny>(
  name: string,
  description: string,
  schema: S,
  execute: (args: z.infer<S>, ctx: ToolContext) => Promise<unknown>,
): Tool<z.infer<S>> {
  return {
    name,
    description,
    schema,
    execute,
    toDefinition: () => ({ name, description, parameters: zodToJsonSchema(schema) }),
  };
}

/**
 * Approve (register) a custom tool by slug. Reads and validates manifest from data/tools/<slug>/manifest.json.
 * Duplicate approve is no-op. Maia only.
 */
export const approveTool = makeTool(
  "approve_tool",
  "Register a custom tool by slug after reviewing it. Use file_list first to inspect data/tools/ and see available tool slugs. Reads data/tools/<slug>/manifest.json. Maia only. Use after you have reviewed a tool and found it safe. Example: approve_tool({ slug: 'my-tool' }).",
  z.object({
    slug: z.string().describe("Tool folder under data/tools (e.g. my-tool)"),
  }),
  async ({ slug: toolSlug }, ctx) => {
    if (!isSlugSafe(toolSlug)) {
      throw new Error(`Invalid tool slug: ${toolSlug}`);
    }
    loadManifestFromFs(toolSlug, ctx.fs);
    const now = new Date().toISOString();
    ctx.db
      .prepare(
        "INSERT OR IGNORE INTO approved_tools (tool_slug, approved_at) VALUES (?, ?)",
      )
      .run(toolSlug, now);
    return { approved: toolSlug };
  },
);

/**
 * Deregister a custom tool so its folder can be edited again. Maia only.
 */
export const toolDeregisterTool = makeTool(
  "tool_deregister",
  "Remove a tool from the approved list so it can be edited. Use file_list first to inspect data/tools/ and identify the tool slug to deregister. After edits, the agent must create a new task for you to review again. Maia only. Example: tool_deregister({ slug: 'my-tool' }).",
  z.object({
    slug: z.string().describe("Tool folder under data/tools"),
  }),
  async ({ slug: toolSlug }, ctx) => {
    if (!isSlugSafe(toolSlug)) {
      throw new Error(`Invalid tool slug: ${toolSlug}`);
    }
    const stmt = ctx.db.prepare("DELETE FROM approved_tools WHERE tool_slug = ?");
    stmt.run(toolSlug);
    return { deregistered: toolSlug };
  },
);

export const customToolManagementTools: Tool[] = [approveTool, toolDeregisterTool];
