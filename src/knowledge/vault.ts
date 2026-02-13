/**
 * @fileoverview Knowledge vault manager for Obsidian-style notes.
 * @module knowledge/vault
 * @brief Create, update, list, and read notes with YAML frontmatter.
 */

import type { FileSystem, KnowledgeNote, Logger } from "../core/types.js";

/** @brief Dependencies for createKnowledgeVault */
export interface KnowledgeVaultDeps {
  fs: FileSystem;
  logger: Logger;
  basePath: string;
}

/** @brief Knowledge vault interface */
export interface KnowledgeVault {
  createNote(note: KnowledgeNote): Promise<void>;
  updateNote(
    path: string,
    updates: { content?: string; frontmatter?: Partial<KnowledgeNote["frontmatter"]> }
  ): Promise<void>;
  listNotes(category: string): Promise<string[]>;
  noteExists(path: string): Promise<boolean>;
  readNote(path: string): Promise<KnowledgeNote>;
}

/**
 * @brief Parses YAML frontmatter with simple regex (no YAML library).
 * @param content - Raw file content
 * @returns Object with frontmatter and body
 */
function parseFrontmatter(content: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, body: content };
  }

  const [, yamlStr, body] = match;
  const frontmatter: Record<string, unknown> = {};

  if (yamlStr) {
    for (const line of yamlStr.split(/\r?\n/)) {
      const colonIdx = line.indexOf(":");
      if (colonIdx === -1) continue;
      const key = line.slice(0, colonIdx).trim();
      let value: unknown = line.slice(colonIdx + 1).trim();
      if (typeof value === "string" && value.startsWith("[") && value.endsWith("]")) {
        value = value
          .slice(1, -1)
          .split(",")
          .map((s) => s.trim().replace(/^["']|["']$/g, ""));
      }
      frontmatter[key] = value;
    }
  }

  return { frontmatter, body: body ?? "" };
}

/**
 * @brief Extracts [[wikilinks]] from content.
 * @param content - Markdown content
 * @returns Array of unique wikilink targets
 */
function extractWikilinks(content: string): string[] {
  const matches = content.matchAll(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g);
  const links = [...matches].map((m) => m[1].trim());
  return [...new Set(links)];
}

/**
 * @brief Extracts first # heading as title.
 * @param content - Markdown content
 * @returns Title or empty string
 */
function extractTitle(content: string): string {
  const match = content.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : "";
}

/**
 * @brief Creates a knowledge vault instance.
 * @param deps - Dependencies: fs, logger, basePath
 * @returns KnowledgeVault interface
 */
export function createKnowledgeVault(deps: KnowledgeVaultDeps): KnowledgeVault {
  const { fs, logger, basePath } = deps;

  function fullPath(path: string): string {
    return `${basePath}/${path}`.replace(/\/+/g, "/");
  }

  async function ensureParentDir(path: string): Promise<void> {
    const lastSep = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
    if (lastSep > 0) {
      const dir = path.slice(0, lastSep);
      try {
        await fs.mkdir(dir);
      } catch {
        /* directory may already exist */
      }
    }
  }

  async function writeNote(note: KnowledgeNote): Promise<void> {
    const path = fullPath(note.path);
    await ensureParentDir(path);
    const fm = note.frontmatter;
    const categoryLine = fm.category ? `category: "${fm.category}"\n` : "";
    const body = note.content.includes(`# ${note.title}`)
      ? note.content
      : `# ${note.title}\n\n${note.content}`;
    const yaml = `---\ntags: [${(fm.tags ?? []).map((t) => `"${t}"`).join(", ")}]\ncreated: ${fm.created ?? new Date().toISOString().slice(0, 10)}\nupdated: ${fm.updated ?? new Date().toISOString().slice(0, 10)}\n${categoryLine}---\n\n${body}\n`;
    await fs.writeFile(path, yaml);
  }

  async function readNote(path: string): Promise<KnowledgeNote> {
    const full = fullPath(path);
    const raw = await fs.readFile(full);
    const { frontmatter, body } = parseFrontmatter(raw);
    const tags = Array.isArray(frontmatter.tags)
      ? (frontmatter.tags as string[])
      : typeof frontmatter.tags === "string"
        ? [frontmatter.tags]
        : [];
    const created = String(frontmatter.created ?? "");
    const updated = String(frontmatter.updated ?? "");
    const category =
      typeof frontmatter.category === "string" ? frontmatter.category : undefined;
    return {
      path,
      title: extractTitle(body),
      content: body,
      frontmatter: { tags, created, updated, category },
      wikilinks: extractWikilinks(body),
    };
  }

  return {
    async createNote(note: KnowledgeNote): Promise<void> {
      await writeNote(note);
      logger.debug("Knowledge note created", { path: note.path });
    },

    async updateNote(
      path: string,
      updates: { content?: string; frontmatter?: Partial<KnowledgeNote["frontmatter"]> }
    ): Promise<void> {
      const existing = await readNote(path);
      const newContent = updates.content ?? existing.content;
      const newFm = {
        ...existing.frontmatter,
        ...updates.frontmatter,
      };
      const today = new Date().toISOString().slice(0, 10);
      if (!newFm.updated) newFm.updated = today;

      const note: KnowledgeNote = {
        path,
        title: extractTitle(newContent),
        content: newContent,
        frontmatter: newFm,
        wikilinks: extractWikilinks(newContent),
      };

      await writeNote(note);
      logger.debug("Knowledge note updated", { path });
    },

    async listNotes(category: string): Promise<string[]> {
      const dir = fullPath(category);
      try {
        const files = await fs.readDir(dir);
        return files.filter((f) => f.endsWith(".md"));
      } catch {
        return [];
      }
    },

    async noteExists(path: string): Promise<boolean> {
      return fs.exists(fullPath(path));
    },

    async readNote(path: string): Promise<KnowledgeNote> {
      return readNote(path);
    },
  };
}
