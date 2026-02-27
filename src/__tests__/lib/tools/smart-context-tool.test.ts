/**
 * @fileoverview Tests for smart_context tool.
 * @module __tests__/lib/tools/smart-context-tool
 */
import { describe, it, expect } from "bun:test";
import { makeTestContext, FakeHttp, FakeResponse } from "@/__tests__/helpers/fakes";
import { smartContextTool } from "@/lib/tools/smart-context-tool";
import type { ToolContext } from "@/lib/tools/types";

describe("smart_context tool", () => {
  it("returns block and queries when no providerFactory and embedding fails", async () => {
    const http = new FakeHttp();
    http.on("/api/embed", async () => new FakeResponse(500, "embed error"));

    const ctx = makeTestContext({ http });
    const toolCtx: ToolContext = {
      ...ctx,
      agentId: "maia",
      sessionId: "s1",
      volumeRoot: "/tmp/ws",
      providerFactory: undefined,
    };

    const result = await smartContextTool.execute(
      {
        context: "user asked about dashboard setup",
        command: "find past discussions about dashboard",
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
    const toolCtx: ToolContext = {
      ...ctx,
      agentId: "maia",
      sessionId: "s1",
      volumeRoot: "/tmp/ws",
      providerFactory: undefined,
    };

    const result = await smartContextTool.execute(
      {
        context: "user asked about dashboard",
        command: "find dashboard discussions",
      },
      toolCtx,
    );

    expect(result).toHaveProperty("block");
    expect(result).toHaveProperty("queries");
    expect((result as { block: string }).block).toContain("## Smart context");
  });
});
