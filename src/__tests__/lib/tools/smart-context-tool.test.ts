/**
 * @fileoverview Tests for smart_context tool.
 * @module __tests__/lib/tools/smart-context-tool
 */
import path from "path";
import { describe, it, expect } from "bun:test";
import { makeTestContext, FakeHttp, FakeResponse, FakeFs } from "@/__tests__/helpers/fakes";
import { smartContextTool } from "@/lib/tools/smart-context-tool";
import type { ToolContext } from "@/lib/tools/types";
import { getSkillsDir } from "@/lib/data-dir";
import { updateSettings } from "@/lib/settings";

describe("smart_context tool", () => {
  it("returns block and queries when no providerFactory and embedding fails", async () => {
    const http = new FakeHttp();
    http.on("/api/embed", async () => new FakeResponse(500, "embed error"));

    const ctx = makeTestContext({ http });
    updateSettings(ctx, {
      whitelistedModels: ["ollama/nomic-embed-text"],
      embeddingModel: "ollama/nomic-embed-text",
      contextQueryModel: "",
    });
    const toolCtx: ToolContext = {
      ...ctx,
      agentId: "maia",
      sessionId: "s1",
      volumeRoot: "/tmp/ws",
      providerFactory: undefined,
    };

    const result = await smartContextTool.execute(
      {
        ctx: "user asked about dashboard setup",
        cmd: "find past discussions about dashboard",
      },
      toolCtx,
    );

    expect(result).toHaveProperty("block");
    expect(result).toHaveProperty("queries");
    expect((result as { block: string }).block).toContain("## Smart context");
    expect((result as { block: string }).block).toContain("No relevant prior context found.");
    expect(Array.isArray((result as { queries: string[] }).queries)).toBe(true);
    expect((result as { queries: string[] }).queries.length).toBeGreaterThan(0);
  });

  it("returns block and queries when embedding succeeds but no results", async () => {
    const http = new FakeHttp();
    http.on("/api/embed", async () => new FakeResponse(200, JSON.stringify({ embeddings: [[0.1, 0.2]] })));

    const ctx = makeTestContext({ http });
    updateSettings(ctx, {
      whitelistedModels: ["ollama/nomic-embed-text"],
      embeddingModel: "ollama/nomic-embed-text",
      contextQueryModel: "",
    });
    const toolCtx: ToolContext = {
      ...ctx,
      agentId: "maia",
      sessionId: "s1",
      volumeRoot: "/tmp/ws",
      providerFactory: undefined,
    };

    const result = await smartContextTool.execute(
      {
        ctx: "user asked about dashboard",
        cmd: "find dashboard discussions",
      },
      toolCtx,
    );

    expect(result).toHaveProperty("block");
    expect(result).toHaveProperty("queries");
    expect((result as { block: string }).block).toContain("## Smart context");
  });

  it("includes matched skills content in the smart context block", async () => {
    const fs = new FakeFs();
    const http = new FakeHttp();

    http.on("/api/embed", async (_url, init) => {
      let count = 1;
      if (init && typeof init.body === "string") {
        try {
          const parsed = JSON.parse(init.body) as { input?: string | string[] };
          if (Array.isArray(parsed.input)) {
            count = parsed.input.length;
          } else if (typeof parsed.input === "string") {
            count = 1;
          }
        } catch {
          // Fall back to single embedding
        }
      }
      const embeddings = Array.from({ length: count }, () => [1, 0, 0]);
      return new FakeResponse(200, JSON.stringify({ embeddings }));
    });

    const ctx = makeTestContext({ fs, http });
    updateSettings(ctx, {
      whitelistedModels: ["ollama/llama3.2", "ollama/nomic-embed-text"],
      embeddingModel: "ollama/nomic-embed-text",
      contextQueryModel: "",
    });

    const skillsDir = getSkillsDir();
    const skillPath = path.join(skillsDir, "deploy-app.md");
    fs.seed(
      skillPath,
      `---
name: deploy-app
description: Helps deploy applications.
---

Skill body instructions for deployment.
`,
    );

    const toolCtx: ToolContext = {
      ...ctx,
      agentId: "maia",
      sessionId: "s1",
      volumeRoot: "/tmp/ws",
      providerFactory: undefined,
    };

    const result = await smartContextTool.execute(
      {
        ctx: "We need to deploy this app",
        cmd: "assist with deployment",
      },
      toolCtx,
    );

    const block = (result as { block: string }).block;
    expect(block).toContain("## Smart context");
    expect(block).toContain("## Active skills");
    expect(block).toContain("Skill body instructions for deployment.");
  });
});
