/**
 * @fileoverview Tests for Muninn config (base URL from settings).
 * @module __tests__/lib/muninn/config.test
 */

import { describe, it, expect } from "bun:test";
import { getMuninnConfig } from "@/lib/muninn/config";
import { makeTestContext } from "../../helpers/fakes";
import { updateSettings } from "@/lib/settings";

describe("muninn config", () => {
  it("returns empty baseUrl when muninnUrl is not set", () => {
    const ctx = makeTestContext();
    const config = getMuninnConfig(ctx);
    expect(config.baseUrl).toBe("");
    expect(config.enabled).toBe(false);
  });

  it("returns baseUrl from settings when muninnUrl is set", () => {
    const ctx = makeTestContext();
    updateSettings(ctx, { muninnUrl: "http://localhost:8475" });
    const config = getMuninnConfig(ctx);
    expect(config.baseUrl).toBe("http://localhost:8475");
    expect(config.enabled).toBe(true);
  });

  it("trims trailing slash from baseUrl", () => {
    const ctx = makeTestContext();
    updateSettings(ctx, { muninnUrl: "http://localhost:8475/" });
    const config = getMuninnConfig(ctx);
    expect(config.baseUrl).toBe("http://localhost:8475");
  });
});
