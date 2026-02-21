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
      expect(s.whitelistedModels).toContain("ollama/llama3.2");
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
    });
  });

  describe("getSettingsPublic", () => {
    it("does not expose the raw openRouterApiKey", () => {
      const pub = getSettingsPublic(ctx);
      expect("openRouterApiKey" in pub).toBe(false);
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

    it("stores and retrieves the openRouterApiKey internally", () => {
      updateSettings(ctx, { openRouterApiKey: "sk-secret" });
      expect(getSettings(ctx).openRouterApiKey).toBe("sk-secret");
    });
  });
});
