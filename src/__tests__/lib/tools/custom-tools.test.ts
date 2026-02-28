/**
 * @fileoverview Tests for approve_tool and tool_deregister (Maia-only custom tool management).
 */
import { describe, it, expect } from "bun:test";
import path from "path";
import { approveTool, toolDeregisterTool } from "@/lib/tools/custom-tools";
import { getApprovedToolSlugs, isToolRegistered } from "@/lib/tools/approved-tools";
import { getToolsDir } from "@/lib/data-dir";
import { makeTestContext, FakeFs } from "../../helpers/fakes";
import type { ToolContext } from "@/lib/tools/types";

const TOOLS_DIR = getToolsDir();

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  const base = makeTestContext(overrides);
  return {
    ...base,
    agentId: "maia",
    sessionId: "s1",
    volumeRoot: "/workspace/maia",
    ...overrides,
  };
}

const validManifest = JSON.stringify({
  name: "my_tool",
  description: "My tool",
  functions: [{ name: "run", description: "Run", parameters: {} }],
});

describe("approve_tool", () => {
  it("adds slug to approved_tools when manifest exists and is valid", async () => {
    const fs = new FakeFs();
    fs.seed(path.join(TOOLS_DIR, "my-tool", "manifest.json"), validManifest);
    const ctx = makeCtx({ fs });
    const result = (await approveTool.execute({ slug: "my-tool" }, ctx)) as { approved: string };
    expect(result.approved).toBe("my-tool");
    expect(isToolRegistered(ctx.db, "my-tool")).toBe(true);
    expect(getApprovedToolSlugs(ctx.db)).toContain("my-tool");
  });

  it("is idempotent (duplicate approve succeeds)", async () => {
    const fs = new FakeFs();
    fs.seed(path.join(TOOLS_DIR, "my-tool", "manifest.json"), validManifest);
    const ctx = makeCtx({ fs });
    await approveTool.execute({ slug: "my-tool" }, ctx);
    await approveTool.execute({ slug: "my-tool" }, ctx);
    expect(getApprovedToolSlugs(ctx.db)).toEqual(["my-tool"]);
  });

  it("throws on invalid slug", async () => {
    const ctx = makeCtx();
    await expect(approveTool.execute({ slug: "../etc" }, ctx)).rejects.toThrow(
      "Invalid tool slug",
    );
  });

  it("throws when manifest is missing", async () => {
    const ctx = makeCtx();
    await expect(approveTool.execute({ slug: "missing-tool" }, ctx)).rejects.toThrow();
  });

  it("throws when manifest is invalid", async () => {
    const fs = new FakeFs();
    fs.seed(path.join(TOOLS_DIR, "bad-tool", "manifest.json"), '{"name":"x","functions":[]}');
    const ctx = makeCtx({ fs });
    await expect(approveTool.execute({ slug: "bad-tool" }, ctx)).rejects.toThrow();
  });
});

describe("tool_deregister", () => {
  it("removes slug from approved_tools", async () => {
    const ctx = makeCtx();
    ctx.db
      .prepare("INSERT INTO approved_tools (tool_slug, approved_at) VALUES (?, ?)")
      .run("my-tool", "2025-01-01T00:00:00.000Z");
    expect(isToolRegistered(ctx.db, "my-tool")).toBe(true);
    const result = (await toolDeregisterTool.execute({ slug: "my-tool" }, ctx)) as {
      deregistered: string;
    };
    expect(result.deregistered).toBe("my-tool");
    expect(isToolRegistered(ctx.db, "my-tool")).toBe(false);
  });

  it("throws on invalid slug", async () => {
    const ctx = makeCtx();
    await expect(toolDeregisterTool.execute({ slug: "bad/slug" }, ctx)).rejects.toThrow(
      "Invalid tool slug",
    );
  });
});
