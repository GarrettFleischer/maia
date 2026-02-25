import { describe, it, expect, beforeEach } from "bun:test";
import { makeTestContext } from "../helpers/fakes";
import { getSettings, getSettingsPublic, updateSettings } from "@/lib/settings";
import type { AppContext } from "@/lib/context";

describe("settings", () => {
  let ctx: AppContext;

  beforeEach(() => {
    ctx = makeTestContext();
  });

  describe("getSettings", () => {
    it("returns seeded default values", () => {
      const s = getSettings(ctx);
      expect(s.compressionModel).toBe("ollama/llama3.2");
      expect(s.heartbeatIntervalMinutes).toBe(30);
      expect(s.ollamaBaseUrl).toBe("http://localhost:11434");
      expect(s.vllmBaseUrl).toBe("http://localhost:8000/v1");
      expect(s.dockerBaseUrl).toBe("http://localhost:8000/v1");
      expect(s.whitelistedModels).toContain("ollama/llama3.2");
      expect(s.ollamaApiKey).toBeUndefined();
      expect(s.openRouterApiKey).toBeUndefined();
    });

    it("parses whitelistedModels as an array", () => {
      const s = getSettings(ctx);
      expect(Array.isArray(s.whitelistedModels)).toBe(true);
      expect(s.whitelistedModels.length).toBeGreaterThan(0);
    });

    it("returns openRouterApiKey as undefined when empty string in DB", () => {
      const s = getSettings(ctx);
      expect(s.openRouterApiKey).toBeUndefined();
      expect(s.embeddingModel).toBe("nomic-embed-text");
    });
  });

  describe("getSettingsPublic", () => {
    it("does not expose the raw openRouterApiKey or ollamaApiKey", () => {
      const pub = getSettingsPublic(ctx);
      expect("openRouterApiKey" in pub).toBe(false);
      expect("ollamaApiKey" in pub).toBe(false);
    });

    it("exposes hasOllamaKey = false when no key is set", () => {
      const pub = getSettingsPublic(ctx);
      expect(pub.hasOllamaKey).toBe(false);
    });

    it("exposes hasOllamaKey = true after setting ollamaApiKey", () => {
      updateSettings(ctx, { ollamaApiKey: "ollama-cloud-key" });
      const pub = getSettingsPublic(ctx);
      expect(pub.hasOllamaKey).toBe(true);
    });

    it("exposes hasOpenRouterKey = false when no key is set", () => {
      const pub = getSettingsPublic(ctx);
      expect(pub.hasOpenRouterKey).toBe(false);
    });

    it("exposes hasOpenRouterKey = true after setting a key", () => {
      updateSettings(ctx, { openRouterApiKey: "sk-test-key" });
      const pub = getSettingsPublic(ctx);
      expect(pub.hasOpenRouterKey).toBe(true);
    });

    it("includes vllmBaseUrl in public settings", () => {
      const pub = getSettingsPublic(ctx);
      expect(pub.vllmBaseUrl).toBe("http://localhost:8000/v1");
    });

    it("includes dockerBaseUrl in public settings", () => {
      const pub = getSettingsPublic(ctx);
      expect(pub.dockerBaseUrl).toBe("http://localhost:8000/v1");
    });
  });

  describe("updateSettings", () => {
    it("updates compressionModel", () => {
      updateSettings(ctx, { compressionModel: "ollama/qwen2.5-coder" });
      expect(getSettings(ctx).compressionModel).toBe("ollama/qwen2.5-coder");
    });

    it("updates heartbeatIntervalMinutes", () => {
      updateSettings(ctx, { heartbeatIntervalMinutes: 60 });
      expect(getSettings(ctx).heartbeatIntervalMinutes).toBe(60);
    });

    it("updates ollamaBaseUrl", () => {
      updateSettings(ctx, { ollamaBaseUrl: "http://my-ollama:11434" });
      expect(getSettings(ctx).ollamaBaseUrl).toBe("http://my-ollama:11434");
    });

    it("updates whitelistedModels", () => {
      updateSettings(ctx, { whitelistedModels: ["ollama/llama3.2"] });
      expect(getSettings(ctx).whitelistedModels).toEqual(["ollama/llama3.2"]);
    });

    it("only updates keys that are provided", () => {
      const before = getSettings(ctx).ollamaBaseUrl;
      updateSettings(ctx, { compressionModel: "ollama/qwen2.5-coder" });
      expect(getSettings(ctx).ollamaBaseUrl).toBe(before);
    });

    it("stores and retrieves the ollamaApiKey internally", () => {
      updateSettings(ctx, { ollamaApiKey: "ollama-secret" });
      expect(getSettings(ctx).ollamaApiKey).toBe("ollama-secret");
    });

    it("stores and retrieves the openRouterApiKey internally", () => {
      updateSettings(ctx, { openRouterApiKey: "sk-secret" });
      expect(getSettings(ctx).openRouterApiKey).toBe("sk-secret");
    });

    it("updates embeddingModel", () => {
      updateSettings(ctx, { embeddingModel: "nomic-embed-text-v2" });
      expect(getSettings(ctx).embeddingModel).toBe("nomic-embed-text-v2");
    });

    it("updates vllmBaseUrl", () => {
      updateSettings(ctx, { vllmBaseUrl: "http://vllm:8000/v1" });
      expect(getSettings(ctx).vllmBaseUrl).toBe("http://vllm:8000/v1");
    });

    it("updates dockerBaseUrl", () => {
      updateSettings(ctx, { dockerBaseUrl: "http://docker-host:8000/v1" });
      expect(getSettings(ctx).dockerBaseUrl).toBe("http://docker-host:8000/v1");
    });
  });
});
