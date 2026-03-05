/**
 * @fileoverview Tests for Muninn vault name resolution.
 * @module __tests__/lib/muninn/vault.test
 */

import { describe, it, expect } from "bun:test";
import { toVaultName, vaultFromKnowledgePath } from "@/lib/muninn/vault";

describe("vault", () => {
  describe("toVaultName", () => {
    it("lowercases and strips invalid characters", () => {
      expect(toVaultName("Maia")).toBe("maia");
      expect(toVaultName("Agent-42")).toBe("agent-42");
      expect(toVaultName("foo_bar")).toBe("foo_bar");
    });
    it("returns default when result would be empty", () => {
      expect(toVaultName("!!!")).toBe("default");
      expect(toVaultName("")).toBe("default");
    });
    it("truncates to 64 chars", () => {
      const long = "a".repeat(80);
      expect(toVaultName(long).length).toBe(64);
    });
  });

  describe("vaultFromKnowledgePath", () => {
    it("returns agent id for agents/<id>/... paths", () => {
      expect(vaultFromKnowledgePath("agents/maia/memory/foo.md")).toBe("maia");
      expect(vaultFromKnowledgePath("agents/agent-42/docs/x.md")).toBe(
        "agent-42",
      );
    });
    it("returns default for non-agents paths", () => {
      expect(vaultFromKnowledgePath("report.md")).toBe("default");
      expect(vaultFromKnowledgePath("user/bar.md")).toBe("default");
      expect(vaultFromKnowledgePath("knowledge/x.md")).toBe("default");
    });
  });
});
