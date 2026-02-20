/**
 * @fileoverview Tests for MAIA_LLM_STREAMING parsing (isStreamingEnabled).
 * @module tests/lib/streaming-env.test
 */

import { afterEach, describe, expect, it } from "bun:test";
import { isStreamingEnabled } from "@/lib/streaming-env";

describe("isStreamingEnabled", () => {
  const orig = process.env.MAIA_LLM_STREAMING;

  afterEach(() => {
    if (orig !== undefined) process.env.MAIA_LLM_STREAMING = orig;
    else delete process.env.MAIA_LLM_STREAMING;
  });

  it("returns false when MAIA_LLM_STREAMING is unset", () => {
    delete process.env.MAIA_LLM_STREAMING;
    expect(isStreamingEnabled()).toBe(false);
  });

  it("returns false when MAIA_LLM_STREAMING is false, 0, or no", () => {
    for (const value of ["false", "0", "no", "FALSE", "No", ""]) {
      process.env.MAIA_LLM_STREAMING = value;
      expect(isStreamingEnabled()).toBe(false);
    }
  });

  it("returns true when MAIA_LLM_STREAMING is true, 1, or yes", () => {
    for (const value of ["true", "1", "yes", "TRUE", "Yes"]) {
      process.env.MAIA_LLM_STREAMING = value;
      expect(isStreamingEnabled()).toBe(true);
    }
  });
});
