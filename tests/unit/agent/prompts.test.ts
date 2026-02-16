/**
 * @fileoverview Unit tests for agent prompt constants.
 * @module tests/unit/agent/prompts
 */

import { describe, it, expect } from "bun:test";
import { MAIA_THINKING_PROMPT } from "../../../src/agent/prompts.js";

describe("MAIA_THINKING_PROMPT", () => {
  it("should instruct Maia to consider sharing via message(recipientId, content)", () => {
    expect(MAIA_THINKING_PROMPT).toContain("message");
    expect(MAIA_THINKING_PROMPT).toMatch(/recipientId|'user'|'maia'|agent id/);
  });

  it("should ask what Maia is focusing on", () => {
    expect(MAIA_THINKING_PROMPT).toMatch(/focus|plan|decision|share/i);
  });
});
