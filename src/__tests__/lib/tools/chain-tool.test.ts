/**
 * @fileoverview Tests for chain tool (parse and execute).
 * @module __tests__/lib/tools/chain-tool
 */
import { describe, it, expect } from "bun:test";
import { parseChainExpression } from "@/lib/tools/chain-tool";
import { chainTool } from "@/lib/tools/chain-tool";
import { makeTestContext, FakeResponse } from "@/__tests__/helpers/fakes";
import { getToolsForAgent } from "@/lib/tools/registry";
import { updateSettings } from "@/lib/settings";
import type { ToolContext } from "@/lib/tools/types";

describe("parseChainExpression", () => {
  it("parses two segments with args", () => {
    const expr = 'terminal_exec({"command":"cat x"}).stdout | knowledge_search({"query":"@prev"})';
    const segs = parseChainExpression(expr);
    expect(segs).toHaveLength(2);
    expect(segs[0]?.toolName).toBe("terminal_exec");
    expect(segs[0]?.args).toEqual({ command: "cat x" });
    expect(segs[0]?.property).toBe("stdout");
    expect(segs[1]?.toolName).toBe("knowledge_search");
    expect(segs[1]?.args).toEqual({ query: "@prev" });
  });

  it("parses single segment", () => {
    const segs = parseChainExpression('find_tool({"query":"search"})');
    expect(segs).toHaveLength(1);
    expect(segs[0]?.toolName).toBe("find_tool");
    expect(segs[0]?.args).toEqual({ query: "search" });
  });

  it("returns empty for empty string", () => {
    expect(parseChainExpression("")).toEqual([]);
  });
});

describe("chain tool", () => {
  it("returns error when getToolsForAgent is missing", async () => {
    const ctx = makeTestContext();
    const toolCtx: ToolContext = { ...ctx, agentId: "maia", sessionId: "s1", volumeRoot: "/tmp" };
    const result = await chainTool.execute({ expr: "find_tool({})" }, toolCtx);
    expect(result).toHaveProperty("error", true);
    expect((result as { callStack: string[] }).callStack).toContain("find_tool");
  });

  it("executes single-stage chain when getToolsForAgent is set", async () => {
    const ctx = makeTestContext();
    updateSettings(ctx, { whitelistedModels: ["ollama/nomic-embed-text"], embeddingModel: "ollama/nomic-embed-text" });
    (ctx.http as { on: (p: string, h: (url: string, init?: RequestInit) => Promise<FakeResponse>) => void }).on(
      "/api/embed",
      async (_url, init) => {
        let n = 1;
        if (init?.body) {
          const raw = typeof init.body === "string" ? init.body : await new Response(init.body as BodyInit).text();
          const body = JSON.parse(raw) as { input?: string | string[] };
          n = Array.isArray(body?.input) ? body.input.length : 1;
        }
        return new FakeResponse(200, JSON.stringify({ embeddings: Array.from({ length: n }, () => [0.1, 0.2, 0.3]) }));
      }
    );
    const toolCtx: ToolContext = {
      ...ctx,
      agentId: "maia",
      sessionId: "s1",
      volumeRoot: "/tmp",
      getToolsForAgent,
    };
    const result = await chainTool.execute({
      expr: 'find_tool({"q":"web","limit":2})',
    }, toolCtx);
    expect((result as { error?: boolean }).error).not.toBe(true);
    expect(Array.isArray(result)).toBe(true);
  });
});
