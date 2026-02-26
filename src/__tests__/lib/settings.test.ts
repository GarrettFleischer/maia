import { describe, it, expect, beforeEach } from "bun:test";
import { makeTestContext } from "../helpers/fakes";
import { getSettings, getSettingsPublic, updateSettings } from "@/lib/settings";
import { credentialGet } from "@/lib/security/credential-vault";
import type { AppContext } from "@/lib/context";

describe("settings", () => {
  let ctx: AppContext;

  beforeEach(() => {
    ctx = makeTestContext();
  });

  describe("getSettings", () => {
    it("returns seeded default values", () => {
      const s = getSettings(ctx);
      expect(s.heartbeatIntervalMinutes).toBe(30);
      expect(s.ollamaBaseUrl).toBe("http://localhost:11434");
      expect(s.vllmBaseUrl).toBe("http://localhost:8000/v1");
      expect(s.dockerBaseUrl).toBe("http://localhost:8000/v1");
      expect(s.whitelistedModels).toContain("ollama/llama3.2");
      expect(s.ollamaApiKey).toBeUndefined();
      expect(s.openRouterApiKey).toBeUndefined();
      expect(s.contextQueryModel).toBe("");
      expect(s.contextRecentTurns).toBe(3);
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
      expect(s.embedMaxContentLength).toBe(4000);
    });
  });

  describe("getSettingsPublic", () => {
    it("does not expose the raw openRouterApiKey, ollamaApiKey, braveSearchApiKey, or braveAnswersApiKey", () => {
      const pub = getSettingsPublic(ctx);
      expect("openRouterApiKey" in pub).toBe(false);
      expect("ollamaApiKey" in pub).toBe(false);
      expect("braveSearchApiKey" in pub).toBe(false);
      expect("braveAnswersApiKey" in pub).toBe(false);
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

    it("exposes hasBraveKey = false when no Brave credential in vault", () => {
      const pub = getSettingsPublic(ctx);
      expect(pub.hasBraveKey).toBe(false);
    });

    it("exposes hasBraveKey = true after setting braveSearchApiKey (stored in vault)", () => {
      updateSettings(ctx, { braveSearchApiKey: "brave-secret-key" });
      const pub = getSettingsPublic(ctx);
      expect(pub.hasBraveKey).toBe(true);
      expect(credentialGet(ctx, "BRAVE_SEARCH_API_KEY")).toBe("brave-secret-key");
    });

    it("exposes hasBraveAnswersKey = false when no Brave Answers credential in vault", () => {
      const pub = getSettingsPublic(ctx);
      expect(pub.hasBraveAnswersKey).toBe(false);
    });

    it("exposes hasBraveAnswersKey = true after setting braveAnswersApiKey (stored in vault)", () => {
      updateSettings(ctx, { braveAnswersApiKey: "brave-answers-secret" });
      const pub = getSettingsPublic(ctx);
      expect(pub.hasBraveAnswersKey).toBe(true);
      expect(credentialGet(ctx, "BRAVE_ANSWERS_API_KEY")).toBe("brave-answers-secret");
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
      updateSettings(ctx, { contextQueryModel: "ollama/llama3.2" });
      expect(getSettings(ctx).ollamaBaseUrl).toBe(before);
      expect(getSettings(ctx).contextQueryModel).toBe("ollama/llama3.2");
    });

    it("stores and retrieves the ollamaApiKey internally", () => {
      updateSettings(ctx, { ollamaApiKey: "ollama-secret" });
      expect(getSettings(ctx).ollamaApiKey).toBe("ollama-secret");
    });

    it("stores and retrieves the openRouterApiKey internally", () => {
      updateSettings(ctx, { openRouterApiKey: "sk-secret" });
      expect(getSettings(ctx).openRouterApiKey).toBe("sk-secret");
    });

    it("stores braveSearchApiKey in encrypted vault and hasBraveKey is true", () => {
      updateSettings(ctx, { braveSearchApiKey: "brave-vault-key" });
      expect(credentialGet(ctx, "BRAVE_SEARCH_API_KEY")).toBe("brave-vault-key");
      expect(getSettingsPublic(ctx).hasBraveKey).toBe(true);
    });

    it("stores braveAnswersApiKey in encrypted vault and hasBraveAnswersKey is true", () => {
      updateSettings(ctx, { braveAnswersApiKey: "brave-answers-vault-key" });
      expect(credentialGet(ctx, "BRAVE_ANSWERS_API_KEY")).toBe("brave-answers-vault-key");
      expect(getSettingsPublic(ctx).hasBraveAnswersKey).toBe(true);
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

    it("updates embedMaxContentLength and persists", () => {
      updateSettings(ctx, { embedMaxContentLength: 6000 });
      expect(getSettings(ctx).embedMaxContentLength).toBe(6000);
      expect(getSettingsPublic(ctx).embedMaxContentLength).toBe(6000);
    });

    it("clamps embedMaxContentLength to 500–32000", () => {
      updateSettings(ctx, { embedMaxContentLength: 100 });
      expect(getSettings(ctx).embedMaxContentLength).toBe(500);
      updateSettings(ctx, { embedMaxContentLength: 50000 });
      expect(getSettings(ctx).embedMaxContentLength).toBe(32000);
    });
  });
});
