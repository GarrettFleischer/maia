/**
 * @fileoverview Tests for Brave API helpers (search and answers keys).
 * Verifies vault-over-env precedence and empty-string fallback.
 * @module __tests__/lib/tools/brave-api
 */

import { describe, it, expect } from "bun:test";
import {
  getBraveSearchApiKey,
  getBraveAnswersApiKey,
} from "@/lib/tools/brave-api";
import type { AppContext } from "@/lib/context";
import { makeTestContext } from "@/__tests__/helpers/fakes";
import { credentialCreate } from "@/lib/security/credential-vault";

describe("brave-api", () => {
  it("prefers vault credential over env for search key", () => {
    const ctx: AppContext = makeTestContext();
    credentialCreate(ctx, "BRAVE_SEARCH_API_KEY", "vault-search-key");
    process.env.BRAVE_SEARCH_API_KEY = "env-search-key";
    const key = getBraveSearchApiKey(ctx);
    expect(key).toBe("vault-search-key");
  });

  it("falls back to env when vault credential is missing for search", () => {
    const ctx = makeTestContext();
    process.env.BRAVE_SEARCH_API_KEY = "env-search-only";
    const key = getBraveSearchApiKey(ctx);
    expect(key).toBe("env-search-only");
  });

  it("returns empty string when neither vault nor env contains search key", () => {
    const ctx = makeTestContext();
    delete process.env.BRAVE_SEARCH_API_KEY;
    const key = getBraveSearchApiKey(ctx);
    expect(key).toBe("");
  });

  it("prefers vault credential over env for answers key", () => {
    const ctx: AppContext = makeTestContext();
    credentialCreate(ctx, "BRAVE_ANSWERS_API_KEY", "vault-answers-key");
    process.env.BRAVE_ANSWERS_API_KEY = "env-answers-key";
    const key = getBraveAnswersApiKey(ctx);
    expect(key).toBe("vault-answers-key");
  });

  it("falls back to env when vault credential is missing for answers", () => {
    const ctx = makeTestContext();
    process.env.BRAVE_ANSWERS_API_KEY = "env-answers-only";
    const key = getBraveAnswersApiKey(ctx);
    expect(key).toBe("env-answers-only");
  });

  it("returns empty string when neither vault nor env contains answers key", () => {
    const ctx = makeTestContext();
    delete process.env.BRAVE_ANSWERS_API_KEY;
    const key = getBraveAnswersApiKey(ctx);
    expect(key).toBe("");
  });
});
