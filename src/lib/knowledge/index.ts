/**
 * @fileoverview Data folder index: scan all files under data/, excluding agent identity files,
 * embed and upsert to vector store. Paths stored relative to data/ for scope filtering.
 * @module lib/knowledge/index
 *
 * One embedding per file (no chunking). Content truncated before embedding to avoid context length limits.
 */

import path from "path";
import { createHash } from "crypto";
import { v4 as uuidv4 } from "uuid";
import type { AppContext } from "../context";
import type { EmbeddingAdapter } from "./embedding";
import { getEffectiveEmbedMaxLength } from "./embedding";
import { createVectorStore } from "./vector-store";
import { getDataDir } from "../data-dir";
import { getSettings } from "../settings";

/** Identity filenames at agent root (data/agents/<id>/) to exclude from indexing. */
const IDENTITY_FILES = new Set(["SOUL.md", "MEMORY.md", "USER.md", "AGENTS.md"]);

/**
 * List markdown files under dir, relative to baseDir.
 * @param fs - File system adapter
 * @param dir - Absolute path to current directory
 * @param baseDir - Base directory (data dir) for relative paths
 */
function listMarkdownFiles(
  fs: AppContext["fs"],
  dir: string,
  baseDir: string
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

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export interface RunKnowledgeIndexOptions {
  /** Embedding adapter (e.g. Ollama). If not provided, index is skipped. */
  embedder?: EmbeddingAdapter;
}

/**
 * Scan all files under data/, compute hashes, embed changed/new files, upsert to vector store.
 * Excludes agent identity files (SOUL.md, MEMORY.md, USER.md, AGENTS.md under data/agents/<id>/).
 * Paths stored relative to data/ (e.g. agents/maia/workspace/foo.md, user/notes.md).
 * Remove from store any path that no longer exists on disk.
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

  const dataDir = getDataDir();
  if (!ctx.fs.exists(dataDir)) {
    ctx.fs.mkdirp(dataDir);
    const existingPaths = store.getAllKnowledgePaths();
    for (const p of existingPaths) {
      store.deleteKnowledgeByPath(p);
      removed++;
    }
    return { indexed: 0, removed };
  }

  const files = listMarkdownFiles(ctx.fs, dataDir, dataDir).filter(
    (rel) => !isIdentityPath(rel)
  );
  const currentPaths = new Set(files);

  let maxLen: number | undefined;
  if (embedder) {
    const settings = getSettings(ctx);
    maxLen = await getEffectiveEmbedMaxLength(settings, ctx.http);
  }

  for (const relPath of files) {
    const fullPath = path.join(dataDir, relPath);
    const content = ctx.fs.readFile(fullPath);
    const contentHash = sha256(content);
    const existingHash = store.getKnowledgeHash(relPath);
    if (existingHash === contentHash) continue;

    if (!embedder || maxLen === undefined) continue;
    console.info(`[Embedding] Indexing data file: ${relPath}`);
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

/** Data directory root (for tests that seed files). Paths under this are indexed relative to it. */
export const DATA_DIR = getDataDir();
