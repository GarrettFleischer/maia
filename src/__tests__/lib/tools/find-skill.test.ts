/**
 * @fileoverview Tests for find_skill (vector search over available skills).
 * @module __tests__/lib/tools/find-skill
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import path from "path";
import os from "os";
import {
  makeTestContext,
  FakeFs,
  FakeResponse,
} from "@/__tests__/helpers/fakes";
import { findSkill } from "@/lib/tools/find-skill";
import { updateSettings } from "@/lib/settings";
import { getSkillsDir, getAgentSkillsDir } from "@/lib/data-dir";
import type { AppContext } from "@/lib/context";

const skillContent = `---
name: memory-basics
description: Save and recall facts using memory tools.
---

# Memory
Use memory to store important facts.
`;

describe("find_skill", () => {
  let ctx: AppContext;
  let tmpDir: string;
  let origMaiaDataDir: string | undefined;

  beforeEach(() => {
    origMaiaDataDir = process.env.MAIA_DATA_DIR;
    tmpDir = path.join(os.tmpdir(), `maia-find-skill-${Date.now()}`);
    process.env.MAIA_DATA_DIR = tmpDir;
    ctx = makeTestContext();
    const skillsDir = getSkillsDir();
    const agentSkillsDir = getAgentSkillsDir("maia");
    (ctx.fs as FakeFs).seed(
      path.join(skillsDir, "memory-basics.md"),
      skillContent,
    );
    (ctx.fs as FakeFs).seed(
      path.join(agentSkillsDir, "custom.md"),
      `---
name: custom-skill
description: Agent-specific guidance.
---

Custom body
`,
    );
    updateSettings(ctx, {
      whitelistedModels: ["ollama/nomic-embed-text"],
      embeddingModel: "ollama/nomic-embed-text",
    });
    (
      ctx.http as {
        on: (
          p: string,
          h: (url: string, init?: RequestInit) => Promise<FakeResponse>,
        ) => void;
      }
    ).on("/api/embed", async (_url, init) => {
      let n = 1;
      if (init?.body) {
        const raw =
          typeof init.body === "string"
            ? init.body
            : await new Response(init.body as BodyInit).text();
        const body = JSON.parse(raw) as { input?: string | string[] };
        const input = body?.input;
        n = Array.isArray(input) ? input.length : 1;
      }
      const embeddings = Array.from({ length: n }, () => [0.1, 0.2, 0.3]);
      return new FakeResponse(200, JSON.stringify({ embeddings }));
    });
  });

  afterEach(() => {
    if (origMaiaDataDir !== undefined) {
      process.env.MAIA_DATA_DIR = origMaiaDataDir;
    } else {
      delete process.env.MAIA_DATA_DIR;
    }
  });

  it("returns skills matching the query with name, description, and content", async () => {
    const toolCtx = {
      ...ctx,
      agentId: "maia",
      sessionId: "s1",
      volumeRoot: "/tmp",
    };
    const result = await findSkill.execute(
      { q: "how to save memories", limit: 5 },
      toolCtx,
    );
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThanOrEqual(1);
    for (const skill of result) {
      expect(skill).toHaveProperty("name");
      expect(skill).toHaveProperty("description");
      expect(skill).toHaveProperty("content");
      expect(typeof skill.name).toBe("string");
      expect(typeof skill.description).toBe("string");
      expect(typeof skill.content).toBe("string");
    }
    const names = result.map((r) => r.name);
    expect(names).toContain("memory-basics");
    const memorySkill = result.find((s) => s.name === "memory-basics");
    expect(memorySkill?.content).toContain(
      "Use memory to store important facts.",
    );
  });

  it("respects limit parameter", async () => {
    const toolCtx = {
      ...ctx,
      agentId: "maia",
      sessionId: "s1",
      volumeRoot: "/tmp",
    };
    const result = await findSkill.execute({ q: "skill", limit: 1 }, toolCtx);
    expect(result.length).toBeLessThanOrEqual(1);
  });

  it("returns empty array when no skills are available", async () => {
    process.env.MAIA_DATA_DIR = path.join(
      os.tmpdir(),
      `maia-empty-${Date.now()}`,
    );
    const toolCtx = {
      ...ctx,
      agentId: "other",
      sessionId: "s1",
      volumeRoot: "/tmp",
    };
    const result = await findSkill.execute(
      { q: "anything", limit: 5 },
      toolCtx,
    );
    expect(result).toEqual([]);
  });
});
