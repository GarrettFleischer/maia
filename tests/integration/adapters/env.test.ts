/**
 * @fileoverview Integration tests for the real environment provider adapter.
 * @module tests/integration/adapters/env
 *
 * @note Uses real process.env. Cleans up test variables in afterEach.
 */

import { describe, it, expect, afterEach } from "bun:test";
import { createRealEnvProvider } from "../../../src/adapters/env.js";

describe("Real EnvProvider adapter", () => {
  const env = createRealEnvProvider();
  const testVars: string[] = [];

  afterEach(() => {
    for (const key of testVars) {
      delete process.env[key];
    }
    testVars.length = 0;
  });

  /**
   * @brief Helper to set an env var and track it for cleanup.
   */
  function setEnv(key: string, value: string): void {
    process.env[key] = value;
    testVars.push(key);
  }

  // ── get() ────────────────────────────────────────────────────────

  it("should return the value of an existing env var", () => {
    setEnv("MAIA_TEST_ADAPTER_VAR", "hello123");
    expect(env.get("MAIA_TEST_ADAPTER_VAR")).toBe("hello123");
  });

  it("should return undefined for a non-existent env var", () => {
    expect(env.get("MAIA_DEFINITELY_DOES_NOT_EXIST_XYZ")).toBeUndefined();
  });

  it("should reflect changes to process.env", () => {
    expect(env.get("MAIA_DYNAMIC_VAR")).toBeUndefined();
    setEnv("MAIA_DYNAMIC_VAR", "now-set");
    expect(env.get("MAIA_DYNAMIC_VAR")).toBe("now-set");
  });

  it("should handle empty string values", () => {
    setEnv("MAIA_EMPTY_VAR", "");
    expect(env.get("MAIA_EMPTY_VAR")).toBe("");
  });
});
