/**
 * @fileoverview Tests for Ollama env parsing (OLLAMA_THINK, OLLAMA_THINK_LEVEL).
 * @module tests/lib/ollama-env.test
 */

import { afterEach, describe, expect, it } from "bun:test";
import { parseOllamaThink } from "@/lib/ollama-env";

describe("parseOllamaThink", () => {
  const origThink = process.env.OLLAMA_THINK;
  const origLevel = process.env.OLLAMA_THINK_LEVEL;

  afterEach(() => {
    if (origThink !== undefined) process.env.OLLAMA_THINK = origThink;
    else delete process.env.OLLAMA_THINK;
    if (origLevel !== undefined) process.env.OLLAMA_THINK_LEVEL = origLevel;
    else delete process.env.OLLAMA_THINK_LEVEL;
  });

  it("returns undefined when OLLAMA_THINK is unset", () => {
    delete process.env.OLLAMA_THINK;
    delete process.env.OLLAMA_THINK_LEVEL;
    expect(parseOllamaThink()).toBeUndefined();
  });

  it("returns undefined when OLLAMA_THINK is false, 0, or no", () => {
    for (const value of ["false", "0", "no", "FALSE", "No"]) {
      process.env.OLLAMA_THINK = value;
      delete process.env.OLLAMA_THINK_LEVEL;
      expect(parseOllamaThink()).toBeUndefined();
    }
  });

  it("returns true when OLLAMA_THINK is true, 1, or yes and level unset", () => {
    for (const value of ["true", "1", "yes", "TRUE", "Yes"]) {
      process.env.OLLAMA_THINK = value;
      delete process.env.OLLAMA_THINK_LEVEL;
      expect(parseOllamaThink()).toBe(true);
    }
  });

  it("returns level when OLLAMA_THINK enabled and OLLAMA_THINK_LEVEL is low, medium, or high", () => {
    process.env.OLLAMA_THINK = "true";
    process.env.OLLAMA_THINK_LEVEL = "low";
    expect(parseOllamaThink()).toBe("low");
    process.env.OLLAMA_THINK_LEVEL = "medium";
    expect(parseOllamaThink()).toBe("medium");
    process.env.OLLAMA_THINK_LEVEL = "high";
    expect(parseOllamaThink()).toBe("high");
  });

  it("returns true when OLLAMA_THINK enabled but OLLAMA_THINK_LEVEL invalid", () => {
    process.env.OLLAMA_THINK = "1";
    process.env.OLLAMA_THINK_LEVEL = "invalid";
    expect(parseOllamaThink()).toBe(true);
  });
});
