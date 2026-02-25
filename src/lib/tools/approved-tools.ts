/**
 * @fileoverview Helpers for the approved_tools table: list registered slugs and check registration.
 * @module lib/tools/approved-tools
 */

import type { DbAdapter } from "../context";

/**
 * @brief Get all approved (registered) tool slugs.
 * @param db - Database adapter
 * @returns Array of tool_slug strings
 */
export function getApprovedToolSlugs(db: DbAdapter): string[] {
  const rows = db.prepare("SELECT tool_slug FROM approved_tools").all() as {
    tool_slug: string;
  }[];
  return rows.map((r) => r.tool_slug);
}

/**
 * @brief Check whether a tool slug is registered (approved).
 * @param db - Database adapter
 * @param slug - Tool folder name under data/tools
 * @returns True if the slug is in approved_tools
 */
export function isToolRegistered(db: DbAdapter, slug: string): boolean {
  const row = db
    .prepare("SELECT 1 FROM approved_tools WHERE tool_slug = ?")
    .get(slug) as { "1": number } | undefined;
  return row !== undefined;
}
