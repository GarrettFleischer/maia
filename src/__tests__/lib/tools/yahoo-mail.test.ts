/**
 * @fileoverview Structural tests for Yahoo Mail tools.
 * Ensures tool definitions are wired correctly without hitting the real IMAP service.
 * @module __tests__/lib/tools/yahoo-mail
 */

import { describe, it, expect } from "bun:test";
import {
  yahooMailTools,
  emailListFoldersTool,
  emailListTool,
  emailReadTool,
  emailSearchTool,
  emailMoveTool,
  emailMarkTool,
  emailDeleteTool,
} from "@/lib/tools/yahoo-mail";

describe("yahoo-mail tool definitions", () => {
  it("exports all expected tools with names and schemas", () => {
    const names = yahooMailTools.map((t) => t.name);
    expect(names).toEqual([
      "email_list_folders",
      "email_list",
      "email_read",
      "email_search",
      "email_move",
      "email_mark",
      "email_delete",
    ]);

    for (const tool of yahooMailTools) {
      const def = tool.toDefinition();
      expect(def.name).toBe(tool.name);
      expect(def.description.length).toBeGreaterThan(0);
      expect(def.parameters).toBeDefined();
    }
  });

  it("exposes individual named exports matching the aggregate list", () => {
    expect(yahooMailTools).toContain(emailListFoldersTool);
    expect(yahooMailTools).toContain(emailListTool);
    expect(yahooMailTools).toContain(emailReadTool);
    expect(yahooMailTools).toContain(emailSearchTool);
    expect(yahooMailTools).toContain(emailMoveTool);
    expect(yahooMailTools).toContain(emailMarkTool);
    expect(yahooMailTools).toContain(emailDeleteTool);
  });
});
