/**
 * @fileoverview Unit tests for config loading, validation, and env substitution.
 * @module tests/unit/core/config
 */

import { describe, it, expect } from "bun:test";
import { createTestContext, inMemoryFileSystem, staticEnv } from "../../helpers/index.js";
import { loadConfig } from "../../../src/core/config/loader.js";
import { configSchema } from "../../../src/core/config/schema.js";

describe("Config Schema", () => {
  it("should validate a minimal valid config", () => {
    const config = {
      provider: { primary: "ollama", model: "llama3.2" },
    };
    const result = configSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  it("should reject invalid provider names", () => {
    const config = {
      provider: { primary: "invalid-provider", model: "test" },
    };
    const result = configSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  it("should apply default values for optional fields", () => {
    const config = {
      provider: { primary: "ollama", model: "llama3.2" },
    };
    const result = configSchema.parse(config);
    expect(result.gateway.port).toBe(3000);
    expect(result.channels.cli.enabled).toBe(true);
    expect(result.memory.enabled).toBe(true);
    expect(result.security.rateLimiting.maxRequests).toBe(60);
  });

  it("should validate all provider types", () => {
    for (const provider of ["ollama", "groq", "gemini", "huggingface", "openrouter"]) {
      const config = { provider: { primary: provider, model: "test" } };
      const result = configSchema.safeParse(config);
      expect(result.success).toBe(true);
    }
  });

  it("should validate security config", () => {
    const config = {
      provider: { primary: "ollama", model: "test" },
      security: {
        rateLimiting: { maxRequests: -1, windowMs: 0 },
      },
    };
    const result = configSchema.safeParse(config);
    expect(result.success).toBe(false);
  });
});

describe("Config Loader", () => {
  it("should load config from a file path", async () => {
    const fs = inMemoryFileSystem({
      "/config.json": JSON.stringify({
        provider: { primary: "ollama", model: "llama3.2" },
      }),
    });
    const ctx = createTestContext({ fs });
    const config = await loadConfig("/config.json", ctx);
    expect(config.provider.primary).toBe("ollama");
    expect(config.provider.model).toBe("llama3.2");
  });

  it("should substitute environment variables", async () => {
    const fs = inMemoryFileSystem({
      "/config.json": JSON.stringify({
        provider: { primary: "ollama", model: "llama3.2" },
        gateway: { auth: { token: "${MAIA_AUTH_TOKEN}" } },
      }),
    });
    const env = staticEnv({ MAIA_AUTH_TOKEN: "my-secret-token" });
    const ctx = createTestContext({ fs, env });
    const config = await loadConfig("/config.json", ctx);
    expect(config.gateway.auth.token).toBe("my-secret-token");
  });

  it("should throw on missing required env vars", async () => {
    const fs = inMemoryFileSystem({
      "/config.json": JSON.stringify({
        provider: { primary: "ollama", model: "llama3.2" },
        gateway: { auth: { token: "${MISSING_VAR}" } },
      }),
    });
    const ctx = createTestContext({ fs });
    await expect(loadConfig("/config.json", ctx)).rejects.toThrow();
  });

  it("should throw on invalid JSON", async () => {
    const fs = inMemoryFileSystem({
      "/config.json": "not json {{{",
    });
    const ctx = createTestContext({ fs });
    await expect(loadConfig("/config.json", ctx)).rejects.toThrow();
  });

  it("should throw when config file does not exist", async () => {
    const ctx = createTestContext();
    await expect(loadConfig("/nonexistent.json", ctx)).rejects.toThrow();
  });
});
