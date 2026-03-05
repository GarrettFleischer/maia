/**
 * @fileoverview Tests for semantic skill matching: matchSkillsToMessage, getMatchedSkillsContent, filterSkillsForAgent.
 * @module __tests__/lib/skills/match
 */
import { describe, it, expect } from "bun:test";
import type { SkillMetadata } from "@/lib/skills";
import {
  matchSkillsToMessage,
  selectSkillsWithModel,
  filterSkillsForAgent,
} from "@/lib/skills/match";
import type { ProviderFactory } from "@/lib/agent/context-query";
import { makeTestContext } from "@/__tests__/helpers/fakes";
import type { EmbeddingAdapter } from "@/lib/knowledge/embedding";

const meta = (
  name: string,
  description: string,
  sourcePath: string,
  scope: "global" | "agent" = "global",
  agentId?: string,
): SkillMetadata => ({
  name,
  description,
  sourcePath,
  scope,
  ...(scope === "agent" && agentId !== undefined ? { agentId } : {}),
});

describe("matchSkillsToMessage", () => {
  it("returns skills ordered by similarity (highest first)", async () => {
    const skills = [
      meta(
        "commit",
        "Commit changes with conventional commits",
        "/skills/commit.md",
      ),
      meta(
        "review",
        "Review pull requests and give feedback",
        "/skills/review.md",
      ),
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
        if (text.includes("deploy") && text.includes("app"))
          return queryEmbedding;
        if (text.includes("commit") || text.includes("Commit"))
          return skillEmbeddings[0];
        if (text.includes("review") || text.includes("Review"))
          return skillEmbeddings[1];
        if (text.includes("deploy") || text.includes("Deploy"))
          return skillEmbeddings[2];
        return queryEmbedding;
      },
      embedBatch: async (texts) => {
        return Promise.all(texts.map((t) => embedder.embed(t)));
      },
    };
    const ctx = {} as import("@/lib/context").AppContext;
    const result = await matchSkillsToMessage(
      ctx,
      skills,
      "I need to deploy the app",
      {
        topK: 2,
        embedder,
      },
    );
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
    const result = await matchSkillsToMessage(ctx, skills, "query", {
      topK: 1,
      embedder,
    });
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
        return texts.map((t) =>
          t.includes("Matches") || t.includes("high") ? [1, 0, 0] : [0, 1, 0],
        );
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
    const result = await matchSkillsToMessage(ctx, skills, "query", {
      embedder,
    });
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

describe("selectSkillsWithModel", () => {
  it("selects skills based on model JSON array of names", async () => {
    const skills = [
      meta(
        "commit-changes",
        "Commit changes with conventional commit messages.",
        "/skills/commit.md",
      ),
      meta(
        "deploy-app",
        "Deploy applications to production.",
        "/skills/deploy.md",
      ),
    ];
    const ctx = makeTestContext();
    const { updateSettings } = await import("@/lib/settings");
    updateSettings(ctx, {
      whitelistedModels: ["ollama/llama3.2"],
      contextQueryModel: "ollama/llama3.2",
    });
    const providerFactory: ProviderFactory = () => ({
      async complete(_messages, _tools, onToken) {
        const out = '["deploy-app"]';
        onToken(out);
        return { content: out, toolCalls: [], stopped: true };
      },
    });
    const result = await selectSkillsWithModel(
      ctx,
      "Please deploy the app",
      skills,
      providerFactory,
    );
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("deploy-app");
  });
});

describe("filterSkillsForAgent", () => {
  it("keeps global skills and current agent's agent-scoped skills only", () => {
    const globalSkill: SkillMetadata = {
      name: "global-skill",
      description: "For everyone",
      sourcePath: "/data/skills/global-skill.md",
      scope: "global",
    };
    const agentASkill: SkillMetadata = {
      name: "agent-a-skill",
      description: "For A",
      sourcePath: "/data/agents/agent-a/skills/a.md",
      scope: "agent",
      agentId: "agent-a",
    };
    const agentBSkill: SkillMetadata = {
      name: "agent-b-skill",
      description: "For B",
      sourcePath: "/data/agents/agent-b/skills/b.md",
      scope: "agent",
      agentId: "agent-b",
    };
    const metadata = [globalSkill, agentASkill, agentBSkill];
    const filtered = filterSkillsForAgent(metadata, "agent-a");
    expect(filtered).toHaveLength(2);
    expect(filtered.map((s) => s.name).sort()).toEqual([
      "agent-a-skill",
      "global-skill",
    ]);
    expect(filtered).not.toContainEqual(
      expect.objectContaining({ name: "agent-b-skill" }),
    );
  });

  it("keeps agent-scoped skill when agentId matches current agent", () => {
    const skill: SkillMetadata = {
      name: "agent-skill",
      description: "Agent skill",
      sourcePath: "/data/agents/maia/skills/foo.md",
      scope: "agent",
      agentId: "maia",
    };
    const filtered = filterSkillsForAgent([skill], "maia");
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.name).toBe("agent-skill");
  });
});
