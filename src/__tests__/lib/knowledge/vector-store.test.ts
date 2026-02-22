/**
 * @fileoverview Tests for knowledge vector store (upsert, delete, search).
 * @module __tests__/lib/knowledge/vector-store
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { makeTestDb } from "@/__tests__/helpers/db";
import { createVectorStore } from "@/lib/knowledge/vector-store";
import type { DbAdapter } from "@/lib/context";

describe("vector-store", () => {
  let db: DbAdapter;

  beforeEach(() => {
    db = makeTestDb();
  });

  describe("knowledge", () => {
    it("upserts and searchKnowledge returns by similarity", () => {
      const store = createVectorStore(db);
      const vecA = [1, 0, 0];
      const vecB = [0.9, 0.1, 0];
      const vecC = [0, 1, 0];
      store.upsertKnowledge("id1", "a.md", "content a", "hash1", vecA, "2024-01-01T00:00:00Z");
      store.upsertKnowledge("id2", "b.md", "content b", "hash2", vecB, "2024-01-01T00:00:00Z");
      store.upsertKnowledge("id3", "c.md", "content c", "hash3", vecC, "2024-01-01T00:00:00Z");

      const hits = store.searchKnowledge([1, 0, 0], 2);
      expect(hits).toHaveLength(2);
      expect(hits[0].path).toBe("a.md");
      expect(hits[0].score).toBe(1);
      expect(hits[1].path).toBe("b.md");
      expect(hits[1].score).toBeGreaterThan(0.9);
    });

    it("deleteKnowledgeByPath removes document", () => {
      const store = createVectorStore(db);
      store.upsertKnowledge("id1", "x.md", "x", "h1", [1, 0], "2024-01-01T00:00:00Z");
      expect(store.getAllKnowledgePaths()).toContain("x.md");
      store.deleteKnowledgeByPath("x.md");
      expect(store.getAllKnowledgePaths()).not.toContain("x.md");
      expect(store.searchKnowledge([1, 0], 5)).toHaveLength(0);
    });

    it("getKnowledgeHash returns stored hash", () => {
      const store = createVectorStore(db);
      store.upsertKnowledge("id1", "p.md", "content", "myhash", [1, 0], "2024-01-01T00:00:00Z");
      expect(store.getKnowledgeHash("p.md")).toBe("myhash");
      expect(store.getKnowledgeHash("missing.md")).toBeNull();
    });
  });

  describe("history", () => {
    it("insertHistory and searchHistory return by similarity", () => {
      const store = createVectorStore(db);
      store.insertHistory("h1", "s1", "e1", "msg one", [1, 0, 0], false, "2024-01-01T00:00:00Z");
      store.insertHistory("h2", "s1", "e2", "msg two", [0, 1, 0], false, "2024-01-01T00:00:00Z");

      const hits = store.searchHistory([1, 0, 0], 5);
      expect(hits).toHaveLength(2);
      expect(hits[0].sessionId).toBe("s1");
      expect(hits[0].entryId).toBe("e1");
      expect(hits[0].score).toBe(1);
    });
  });
});
