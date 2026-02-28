import * as fs from "fs";
import * as path from "path";
import { describe, it, expect, beforeEach } from "bun:test";
import { makeTestContext } from "../helpers/fakes";
import { getSettings, getSettingsPublic, updateSettings } from "@/lib/settings";
import { getModelsJsonPath } from "@/lib/models-config";
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
      expect(s.contextReasoningEffort).toBe("medium");
      expect(s.whitelistedModels).toContain("ollama/nomic-embed-text");
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
      expect(s.embeddingModel).toBe("ollama/nomic-embed-text");
      expect(s.embedMaxContentLength).toBe(4000);
    });

    it("returns modelParams as empty object when missing", () => {
      const dataPath = getModelsJsonPath();
      fs.mkdirSync(path.dirname(dataPath), { recursive: true });
      fs.writeFileSync(
        dataPath,
        JSON.stringify([{ provider: "ollama", name: "nomic-embed-text" }]),
        "utf-8"
      );
      const s = getSettings(ctx);
      expect(s.modelParams).toEqual({});
    });

    it("parses modelParams when set (from models.json)", () => {
      updateSettings(ctx, {
        whitelistedModels: ["ollama/llama3.2"],
        modelParams: { "ollama/llama3.2": { temperature: 0.6, top_p: 0.95 } },
      });
      const s = getSettings(ctx);
      expect(s.modelParams).toEqual({
        "ollama/llama3.2": { temperature: 0.6, top_p: 0.95 },
      });
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

    it("includes contextReasoningEffort in public settings", () => {
      const pub = getSettingsPublic(ctx);
      expect(pub.contextReasoningEffort).toBe("medium");
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

    it("updates embeddingModel when model is in whitelist", () => {
      updateSettings(ctx, { whitelistedModels: ["ollama/nomic-embed-text-v2"], embeddingModel: "ollama/nomic-embed-text-v2" });
      expect(getSettings(ctx).embeddingModel).toBe("ollama/nomic-embed-text-v2");
    });

    it("throws when embeddingModel is not in whitelist", () => {
      updateSettings(ctx, { whitelistedModels: ["ollama/llama3.2"] });
      expect(() =>
        updateSettings(ctx, { embeddingModel: "ollama/nomic-embed-text" })
      ).toThrow(/Embedding model must be in whitelist/);
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

    it("updates contextReasoningEffort", () => {
      updateSettings(ctx, { contextReasoningEffort: "high" });
      expect(getSettings(ctx).contextReasoningEffort).toBe("high");
      expect(getSettingsPublic(ctx).contextReasoningEffort).toBe("high");
    });

    it("persists modelParams only for whitelisted model ids", () => {
      updateSettings(ctx, { whitelistedModels: ["ollama/llama3.2", "openrouter/free"] });
      updateSettings(ctx, {
        modelParams: {
          "ollama/llama3.2": { temperature: 0.6, top_p: 0.95 },
          "openrouter/free": { temperature: 0.7 },
          "ollama/not-whitelisted": { temperature: 0.5 },
        },
      });
      const s = getSettings(ctx);
      expect(s.modelParams["ollama/llama3.2"]).toEqual({ temperature: 0.6, top_p: 0.95 });
      expect(s.modelParams["openrouter/free"]).toEqual({ temperature: 0.7 });
      expect(s.modelParams["ollama/not-whitelisted"]).toBeUndefined();
    });

    it("getSettingsPublic includes modelParams", () => {
      updateSettings(ctx, { whitelistedModels: ["ollama/llama3.2"] });
      updateSettings(ctx, { modelParams: { "ollama/llama3.2": { temperature: 0.6 } } });
      const pub = getSettingsPublic(ctx);
      expect(pub.modelParams).toEqual({ "ollama/llama3.2": { temperature: 0.6 } });
    });
  });
});
