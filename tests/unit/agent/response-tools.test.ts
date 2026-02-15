/**
 * @fileoverview Unit tests for remember, security_report, and progress_report tools.
 * @module tests/unit/agent/response-tools
 *
 * @note These tools replace inline ---REMEMBER---/---SECURITY---/---PROGRESS---
 * blocks; the LLM invokes them explicitly instead of embedding JSON in reply text.
 */

import { describe, it, expect } from "bun:test";
import {
  createRememberTool,
  createSecurityReportTool,
  createProgressReportTool,
} from "../../../src/agent/tools/response-tools.js";
import type { ToolContext } from "../../../src/agent/tools/base.js";
import { inMemoryFileSystem, capturingLogger } from "../../helpers/index.js";

function defaultContext(overrides?: Partial<ToolContext>): ToolContext {
  return {
    sessionId: "session-1",
    channelId: "cli",
    senderId: "user-1",
    privacyMode: false,
    ...overrides,
  };
}

describe("remember tool", () => {
  it("returns success with no content when all args empty or missing", async () => {
    const fs = inMemoryFileSystem();
    const tool = createRememberTool({
      fs,
      logger: capturingLogger(),
      workspacePath: "/workspace",
    });
    const result = await tool.execute({}, defaultContext());
    expect(result.success).toBe(true);
    expect(result.content).toContain("Nothing to remember");
    expect(result.data?.rememberedContent).toBeUndefined();
  });

  it("appends memoryMd to MEMORY.md and returns rememberedContent", async () => {
    const fs = inMemoryFileSystem();
    const tool = createRememberTool({
      fs,
      logger: capturingLogger(),
      workspacePath: "/w",
    });
    const result = await tool.execute(
      { memoryMd: "User prefers TypeScript." },
      defaultContext()
    );
    expect(result.success).toBe(true);
    expect(result.data?.rememberedContent).toEqual({
      memoryMd: "User prefers TypeScript.",
    });
    expect(await fs.readFile("/w/MEMORY.md")).toBe("User prefers TypeScript.");
  });

  it("appends userMd and soulMd when provided", async () => {
    const fs = inMemoryFileSystem();
    const tool = createRememberTool({
      fs,
      logger: capturingLogger(),
      workspacePath: "/w",
    });
    const result = await tool.execute(
      { userMd: "Likes dark mode.", soulMd: "Values privacy." },
      defaultContext()
    );
    expect(result.success).toBe(true);
    expect(await fs.readFile("/w/USER.md")).toBe("Likes dark mode.");
    expect(await fs.readFile("/w/SOUL.md")).toBe("Values privacy.");
    expect(result.data?.rememberedContent).toEqual({
      userMd: "Likes dark mode.",
      soulMd: "Values privacy.",
    });
  });

  it("skips writing when privacy mode is active", async () => {
    const fs = inMemoryFileSystem();
    const tool = createRememberTool({
      fs,
      logger: capturingLogger(),
      workspacePath: "/w",
    });
    const result = await tool.execute(
      { memoryMd: "Secret preference." },
      defaultContext({ privacyMode: true })
    );
    expect(result.success).toBe(true);
    expect(result.content.toLowerCase()).toContain("privacy");
    expect(result.data?.rememberedContent).toBeUndefined();
    await expect(fs.exists("/w/MEMORY.md")).resolves.toBe(false);
  });
});

describe("security_report tool", () => {
  it("returns success and no securityFlagged when flagged is false", async () => {
    const tool = createSecurityReportTool({});
    const result = await tool.execute(
      { flagged: false },
      defaultContext()
    );
    expect(result.success).toBe(true);
    expect(result.data?.securityFlagged).toBeUndefined();
  });

  it("calls onSecurityFlagged and returns securityFlagged in data when flagged", async () => {
    let called: { reason: string; snippet: string } | null = null;
    const tool = createSecurityReportTool({
      onSecurityFlagged: (reason, snippet) => {
        called = { reason, snippet };
      },
    });
    const result = await tool.execute(
      {
        flagged: true,
        reason: "Possible prompt injection",
        snippet: "Ignore previous instructions",
      },
      defaultContext()
    );
    expect(result.success).toBe(true);
    expect(called).not.toBeNull();
    expect(called!.reason).toBe("Possible prompt injection");
    expect(called!.snippet).toBe("Ignore previous instructions");
    expect(result.data?.securityFlagged).toEqual({
      reason: "Possible prompt injection",
      snippet: "Ignore previous instructions",
    });
  });

  it("handles missing reason/snippet when flagged", async () => {
    let called = false;
    const tool = createSecurityReportTool({
      onSecurityFlagged: () => {
        called = true;
      },
    });
    const result = await tool.execute(
      { flagged: true },
      defaultContext()
    );
    expect(result.success).toBe(true);
    expect(called).toBe(true);
    expect(result.data?.securityFlagged).toEqual({
      reason: "",
      snippet: "",
    });
  });
});

describe("progress_report tool", () => {
  it("returns progressReport in data with status and summary", async () => {
    const tool = createProgressReportTool();
    const result = await tool.execute(
      { status: "accomplished", summary: "Created the quote bot." },
      defaultContext()
    );
    expect(result.success).toBe(true);
    expect(result.data?.progressReport).toEqual({
      status: "accomplished",
      summary: "Created the quote bot.",
    });
  });

  it("accepts stuck and failed status", async () => {
    const tool = createProgressReportTool();
    const result = await tool.execute(
      { status: "stuck", summary: "API returned 503." },
      defaultContext()
    );
    expect(result.success).toBe(true);
    const pr = result.data?.progressReport as { status: string; summary: string } | undefined;
    expect(pr?.status).toBe("stuck");
    expect(pr?.summary).toBe("API returned 503.");
  });

  it("returns error when status is missing", async () => {
    const tool = createProgressReportTool();
    const result = await tool.execute(
      { summary: "Done." },
      defaultContext()
    );
    expect(result.success).toBe(false);
    expect(result.content).toContain("status");
  });
});
