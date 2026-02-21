/**
 * @fileoverview Tests for tool registry (getToolsForAgent, getToolByName).
 * @module __tests__/lib/tools/registry.test
 */
import { describe, it, expect } from "bun:test";
import {
  getToolsForAgent,
  getToolByName,
  TOOL_REGISTRY,
} from "@/lib/tools/registry";

describe("tool registry", () => {
  describe("getToolsForAgent", () => {
    it("returns more tools for maia than for other agents (maia-only tools)", () => {
      const maiaTools = getToolsForAgent("maia");
      const otherTools = getToolsForAgent("other-agent");

      const maiaNames = new Set(maiaTools.map((t) => t.name));
      const otherNames = new Set(otherTools.map((t) => t.name));

      expect(maiaTools.length).toBeGreaterThan(otherTools.length);
      expect(maiaNames.has("agent_create")).toBe(true);
      expect(maiaNames.has("cron_schedule")).toBe(true);
      expect(otherNames.has("agent_create")).toBe(false);
      expect(otherNames.has("cron_schedule")).toBe(false);
    });

    it("includes shared tools for both maia and non-maia", () => {
      const maiaTools = getToolsForAgent("maia");
      const otherTools = getToolsForAgent("other");

      expect(maiaTools.some((t) => t.name === "terminal_exec")).toBe(true);
      expect(otherTools.some((t) => t.name === "terminal_exec")).toBe(true);
      expect(maiaTools.some((t) => t.name === "file_read")).toBe(true);
      expect(otherTools.some((t) => t.name === "file_read")).toBe(true);
    });
  });

  describe("getToolByName", () => {
    it("returns the terminal_exec tool when given terminal_exec", () => {
      const tool = getToolByName("terminal_exec");
      expect(tool).toBeDefined();
      expect(tool?.name).toBe("terminal_exec");
      expect(tool?.toDefinition).toBeDefined();
    });

    it("returns undefined for unknown tool name", () => {
      expect(getToolByName("nonexistent_tool")).toBeUndefined();
    });

    it("returns each registered tool by name", () => {
      for (const { tool } of TOOL_REGISTRY) {
        const found = getToolByName(tool.name);
        expect(found).toBe(tool);
      }
    });
  });
});
