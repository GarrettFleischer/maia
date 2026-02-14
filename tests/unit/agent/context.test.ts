/**
 * @fileoverview Unit tests for the agent context builder.
 * @module tests/unit/agent/context
 */

import { describe, it, expect } from "bun:test";
import { createContextBuilder } from "../../../src/agent/context.js";
import { capturingLogger, inMemoryFileSystem, testConfig } from "../../helpers/index.js";

describe("ContextBuilder", () => {
  function setup(files?: Record<string, string>) {
    const logger = capturingLogger();
    const config = testConfig();
    const fs = inMemoryFileSystem(files);
    const builder = createContextBuilder({ fs, config, logger });
    return { builder, logger, config };
  }

  // ── loadWorkspaceFile ────────────────────────────────────────────

  it("should load an existing workspace file", async () => {
    const { builder } = setup({
      "/test/workspace/SOUL.md": "# Soul\nYou are a test bot.",
    });
    const content = await builder.loadWorkspaceFile("SOUL.md");
    expect(content).toBe("# Soul\nYou are a test bot.");
  });

  it("should return empty string for missing file", async () => {
    const { builder } = setup();
    const content = await builder.loadWorkspaceFile("NONEXISTENT.md");
    expect(content).toBe("");
  });

  // ── buildSystemPrompt ────────────────────────────────────────────

  it("should include SOUL.md in system prompt", async () => {
    const { builder } = setup({
      "/test/workspace/SOUL.md": "I am a helpful assistant.",
    });
    const msg = await builder.buildSystemPrompt();
    expect(msg.role).toBe("system");
    expect(msg.content).toContain("Core Persona");
    expect(msg.content).toContain("I am a helpful assistant.");
  });

  it("should include IDENTITY.md in system prompt", async () => {
    const { builder } = setup({
      "/test/workspace/IDENTITY.md": "name: TestBot\nemoji: 🤖",
    });
    const msg = await builder.buildSystemPrompt();
    expect(msg.content).toContain("Identity");
    expect(msg.content).toContain("TestBot");
  });

  it("should include USER.md in system prompt", async () => {
    const { builder } = setup({
      "/test/workspace/USER.md": "Likes TypeScript",
    });
    const msg = await builder.buildSystemPrompt();
    expect(msg.content).toContain("About the User");
    expect(msg.content).toContain("Likes TypeScript");
  });

  it("should include MEMORY.md in system prompt", async () => {
    const { builder } = setup({
      "/test/workspace/MEMORY.md": "User prefers dark mode",
    });
    const msg = await builder.buildSystemPrompt();
    expect(msg.content).toContain("Curated Memory");
    expect(msg.content).toContain("dark mode");
  });

  it("should include injected memory context", async () => {
    const { builder } = setup();
    const msg = await builder.buildSystemPrompt({
      memoryContext: "User asked about TypeScript yesterday.",
    });
    expect(msg.content).toContain("Relevant Memories");
    expect(msg.content).toContain("User asked about TypeScript yesterday.");
  });

  it("should include thread summary", async () => {
    const { builder } = setup();
    const msg = await builder.buildSystemPrompt({
      threadSummary: "Discussion about testing strategies.",
    });
    expect(msg.content).toContain("Current Topic");
    expect(msg.content).toContain("testing strategies");
  });

  it("should include additional context", async () => {
    const { builder } = setup();
    const msg = await builder.buildSystemPrompt({
      additionalContext: "## Extra\nCustom instructions here.",
    });
    expect(msg.content).toContain("Custom instructions here.");
  });

  it("should include system info with bot name and emoji", async () => {
    const { builder, config } = setup();
    const msg = await builder.buildSystemPrompt();
    expect(msg.content).toContain(`Name: ${config.identity.name}`);
    expect(msg.content).toContain(`Emoji: ${config.identity.emoji}`);
    expect(msg.content).toContain("Current time:");
  });

  it("should assemble multiple sections with separator", async () => {
    const { builder } = setup({
      "/test/workspace/SOUL.md": "Soul text",
      "/test/workspace/IDENTITY.md": "Identity text",
      "/test/workspace/USER.md": "User text",
    });
    const msg = await builder.buildSystemPrompt();
    // Each section separated by horizontal rule
    const sectionCount = (msg.content.match(/---/g) ?? []).length;
    // At least 3 sections: Soul, Identity, User, System Info => at least 3 separators
    expect(sectionCount).toBeGreaterThanOrEqual(3);
  });

  it("should handle empty workspace gracefully", async () => {
    const { builder } = setup();
    const msg = await builder.buildSystemPrompt();
    // Should still have system info at minimum
    expect(msg.role).toBe("system");
    expect(msg.content).toContain("System Info");
  });
});
