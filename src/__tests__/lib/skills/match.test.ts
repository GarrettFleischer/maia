/**
 * @fileoverview Tests for semantic skill matching: matchSkillsToMessage and getMatchedSkillsContent.
 * @module __tests__/lib/skills/match
 */
import { describe, it, expect } from "bun:test";
import type { SkillMetadata } from "@/lib/skills";
import { matchSkillsToMessage } from "@/lib/skills/match";
import type { EmbeddingAdapter } from "@/lib/knowledge/embedding";

const meta = (name: string, description: string, sourcePath: string): SkillMetadata => ({
  name,
  description,
  sourcePath,
});

describe("matchSkillsToMessage", () => {
  it("returns skills ordered by similarity (highest first)", async () => {
    const skills = [
      meta("commit", "Commit changes with conventional commits", "/skills/commit.md"),
      meta("review", "Review pull requests and give feedback", "/skills/review.md"),
      meta("deploy", "Deploy to production", "/skills/deploy.md"),
    ];
    const queryEmbedding = [1, 0, 0];
    const skillEmbeddings = [
      [0.9, 0.1, 0],
      [0.2, 0.8, 0],
      [1, 0, 0],
    ];
    const embedder: EmbeddingAdapter = {
      embed: async (text) => {
        if (text.includes("deploy") && text.includes("app")) return queryEmbedding;
        if (text.includes("commit") || text.includes("Commit")) return skillEmbeddings[0];
        if (text.includes("review") || text.includes("Review")) return skillEmbeddings[1];
        if (text.includes("deploy") || text.includes("Deploy")) return skillEmbeddings[2];
        return queryEmbedding;
      },
      embedBatch: async (texts) => {
        return Promise.all(texts.map((t) => embedder.embed(t)));
      },
    };
    const ctx = {} as import("@/lib/context").AppContext;
    const result = await matchSkillsToMessage(ctx, skills, "I need to deploy the app", {
      topK: 2,
      embedder,
    });
    expect(result.length).toBe(2);
    expect(result[0].name).toBe("deploy");
    expect(result[1].name).toBe("commit");
  });

  it("respects topK", async () => {
    const skills = [
      meta("a", "First", "/a.md"),
      meta("b", "Second", "/b.md"),
      meta("c", "Third", "/c.md"),
    ];
    const embedder: EmbeddingAdapter = {
      embed: async () => [1, 0, 0],
      embedBatch: async (texts) => texts.map(() => [1, 0, 0]),
    };
    const ctx = {} as import("@/lib/context").AppContext;
    const result = await matchSkillsToMessage(ctx, skills, "query", { topK: 1, embedder });
    expect(result.length).toBe(1);
  });

  it("respects minScore and filters out low similarity", async () => {
    const skills = [
      meta("high", "Matches well", "/high.md"),
      meta("low", "Does not match", "/low.md"),
    ];
    const embedder: EmbeddingAdapter = {
      embed: async () => [1, 0, 0],
      embedBatch: async (texts) => {
        return texts.map((t) => (t.includes("Matches") || t.includes("high") ? [1, 0, 0] : [0, 1, 0]));
      },
    };
    const ctx = {} as import("@/lib/context").AppContext;
    const result = await matchSkillsToMessage(ctx, skills, "query", {
      topK: 10,
      minScore: 0.5,
      embedder,
    });
    expect(result.length).toBe(1);
    expect(result[0].name).toBe("high");
  });

  it("returns empty array when embedder throws", async () => {
    const skills = [meta("x", "Y", "/x.md")];
    const embedder: EmbeddingAdapter = {
      embed: async () => {
        throw new Error("Embed failed");
      },
      embedBatch: async () => {
        throw new Error("Embed failed");
      },
    };
    const ctx = {} as import("@/lib/context").AppContext;
    const result = await matchSkillsToMessage(ctx, skills, "query", { embedder });
    expect(result).toEqual([]);
  });

  it("returns empty array when metadata is empty", async () => {
    const embedder: EmbeddingAdapter = {
      embed: async () => [1, 0, 0],
      embedBatch: async () => [],
    };
    const ctx = {} as import("@/lib/context").AppContext;
    const result = await matchSkillsToMessage(ctx, [], "query", { embedder });
    expect(result).toEqual([]);
  });
});
