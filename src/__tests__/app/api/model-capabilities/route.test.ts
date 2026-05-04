/**
 * @fileoverview Tests for GET /api/model-capabilities.
 * @module __tests__/app/api/model-capabilities/route.test
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { _setTestContext } from "@/instrumentation";
import { makeTestContext, FakeResponse } from "@/__tests__/helpers/fakes";
import { _clearOllamaShowCapabilityCacheForTests } from "@/lib/ai/model-capabilities";
import { GET } from "@/app/api/model-capabilities/route";
import { updateSettings } from "@/lib/settings";
import type { ModelCapabilities } from "@/lib/types";

describe("GET /api/model-capabilities", () => {
  beforeEach(() => {
    _setTestContext(makeTestContext());
    _clearOllamaShowCapabilityCacheForTests();
  });

  it("returns capabilities for all whitelisted models from Ollama /api/show when baseUrl is set", async () => {
    const ctx = makeTestContext();
    ctx.http.on("/api/show", async (_url, init) => {
      const body = init?.body as string | undefined;
      const parsed = body ? (JSON.parse(body) as { model?: string }) : {};
      const model = parsed.model ?? "";
      const capabilities: string[] = [];
      if (model === "llama3.2") {
        capabilities.push("completion", "thinking", "tools");
      } else if (model === "qwen3-embedding:8b") {
        capabilities.push("completion", "embedding");
      }
      return new FakeResponse(200, JSON.stringify({ capabilities }));
    });
    updateSettings(ctx, {
      ollamaBaseUrl: "http://localhost:11434",
      whitelistedModels: [
        "ollama/llama3.2",
        "ollama/qwen3-embedding:8b",
        "openrouter/anthropic/claude-3.5-sonnet",
      ],
    });
    _setTestContext(ctx);

    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      modelCapabilities: Record<string, ModelCapabilities>;
    };

    const llamaCaps = body.modelCapabilities["ollama/llama3.2"];
    expect(llamaCaps).toBeDefined();
    expect(llamaCaps.provider).toBe("ollama");
    expect(llamaCaps.supportsReasoning).toBe(true);
    expect(llamaCaps.supportsTools).toBe(true);

    const qwenEmbedCaps = body.modelCapabilities["ollama/qwen3-embedding:8b"];
    expect(qwenEmbedCaps).toBeDefined();
    expect(qwenEmbedCaps.provider).toBe("ollama");
    expect(qwenEmbedCaps.supportsReasoning).toBe(false);
    expect(qwenEmbedCaps.supportsTools).toBe(false);

    const claudeCaps =
      body.modelCapabilities["openrouter/anthropic/claude-3.5-sonnet"];
    expect(claudeCaps).toBeDefined();
    expect(claudeCaps.provider).toBe("openrouter");
    expect(claudeCaps.supportsReasoning).toBe(true);
    expect(claudeCaps.supportsTools).toBe(true);
  });

  it("returns undefined reasoning/tools when no ollama baseUrl (no data source)", async () => {
    const ctx = makeTestContext();
    updateSettings(ctx, {
      ollamaBaseUrl: "",
      whitelistedModels: [
        "ollama/llama3.2",
        "ollama/qwen3-embedding:8b",
        "openrouter/anthropic/claude-3.5-sonnet",
      ],
    });
    _setTestContext(ctx);

    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      modelCapabilities: Record<string, ModelCapabilities>;
    };

    const llamaCaps = body.modelCapabilities["ollama/llama3.2"];
    expect(llamaCaps).toBeDefined();
    expect(llamaCaps.provider).toBe("ollama");
    expect(llamaCaps.supportsReasoning).toBeUndefined();
    expect(llamaCaps.supportsTools).toBeUndefined();

    const qwenEmbedCaps = body.modelCapabilities["ollama/qwen3-embedding:8b"];
    expect(qwenEmbedCaps).toBeDefined();
    expect(qwenEmbedCaps.provider).toBe("ollama");
    expect(qwenEmbedCaps.supportsReasoning).toBeUndefined();
    expect(qwenEmbedCaps.supportsTools).toBeUndefined();

    const claudeCaps =
      body.modelCapabilities["openrouter/anthropic/claude-3.5-sonnet"];
    expect(claudeCaps).toBeDefined();
    expect(claudeCaps.supportsReasoning).toBe(true);
    expect(claudeCaps.supportsTools).toBe(true);
  });

  it("returns undefined reasoning/tools when Ollama /api/show fails (e.g. model not installed)", async () => {
    const ctx = makeTestContext();
    ctx.http.on("/api/show", async () => new FakeResponse(500, "error"));
    updateSettings(ctx, {
      ollamaBaseUrl: "http://localhost:11434",
      whitelistedModels: ["ollama/llama3.2"],
    });
    _setTestContext(ctx);

    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      modelCapabilities: Record<string, ModelCapabilities>;
    };
    const caps = body.modelCapabilities["ollama/llama3.2"];
    expect(caps).toBeDefined();
    expect(caps.provider).toBe("ollama");
    expect(caps.supportsReasoning).toBeUndefined();
    expect(caps.supportsTools).toBeUndefined();
  });

  it("treats known reasoning model names as supporting reasoning when Ollama does not report thinking", async () => {
    const ctx = makeTestContext();
    const qwenUnsloth = "hf.co/unsloth/Qwen3.5-4B-GGUF:UD-Q4_K_XL";
    ctx.http.on("/api/show", async (_url, init) => {
      const body = init?.body as string | undefined;
      const parsed = body ? (JSON.parse(body) as { model?: string }) : {};
      const model = parsed.model ?? "";
      const capabilities: string[] = ["completion", "tools"];
      if (model === qwenUnsloth) {
        return new FakeResponse(200, JSON.stringify({ capabilities }));
      }
      return new FakeResponse(404, "not found");
    });
    updateSettings(ctx, {
      ollamaBaseUrl: "http://localhost:11434",
      whitelistedModels: [`ollama/${qwenUnsloth}`],
    });
    _setTestContext(ctx);

    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      modelCapabilities: Record<string, ModelCapabilities>;
    };
    const caps = body.modelCapabilities[`ollama/${qwenUnsloth}`];
    expect(caps).toBeDefined();
    expect(caps.provider).toBe("ollama");
    expect(caps.supportsReasoning).toBe(true);
    expect(caps.supportsTools).toBe(true);
  });
});
