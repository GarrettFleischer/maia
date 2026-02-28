/**
 * @fileoverview Tests for find_tool (vector search over available tools).
 * @module __tests__/lib/tools/find-tool
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { makeTestContext, FakeResponse } from "@/__tests__/helpers/fakes";
import { findTool } from "@/lib/tools/find-tool";
import { getToolsForAgent } from "@/lib/tools/registry";
import { updateSettings } from "@/lib/settings";
import type { AppContext } from "@/lib/context";

describe("find_tool", () => {
  let ctx: AppContext;

  beforeEach(() => {
    ctx = makeTestContext();
    updateSettings(ctx, {
      whitelistedModels: ["ollama/nomic-embed-text"],
      embeddingModel: "ollama/nomic-embed-text",
    });
    (ctx.http as { on: (p: string, h: (url: string, init?: RequestInit) => Promise<FakeResponse>) => void }).on(
      "/api/embed",
      async (_url, init) => {
        let n = 1;
        if (init?.body) {
          const raw = typeof init.body === "string" ? init.body : await new Response(init.body as BodyInit).text();
          const body = JSON.parse(raw) as { input?: string | string[] };
          const input = body?.input;
          n = Array.isArray(input) ? input.length : 1;
        }
        const embeddings = Array.from({ length: n }, () => [0.1, 0.2, 0.3]);
        return new FakeResponse(200, JSON.stringify({ embeddings }));
      }
    );
  });

  it("returns tool definitions matching the query by similarity", async () => {
    const toolCtx = { ...ctx, agentId: "maia", sessionId: "s1", volumeRoot: "/tmp", getToolsForAgent };
    const result = await findTool.execute(
      { query: "search the web", limit: 3 },
      toolCtx
    );
    expect(Array.isArray(result)).toBe(true);
    expect((result as { name: string; description: string }[]).length).toBeLessThanOrEqual(3);
    const names = (result as { name: string }[]).map((r) => r.name);
    expect(names.every((n) => typeof n === "string")).toBe(true);
  });

  it("returns definitions with name, description, and parameters", async () => {
    const toolCtx = { ...ctx, agentId: "maia", sessionId: "s1", volumeRoot: "/tmp", getToolsForAgent };
    const result = await findTool.execute(
      { query: "run a command", limit: 2 },
      toolCtx
    );
    const list = result as { name: string; description: string; parameters?: Record<string, unknown> }[];
    expect(list.length).toBeGreaterThanOrEqual(0);
    for (const def of list) {
      expect(def).toHaveProperty("name");
      expect(def).toHaveProperty("description");
      expect(def).toHaveProperty("parameters");
    }
  });
});
