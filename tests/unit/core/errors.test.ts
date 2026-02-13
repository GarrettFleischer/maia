/**
 * @fileoverview Unit tests for typed error hierarchy.
 * @module tests/unit/core/errors
 */

import { describe, it, expect } from "bun:test";
import {
  MaiaError,
  ConfigError,
  AuthError,
  RateLimitError,
  ProviderError,
  MemoryError,
  ValidationError,
  SecurityError,
} from "../../../src/core/errors.js";

describe("Error Hierarchy", () => {
  it("should create MaiaError with code and message", () => {
    const err = new MaiaError("TEST_ERROR", "something went wrong");
    expect(err.code).toBe("TEST_ERROR");
    expect(err.message).toBe("something went wrong");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(MaiaError);
  });

  it("should create ConfigError as a MaiaError subclass", () => {
    const err = new ConfigError("Invalid config field");
    expect(err.code).toBe("CONFIG_ERROR");
    expect(err).toBeInstanceOf(MaiaError);
    expect(err).toBeInstanceOf(ConfigError);
  });

  it("should create AuthError with status 401", () => {
    const err = new AuthError("Invalid token");
    expect(err.code).toBe("AUTH_ERROR");
    expect(err.statusCode).toBe(401);
  });

  it("should create RateLimitError with retry-after", () => {
    const err = new RateLimitError(30);
    expect(err.code).toBe("RATE_LIMITED");
    expect(err.statusCode).toBe(429);
    expect(err.retryAfter).toBe(30);
  });

  it("should create ProviderError with provider id", () => {
    const err = new ProviderError("ollama", "connection refused");
    expect(err.code).toBe("PROVIDER_ERROR");
    expect(err.providerId).toBe("ollama");
  });

  it("should create MemoryError", () => {
    const err = new MemoryError("duplicate entry");
    expect(err.code).toBe("MEMORY_ERROR");
  });

  it("should create ValidationError with field details", () => {
    const err = new ValidationError("provider.model", "Expected string");
    expect(err.code).toBe("VALIDATION_ERROR");
    expect(err.field).toBe("provider.model");
  });

  it("should create SecurityError with severity", () => {
    const err = new SecurityError("Prompt injection detected", "high");
    expect(err.code).toBe("SECURITY_ERROR");
    expect(err.severity).toBe("high");
  });

  it("should preserve stack traces", () => {
    const err = new MaiaError("TEST", "test");
    expect(err.stack).toBeDefined();
    expect(err.stack).toContain("errors.test.ts");
  });
});
