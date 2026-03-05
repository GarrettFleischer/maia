/**
 * @fileoverview Data folder index: scan all files under data/, write to MuninnDB when configured.
 * @module lib/knowledge/index
 *
 * When Muninn URL is set, discovers markdown files and writes each as an engram (no vector store).
 * When not set, indexing is a no-op.
 */

import path from "path";
import type { AppContext } from "../context";
import type { EmbeddingAdapter } from "./embedding";
import { getDataDir } from "../data-dir";
import { getMuninnConfig } from "../muninn/config";
import { createMuninnClient } from "../muninn/client";
import { vaultFromKnowledgePath } from "../muninn/vault";

/** Identity filenames at agent root (data/agents/<id>/) to exclude from indexing. */
const IDENTITY_FILES = new Set([
  "SOUL.md",
  "MEMORY.md",
  "USER.md",
  "AGENTS.md",
]);

/**
 * List markdown files under dir, relative to baseDir.
 * @param fs - File system adapter
 * @param dir - Absolute path to current directory
 * @param baseDir - Base directory (data dir) for relative paths
 */
function listMarkdownFiles(
  fs: AppContext["fs"],
  dir: string,
  baseDir: string,
): string[] {
  const out: string[] = [];
  if (!fs.exists(dir)) return out;
  for (const name of fs.listDir(dir)) {
    const full = path.join(dir, name);
    const rel = path.relative(baseDir, full).replace(/\\/g, "/");
    if (name.endsWith(".md")) {
      out.push(rel);
    } else if (!name.startsWith(".")) {
      try {
        const sub = listMarkdownFiles(fs, full, baseDir);
        out.push(...sub);
      } catch {
        // skip non-directories or permission errors
      }
    }
  }
  return out;
}

/**
 * Check if a file path (relative to data/) is an identity file: agents/<id>/SOUL.md etc.
 */
function isIdentityPath(relPath: string): boolean {
  const norm = relPath.replace(/\\/g, "/");
  if (!norm.startsWith("agents/")) return false;
  const afterAgents = norm.slice(7);
  const parts = afterAgents.split("/");
  if (parts.length !== 2) return false;
  return IDENTITY_FILES.has(parts[1]!);
}

export interface RunKnowledgeIndexOptions {
  /** Unused when Muninn is the only backend; kept for API compatibility. */
  embedder?: EmbeddingAdapter;
}

/**
 * Scan all files under data/ and write each as an engram to Muninn when configured.
 * Excludes agent identity files. When Muninn URL is not set, returns { indexed: 0, removed: 0 }.
 * @param ctx - App context (fs, http)
 * @param _options - Optional embedder (ignored; Muninn embeds server-side)
 */
export async function runKnowledgeIndex(
  ctx: AppContext,
  _options: RunKnowledgeIndexOptions = {},
): Promise<{ indexed: number; removed: number }> {
  const muninnConfig = getMuninnConfig(ctx);
  if (!muninnConfig.enabled) {
    return { indexed: 0, removed: 0 };
  }

  const dataDir = getDataDir();
  if (!ctx.fs.exists(dataDir)) {
    ctx.fs.mkdirp(dataDir);
    return { indexed: 0, removed: 0 };
  }

  const files = listMarkdownFiles(ctx.fs, dataDir, dataDir).filter(
    (rel) => !isIdentityPath(rel),
  );
  let indexed = 0;
  const client = createMuninnClient(ctx.http, muninnConfig.baseUrl);

  for (const relPath of files) {
    const fullPath = path.join(dataDir, relPath);
    const content = ctx.fs.readFile(fullPath);
    try {
      const concept = relPath.slice(0, 512);
      const contentForMuninn = content.slice(0, 16 * 1024);
      const vault = vaultFromKnowledgePath(relPath);
      await client.writeEngram(vault, concept, contentForMuninn, [
        "knowledge",
        relPath,
      ]);
      indexed++;
      console.info(`[Embedding] Indexing data file: ${relPath}`);
    } catch (err) {
      console.error(`Knowledge index: Muninn write skip ${relPath}:`, err);
    }
  }

  return { indexed, removed: 0 };
}

/** Data directory root (for tests that seed files). Paths under this are indexed relative to it. */
export const DATA_DIR = getDataDir();
