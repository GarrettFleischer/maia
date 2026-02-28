/**
 * @fileoverview Tests for tool registry (getToolsForAgent, getToolByName, loadApprovedCustomTools).
 * @module __tests__/lib/tools/registry.test
 */
import { describe, it, expect } from "bun:test";
import path from "path";
import {
  getToolsForAgent,
  getToolByName,
  loadApprovedCustomTools,
  TOOL_REGISTRY,
} from "@/lib/tools/registry";
import { getToolsDir } from "@/lib/data-dir";
import { makeTestDb } from "../../helpers/db";

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
      expect(maiaNames.has("approve_tool")).toBe(true);
      expect(maiaNames.has("tool_deregister")).toBe(true);
      expect(otherNames.has("approve_tool")).toBe(false);
      expect(otherNames.has("tool_deregister")).toBe(false);
    });

    it("includes shared tools for both maia and non-maia", () => {
      const maiaTools = getToolsForAgent("maia");
      const otherTools = getToolsForAgent("other");

      expect(maiaTools.some((t) => t.name === "terminal_exec")).toBe(true);
      expect(otherTools.some((t) => t.name === "terminal_exec")).toBe(true);
      expect(maiaTools.some((t) => t.name === "find_tool")).toBe(true);
      expect(otherTools.some((t) => t.name === "find_tool")).toBe(true);
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

  describe("loadApprovedCustomTools", () => {
    it("returns custom tools from approved slugs and stub execute", async () => {
      const db = makeTestDb();
      db.prepare(
        "INSERT INTO approved_tools (tool_slug, approved_at) VALUES (?, ?)",
      ).run("my-tool", "2025-01-01T00:00:00.000Z");
      const toolsDir = getToolsDir();
      const manifestContent = JSON.stringify({
        name: "my_tool",
        description: "My tool",
        functions: [{ name: "custom_run", description: "Run", parameters: {} }],
      });
      const readFile = (filePath: string): string => {
        if (filePath === path.join(toolsDir, "my-tool", "manifest.json")) {
          return manifestContent;
        }
        throw new Error("ENOENT");
      };
      const tools = loadApprovedCustomTools(db, toolsDir, readFile);
      expect(tools.length).toBe(1);
      expect(tools[0]!.name).toBe("custom_run");
      const result = await tools[0]!.execute({}, {} as never);
      expect(String(result)).toContain("custom_run");
      expect(String(result)).toContain("execution not yet implemented");
    });

    it("skips custom tool whose name clashes with built-in", () => {
      const db = makeTestDb();
      db.prepare(
        "INSERT INTO approved_tools (tool_slug, approved_at) VALUES (?, ?)",
      ).run("clash-tool", "2025-01-01T00:00:00.000Z");
      const toolsDir = getToolsDir();
      const manifestContent = JSON.stringify({
        name: "clash",
        description: "Clash",
        functions: [
          { name: "terminal_exec", description: "Clash with built-in", parameters: {} },
        ],
      });
      const readFile = (filePath: string): string => {
        if (filePath === path.join(toolsDir, "clash-tool", "manifest.json")) {
          return manifestContent;
        }
        throw new Error("ENOENT");
      };
      const tools = loadApprovedCustomTools(db, toolsDir, readFile);
      expect(tools.length).toBe(0);
    });
  });
});
