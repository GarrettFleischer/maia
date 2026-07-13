/**
 * @fileoverview Tests for tool registry (getToolsForAgent, getToolByName, loadApprovedCustomTools).
 * @module __tests__/lib/tools/registry.test
 */
import { describe, it, expect } from "bun:test";
import path from "path";
import {
  getToolsForAgent,
  getToolByName,
  getMinimalToolDefsForAgent,
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
      expect(maiaNames.has("persona_list")).toBe(true);
      expect(maiaNames.has("persona_set_session_default")).toBe(true);
      expect(maiaNames.has("cron_schedule")).toBe(true);
      expect(otherNames.has("persona_list")).toBe(false);
      expect(otherNames.has("cron_schedule")).toBe(false);
      expect(maiaNames.has("approve_tool")).toBe(true);
      expect(maiaNames.has("tool_deregister")).toBe(true);
      expect(otherNames.has("approve_tool")).toBe(false);
      expect(otherNames.has("tool_deregister")).toBe(false);
    });

    it("includes find_tool and find_skill for both maia and non-maia", () => {
      const maiaTools = getToolsForAgent("maia");
      const otherTools = getToolsForAgent("other");

      expect(maiaTools.some((t) => t.name === "find_tool")).toBe(true);
      expect(otherTools.some((t) => t.name === "find_tool")).toBe(true);
      expect(maiaTools.some((t) => t.name === "find_skill")).toBe(true);
      expect(otherTools.some((t) => t.name === "find_skill")).toBe(true);
    });
  });

  describe("getToolByName", () => {
    it("returns terminal_exec by name", () => {
      const terminal = getToolByName("terminal_exec");
      expect(terminal).toBeDefined();
      expect(terminal?.name).toBe("terminal_exec");
      expect(terminal?.toDefinition).toBeDefined();
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

  describe("getMinimalToolDefsForAgent", () => {
    it("returns only find_tool and find_skill for every agent", () => {
      const defs = getMinimalToolDefsForAgent("maia");
      const names = new Set(defs.map((d) => d.name));

      expect(names.size).toBe(2);
      expect(names.has("find_tool")).toBe(true);
      expect(names.has("find_skill")).toBe(true);
      expect(names.has("terminal_exec")).toBe(false);
      expect(names.has("file_list")).toBe(false);
    });

    it("returns same minimal set for maia and non-maia", () => {
      const maiaDefs = getMinimalToolDefsForAgent("maia");
      const otherDefs = getMinimalToolDefsForAgent("other");
      const maiaNames = new Set(maiaDefs.map((d) => d.name));
      const otherNames = new Set(otherDefs.map((d) => d.name));
      expect(maiaNames).toEqual(otherNames);
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
          {
            name: "terminal_exec",
            description: "Clash with built-in",
            parameters: {},
          },
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
