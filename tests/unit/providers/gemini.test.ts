/**
 * @fileoverview Unit tests for the Google Gemini LLM provider adapter.
 * @module tests/unit/providers/gemini
 */

import { describe, it, expect } from "bun:test";
import { createGeminiProvider } from "../../../src/providers/gemini.js";
import { capturingLogger, mockHttpClient, mockCredentialStore } from "../../helpers/index.js";
import type { HttpResponse } from "../../../src/core/types.js";

describe("GeminiProvider", () => {
  function setup(responses?: Map<string, HttpResponse>) {
    const logger = capturingLogger();
    const http = mockHttpClient(responses);
    const credentials = mockCredentialStore({ "gemini-key": "AIza_test_key" });
    const provider = createGeminiProvider({
      http,
      credentials,
      logger,
      credentialName: "gemini-key",
      model: "gemini-1.5-flash",
    });
    return { provider, http, logger, credentials };
  }

  // ── Identity ─────────────────────────────────────────────────────

  it("should have id 'gemini' and name 'Gemini'", () => {
    const { provider } = setup();
    expect(provider.id).toBe("gemini");
    expect(provider.name).toBe("Gemini");
  });

  // ── Chat ─────────────────────────────────────────────────────────

  it("should parse Gemini generateContent response", async () => {
    const body = JSON.stringify({
      candidates: [{
        content: {
          parts: [{ text: "Hello! I'm Gemini." }],
        },
      }],
    });

    const { provider } = setup(new Map([
      ["https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent", {
        status: 200, headers: {}, body, ok: true,
      }],
    ]));

    const chunks: string[] = [];
    for await (const chunk of provider.chat([
      { role: "user", content: "Hi" },
    ])) {
      chunks.push(chunk.content);
    }
    expect(chunks.join("")).toBe("Hello! I'm Gemini.");
  });

  it("should convert system messages into user prompt prefix", async () => {
    const body = JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] } }] });
    const { provider, http } = setup(new Map([
      ["https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent", {
        status: 200, headers: {}, body, ok: true,
      }],
    ]));

    const gen = provider.chat([
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Hi" },
    ]);
    for await (const _chunk of gen) { /* consume */ }

    const callBody = JSON.parse((http.calls[0].options as Record<string, string>).body);
    // System text should be prepended to first user message
    const firstContent = callBody.contents[0];
    expect(firstContent.role).toBe("user");
    expect(firstContent.parts[0].text).toContain("You are helpful.");
    expect(firstContent.parts[0].text).toContain("Hi");
  });

  it("should throw ProviderError on API failure", async () => {
    const { provider } = setup(new Map([
      ["https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent", {
        status: 400, headers: {}, body: "Bad request", ok: false,
      }],
    ]));

    const gen = provider.chat([{ role: "user", content: "Hi" }]);
    await expect(gen.next()).rejects.toThrow();
  });

  // ── listModels ───────────────────────────────────────────────────

  it("should list models from Gemini", async () => {
    const body = JSON.stringify({
      models: [
        { name: "models/gemini-1.5-flash", displayName: "Gemini 1.5 Flash" },
        { name: "models/gemini-1.5-pro", displayName: "Gemini 1.5 Pro" },
      ],
    });

    const { provider } = setup(new Map([
      ["https://generativelanguage.googleapis.com/v1beta/models", {
        status: 200, headers: {}, body, ok: true,
      }],
    ]));

    const models = await provider.listModels();
    expect(models).toHaveLength(2);
    expect(models[0].id).toBe("gemini-1.5-flash");
    expect(models[0].name).toBe("Gemini 1.5 Flash");
    expect(models[1].contextWindow).toBe(2_000_000); // pro
  });

  // ── Health check ─────────────────────────────────────────────────

  it("should return true for healthy Gemini", async () => {
    const { provider } = setup(new Map([
      ["https://generativelanguage.googleapis.com/v1beta/models", {
        status: 200, headers: {}, body: '{"models":[]}', ok: true,
      }],
    ]));

    expect(await provider.healthCheck()).toBe(true);
  });

  it("should return false when Gemini is unreachable", async () => {
    const { provider } = setup(new Map([
      ["https://generativelanguage.googleapis.com/v1beta/models", {
        status: 500, headers: {}, body: "error", ok: false,
      }],
    ]));

    expect(await provider.healthCheck()).toBe(false);
  });

  // ── Context window size ──────────────────────────────────────────

  it("should return 1_000_000 for flash models", () => {
    const { provider } = setup();
    expect(provider.contextWindowSize("gemini-1.5-flash")).toBe(1_000_000);
  });

  it("should return 2_000_000 for pro models", () => {
    const { provider } = setup();
    expect(provider.contextWindowSize("gemini-1.5-pro")).toBe(2_000_000);
  });

  it("should return 32000 for unknown models", () => {
    const { provider } = setup();
    expect(provider.contextWindowSize("gemini-nano")).toBe(32000);
  });
});
