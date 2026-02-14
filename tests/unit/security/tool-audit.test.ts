/**
 * @fileoverview Unit tests for the tool proposal security audit.
 * @module tests/unit/security/tool-audit
 */

import { describe, it, expect } from "bun:test";
import { createToolAudit } from "../../../src/security/tool-audit.js";
import { capturingLogger } from "../../helpers/index.js";
import type { ToolProposal } from "../../../src/tools/proposals.js";

function proposal(overrides?: Partial<ToolProposal>): ToolProposal {
  return {
    id: "prop-1",
    proposingAgentId: "maia",
    name: "safe_helper",
    description: "A safe tool that does something useful for the user.",
    parametersJson: '{"type":"object","properties":{"query":{"type":"string"}},"required":["query"]}',
    implementationType: "inline",
    implementationConfigJson: null,
    status: "pending_security",
    securityReason: null,
    userFeedback: null,
    createdAt: "2026-02-13T12:00:00.000Z",
    updatedAt: "2026-02-13T12:00:00.000Z",
    ...overrides,
  };
}

describe("ToolAudit", () => {
  describe("rules only (no LLM)", () => {
    it("should approve a valid proposal", async () => {
      const audit = createToolAudit({ logger: capturingLogger() });
      const result = await audit.review(proposal());
      expect(result.approved).toBe(true);
      expect(result.reason).toContain("Rules check passed");
    });

    it("should deny when name is too short", async () => {
      const audit = createToolAudit({ logger: capturingLogger() });
      const result = await audit.review(proposal({ name: "x" }));
      expect(result.approved).toBe(false);
      expect(result.reason).toContain("2 and 64");
    });

    it("should deny when name is too long", async () => {
      const audit = createToolAudit({ logger: capturingLogger() });
      const result = await audit.review(
        proposal({ name: "a".repeat(65) })
      );
      expect(result.approved).toBe(false);
      expect(result.reason).toContain("2 and 64");
    });

    it("should deny when name has invalid format", async () => {
      const audit = createToolAudit({ logger: capturingLogger() });
      const result = await audit.review(proposal({ name: "Invalid-Name" }));
      expect(result.approved).toBe(false);
      expect(result.reason).toContain("lowercase");
    });

    it("should deny when description is too short", async () => {
      const audit = createToolAudit({ logger: capturingLogger() });
      const result = await audit.review(proposal({ description: "short" }));
      expect(result.approved).toBe(false);
      expect(result.reason).toContain("10 and 500");
    });

    it("should deny when description is too long", async () => {
      const audit = createToolAudit({ logger: capturingLogger() });
      const result = await audit.review(
        proposal({ description: "x".repeat(501) })
      );
      expect(result.approved).toBe(false);
      expect(result.reason).toContain("10 and 500");
    });

    it("should deny when parameters JSON is invalid", async () => {
      const audit = createToolAudit({ logger: capturingLogger() });
      const result = await audit.review(
        proposal({ parametersJson: "not json" })
      );
      expect(result.approved).toBe(false);
      expect(result.reason).toContain("Invalid parameters");
    });

    it("should deny when parameter name suggests sensitive data", async () => {
      const audit = createToolAudit({ logger: capturingLogger() });
      const result = await audit.review(
        proposal({
          parametersJson:
            '{"type":"object","properties":{"api_key":{"type":"string"}}}',
        })
      );
      expect(result.approved).toBe(false);
      expect(result.reason).toContain("sensitive");
    });
  });

  describe("with LLM mock", () => {
    it("should return approve when LLM returns APPROVE", async () => {
      const audit = createToolAudit({
        logger: capturingLogger(),
        llm: {
          chat: async function* () {
            yield { content: "APPROVE\nLooks safe." };
          },
        } as unknown as import("../../../src/core/types.js").LLMProvider,
      });
      const result = await audit.review(proposal());
      expect(result.approved).toBe(true);
      expect(result.reason).toBeDefined();
    });

    it("should return deny when LLM returns DENY", async () => {
      const audit = createToolAudit({
        logger: capturingLogger(),
        llm: {
          chat: async function* () {
            yield { content: "DENY\nPotential SSRF risk." };
          },
        } as unknown as import("../../../src/core/types.js").LLMProvider,
      });
      const result = await audit.review(proposal());
      expect(result.approved).toBe(false);
      expect(result.reason).toContain("SSRF");
    });

    it("should return deny when LLM throws", async () => {
      const audit = createToolAudit({
        logger: capturingLogger(),
        llm: {
          chat: async function* () {
            throw new Error("API error");
          },
        } as unknown as import("../../../src/core/types.js").LLMProvider,
      });
      const result = await audit.review(proposal());
      expect(result.approved).toBe(false);
      expect(result.reason).toContain("could not be completed");
    });
  });
});
