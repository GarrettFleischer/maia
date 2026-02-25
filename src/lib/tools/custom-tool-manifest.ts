/**
 * @fileoverview Manifest schema and loader for custom agent tools under data/tools.
 * @module lib/tools/custom-tool-manifest
 */

import { z } from "zod";
import path from "path";
import type { Tool, ToolContext } from "./types";
import type { ToolDefinition } from "../ai/types";
import { getToolsDir } from "../data-dir";
import type { FileSystemAdapter } from "../context";

/**
 * JSON Schema object for a function's parameters (same shape as ToolDefinition.parameters).
 */
export const manifestFunctionParametersSchema = z.record(z.string(), z.any());

/**
 * Single function exposed by a custom tool (name, description, JSON Schema parameters).
 */
export const manifestFunctionSpecSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  parameters: manifestFunctionParametersSchema,
});

export type ManifestFunctionSpec = z.infer<typeof manifestFunctionSpecSchema>;

/**
 * Manifest schema for data/tools/<slug>/manifest.json.
 */
export const manifestSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  functions: z.array(manifestFunctionSpecSchema).min(1),
});

export type Manifest = z.infer<typeof manifestSchema>;

/**
 * Parse and validate a manifest JSON string.
 * @param json - Raw manifest.json content
 * @returns Validated manifest
 * @throws ZodError with message when invalid
 */
export function parseManifest(json: string): Manifest {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Invalid manifest JSON: ${msg}`);
  }
  return manifestSchema.parse(data);
}

/** Slug must be safe for path segment: alphanumeric and hyphen only. */
const SLUG_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/i;

/**
 * Validate that a tool slug is safe (no path traversal).
 * @returns true if slug is safe
 */
export function isSlugSafe(slug: string): boolean {
  return slug.length > 0 && SLUG_REGEX.test(slug);
}

/**
 * Load manifest from data/tools/<slug>/manifest.json using the provided fs.
 * @param slug - Tool folder name
 * @param fs - File system adapter
 * @returns Parsed and validated manifest
 */
export function loadManifestFromFs(
  slug: string,
  fs: FileSystemAdapter,
): Manifest {
  if (!isSlugSafe(slug)) {
    throw new Error(`Invalid tool slug: ${slug}`);
  }
  const toolsDir = getToolsDir();
  const manifestPath = path.join(toolsDir, slug, "manifest.json");
  const content = fs.readFile(manifestPath);
  return parseManifest(content);
}

/**
 * Build one Tool per function from a manifest (stub execute).
 * Used by the registry to expose approved custom tools.
 * @param slug - Tool folder name (for stub message)
 * @param manifest - Validated manifest
 * @returns Array of Tool instances
 */
export function buildToolsFromManifest(slug: string, manifest: Manifest): Tool[] {
  return manifest.functions.map((func) => {
    const toolName = func.name;
    const toolDescription = func.description;
    const parameters = func.parameters;
    return {
      name: toolName,
      description: toolDescription,
      schema: z.record(z.string(), z.unknown()),
      execute: async (
        _args: Record<string, unknown>,
        _ctx: ToolContext,
      ): Promise<string> =>
        `Custom tool "${toolName}" is registered; execution not yet implemented.`,
      toDefinition(): ToolDefinition {
        return { name: toolName, description: toolDescription, parameters };
      },
    };
  });
}
