/**
 * @fileoverview PARA durable facts: Projects / Areas / Resources / Archives on disk (items.json + summary.md).
 * @module lib/memory/para
 */

import path from "path";
import { getAgentDir } from "../data-dir";
import type { AppContext } from "../context";

/** Atomic fact in PARA items.json */
export interface ParaFact {
  id: string;
  fact: string;
  category: string;
  created_at: string;
  source: string;
  status: "active" | "superseded";
  replaced_by?: string;
  access_count: number;
  last_accessed_at: string;
}

/**
 * @brief Root of PARA tree under agent directory.
 * @param agentId Agent id
 */
export function getParaLifeRoot(fs: AppContext["fs"], agentId: string): string {
  const root = path.join(getAgentDir(agentId), "life");
  if (!fs.exists(root)) fs.mkdirp(root);
  return root;
}

/**
 * @brief Parse items.json; returns [] on missing/invalid.
 * @param raw File contents
 */
export function parseParaItemsJson(raw: string): ParaFact[] {
  try {
    const data = JSON.parse(raw) as unknown;
    if (!Array.isArray(data)) return [];
    return data.filter(
      (x): x is ParaFact =>
        x != null &&
        typeof x === "object" &&
        typeof (x as ParaFact).id === "string" &&
        typeof (x as ParaFact).fact === "string" &&
        typeof (x as ParaFact).status === "string",
    );
  } catch {
    return [];
  }
}

/**
 * @brief Serialize facts to JSON (pretty).
 * @param items Facts list
 */
export function stringifyParaItems(items: ParaFact[]): string {
  return JSON.stringify(items, null, 2);
}

/**
 * @brief Read active facts from a leaf path relative to life/ (e.g. projects/x/items.json).
 * @param ctx App context
 * @param agentId Agent id
 * @param relativePath Path under life/ to items.json
 */
export function readParaItemsFile(
  ctx: AppContext,
  agentId: string,
  relativePath: string,
): ParaFact[] {
  const norm = relativePath.replace(/\\/g, "/").replace(/^\//, "");
  const full = path.join(getAgentDir(agentId), "life", norm);
  if (!ctx.fs.exists(full)) return [];
  try {
    const raw = ctx.fs.readFile(full);
    return parseParaItemsJson(raw).filter((f) => f.status === "active");
  } catch {
    return [];
  }
}

/**
 * @brief Add or supersede a fact in items.json (creates parent dirs).
 * @param ctx App context
 * @param agentId Agent id
 * @param relativePath Path under life/ to items.json
 * @param fact New active fact (id must be unique; superseded rows updated if same id replaced)
 */
export function upsertParaFact(
  ctx: AppContext,
  agentId: string,
  relativePath: string,
  fact: Omit<ParaFact, "access_count" | "last_accessed_at"> & {
    access_count?: number;
    last_accessed_at?: string;
  },
): ParaFact[] {
  const norm = relativePath.replace(/\\/g, "/").replace(/^\//, "");
  const full = path.join(getAgentDir(agentId), "life", norm);
  const dir = path.dirname(full);
  if (!ctx.fs.exists(dir)) ctx.fs.mkdirp(dir);
  let existing: ParaFact[] = [];
  if (ctx.fs.exists(full)) {
    try {
      existing = parseParaItemsJson(ctx.fs.readFile(full));
    } catch {
      existing = [];
    }
  }
  const now = new Date().toISOString();
  const nextFact: ParaFact = {
    ...fact,
    access_count: fact.access_count ?? 0,
    last_accessed_at: fact.last_accessed_at ?? now,
  };
  for (let i = 0; i < existing.length; i++) {
    const f = existing[i];
    if (f.id === fact.id && f.status === "active") {
      existing[i] = {
        ...f,
        status: "superseded",
        replaced_by: fact.id,
      };
    }
  }
  existing.push(nextFact);
  ctx.fs.writeFile(full, stringifyParaItems(existing));
  return existing.filter((f) => f.status === "active");
}

/**
 * @brief Recursively scan the life tree for items.json files and collect active facts (bounded count).
 * @param ctx App context
 * @param agentId Agent id
 * @param maxFiles Max items.json files to read
 */
export function collectActiveParaFacts(
  ctx: AppContext,
  agentId: string,
  maxFiles: number,
): Array<{ path: string; facts: ParaFact[] }> {
  const root = getParaLifeRoot(ctx.fs, agentId);
  const out: Array<{ path: string; facts: ParaFact[] }> = [];
  function walk(dir: string, depth: number): void {
    if (out.length >= maxFiles || depth > 12) return;
    if (!ctx.fs.exists(dir)) return;
    for (const name of ctx.fs.listDir(dir)) {
      if (out.length >= maxFiles) return;
      const full = path.join(dir, name);
      if (name === "items.json") {
        try {
          const raw = ctx.fs.readFile(full);
          const facts = parseParaItemsJson(raw).filter((f) => f.status === "active");
          if (facts.length > 0)
            out.push({
              path: path.relative(root, full).replace(/\\/g, "/"),
              facts,
            });
        } catch {
          /* skip */
        }
        continue;
      }
      try {
        walk(full, depth + 1);
      } catch {
        /* not a dir */
      }
    }
  }
  walk(root, 0);
  return out;
}
