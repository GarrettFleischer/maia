/**
 * @fileoverview Tests for Next.js instrumentation (AppContext singleton and test injection).
 * @module __tests__/instrumentation
 */
import { describe, it, expect } from "bun:test";
import { getAppContext, _setTestContext } from "@/instrumentation";
import { makeTestContext } from "@/__tests__/helpers/fakes";
import type { AppContext } from "@/lib/context";

describe("instrumentation", () => {
  it("getAppContext() throws when context is not set", () => {
    _setTestContext(null as unknown as AppContext);
    expect(() => getAppContext()).toThrow("AppContext not yet initialized");
  });

  it("getAppContext() returns the context set via _setTestContext", () => {
    const ctx = makeTestContext();
    _setTestContext(ctx);
    expect(getAppContext()).toBe(ctx);
  });
});
