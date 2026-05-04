/**
 * @fileoverview Data folder index: scan all files under data/, write to SQLite knowledge_vectors.
 * @module lib/knowledge/index
 */

import crypto from "crypto";
import path from "path";
import type { AppContext } from "../context";
import type { EmbeddingAdapter } from "./embedding";
import {
  createEmbeddingAdapter,
  getEffectiveEmbedMaxLength,
} from "./embedding";
import { getDataDir } from "../data-dir";
import { getSettings } from "../settings";
import { createVectorStore } from "./vector-store";

/** Identity filenames at agent root (data/agents/<id>/) to exclude from indexing. */
const IDENTITY_FILES = new Set(["PERSONA.md", "USER.md", "AGENTS.md", "SOUL.md", "MEMORY.md"]);

/**
 * @brief List markdown files under dir, relative to baseDir.
 * @param fs File system adapter
 * @param dir Absolute path to current directory
 * @param baseDir Base directory (data dir) for relative paths
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
 * @brief True if path is agents/<id>/<identity markdown> (persona + obsolete root filenames).
 * @param relPath Path relative to data/
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
  /** Optional embedder; default from settings + ctx.http */
  embedder?: EmbeddingAdapter;
}

/**
 * @brief Scan data/ and upsert each markdown file into knowledge_vectors (excluding identity files).
 * @param ctx App context (fs, http, db)
 * @param options Optional embedder override
 * @returns Counts indexed and removed (paths deleted from disk)
 */
export async function runKnowledgeIndex(
  ctx: AppContext,
  options: RunKnowledgeIndexOptions = {},
): Promise<{ indexed: number; removed: number }> {
  const dataDir = getDataDir();
  if (!ctx.fs.exists(dataDir)) {
    ctx.fs.mkdirp(dataDir);
  }

  const files = listMarkdownFiles(ctx.fs, dataDir, dataDir).filter(
    (rel) => !isIdentityPath(rel),
  );
  const settings = getSettings(ctx);
  const embedder =
    options.embedder ?? createEmbeddingAdapter(settings, ctx.http);
  const effectiveMax = await getEffectiveEmbedMaxLength(settings, ctx.http);
  const store = createVectorStore(ctx.db);
  const existingPaths = new Set(store.getAllKnowledgePaths());
  let indexed = 0;
  const updatedAt = new Date().toISOString();
  for (const relPath of files) {
    const fullPath = path.join(dataDir, relPath);
    const content = ctx.fs.readFile(fullPath);
    const contentHash = crypto
      .createHash("sha256")
      .update(content)
      .digest("hex");
    if (store.getKnowledgeHash(relPath) === contentHash) continue;
    try {
      const embedding = await embedder.embed(content.slice(0, effectiveMax));
      store.upsertKnowledge(
        relPath,
        relPath,
        content,
        contentHash,
        embedding,
        updatedAt,
      );
      indexed++;
      console.info(`[Embedding] Indexing data file: ${relPath}`);
    } catch (err) {
      console.error(`Knowledge index: vector write skip ${relPath}:`, err);
    }
  }
  let removed = 0;
  for (const p of existingPaths) {
    if (!files.includes(p)) {
      store.deleteKnowledgeByPath(p);
      removed++;
    }
  }
  return { indexed, removed };
}

/** Data directory root (for tests that seed files). Paths under this are indexed relative to it. */
export const DATA_DIR = getDataDir();
