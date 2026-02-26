/**
 * @fileoverview Knowledge base index: scan markdown files, embed full documents, upsert to vector store.
 * @module lib/knowledge/index
 *
 * One embedding per file (no chunking). Runs on startup and hourly.
 * Content is truncated before embedding to avoid exceeding the model context length.
 */

import path from "path";
import { createHash } from "crypto";
import { v4 as uuidv4 } from "uuid";
import type { AppContext } from "../context";
import type { EmbeddingAdapter } from "./embedding";
import { createVectorStore } from "./vector-store";
import { getKnowledgeDir } from "../data-dir";
import { getSettings } from "../settings";

const KNOWLEDGE_DIR = getKnowledgeDir();

function listMarkdownFiles(fs: AppContext["fs"], dir: string, baseDir: string): string[] {
  const out: string[] = [];
  if (!fs.exists(dir)) return out;
  for (const name of fs.listDir(dir)) {
    const full = path.join(dir, name);
    const rel = path.relative(baseDir, full);
    if (name.endsWith(".md")) {
      out.push(rel.replace(/\\/g, "/"));
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

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export interface RunKnowledgeIndexOptions {
  /** Embedding adapter (e.g. Ollama). If not provided, index is skipped (e.g. when embedding service unavailable). */
  embedder?: EmbeddingAdapter;
}

/**
 * Scan data/knowledge/, compute hashes, embed changed/new files, upsert to vector store.
 * Remove from vector store any path that no longer exists on disk.
 * @param ctx - App context (fs, db)
 * @param options - Optional embedder; if missing, indexing is a no-op
 */
export async function runKnowledgeIndex(
  ctx: AppContext,
  options: RunKnowledgeIndexOptions = {}
): Promise<{ indexed: number; removed: number }> {
  const { embedder } = options;
  const store = createVectorStore(ctx.db);
  let indexed = 0;
  let removed = 0;

  const knowledgeDir = KNOWLEDGE_DIR;
  if (!ctx.fs.exists(knowledgeDir)) {
    ctx.fs.mkdirp(knowledgeDir);
    const existingPaths = store.getAllKnowledgePaths();
    for (const p of existingPaths) {
      store.deleteKnowledgeByPath(p);
      removed++;
    }
    return { indexed: 0, removed };
  }

  const files = listMarkdownFiles(ctx.fs, knowledgeDir, knowledgeDir);
  const currentPaths = new Set(files);

  for (const relPath of files) {
    const fullPath = path.join(knowledgeDir, relPath);
    const content = ctx.fs.readFile(fullPath);
    const contentHash = sha256(content);
    const existingHash = store.getKnowledgeHash(relPath);
    if (existingHash === contentHash) continue;

    if (!embedder) continue;
    const maxLen = getSettings(ctx).embedMaxContentLength;
    const contentToEmbed =
      content.length > maxLen ? content.slice(0, maxLen) : content;
    try {
      const embedding = await embedder.embed(contentToEmbed);
      const id = uuidv4();
      const now = new Date().toISOString();
      store.upsertKnowledge(id, relPath, content, contentHash, embedding, now);
      indexed++;
    } catch (err) {
      console.error(`Knowledge index: skip ${relPath} (embed failed):`, err);
    }
  }

  const storedPaths = store.getAllKnowledgePaths();
  for (const p of storedPaths) {
    if (!currentPaths.has(p)) {
      store.deleteKnowledgeByPath(p);
      removed++;
    }
  }

  return { indexed, removed };
}

export { KNOWLEDGE_DIR };
