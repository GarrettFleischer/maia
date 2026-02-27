/**
 * @fileoverview Tests for GET /api/model-capabilities.
 * @module __tests__/app/api/model-capabilities/route.test
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { _setTestContext } from "@/instrumentation";
import { makeTestContext, FakeResponse } from "@/__tests__/helpers/fakes";
import { GET } from "@/app/api/model-capabilities/route";
import { updateSettings } from "@/lib/settings";
import type { ModelCapabilities } from "@/lib/types";

describe("GET /api/model-capabilities", () => {
  beforeEach(() => {
    _setTestContext(makeTestContext());
  });

  it("returns capabilities for all whitelisted models and flags embedding models as not supporting reasoning", async () => {
    const ctx = makeTestContext();
    // Simulate Ollama thinking models page so the API can infer support.
    const thinkingHtml = `
      <a href="/library/llama3.2">Llama 3.2 Thinking</a>
      <a href="/library/gpt-oss">gpt-oss</a>
    `;
    ctx.http.on("https://ollama.com/search?c=thinking", async () => new FakeResponse(200, thinkingHtml));
    updateSettings(ctx, {
      whitelistedModels: [
        "ollama/llama3.2",
        "ollama/qwen3-embedding:8b",
        "openrouter/anthropic/claude-3.5-sonnet",
      ],
    });
    _setTestContext(ctx);

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json() as {
      modelCapabilities: Record<string, ModelCapabilities>;
    };

    const llamaCaps = body.modelCapabilities["ollama/llama3.2"];
    expect(llamaCaps).toBeDefined();
    expect(llamaCaps.provider).toBe("ollama");
    expect(llamaCaps.supportsReasoning).toBe(true);

    const qwenEmbedCaps = body.modelCapabilities["ollama/qwen3-embedding:8b"];
    expect(qwenEmbedCaps).toBeDefined();
    expect(qwenEmbedCaps.provider).toBe("ollama");
    expect(qwenEmbedCaps.supportsReasoning).toBe(false);

    const claudeCaps = body.modelCapabilities["openrouter/anthropic/claude-3.5-sonnet"];
    expect(claudeCaps).toBeDefined();
    expect(claudeCaps.provider).toBe("openrouter");
  });
});

