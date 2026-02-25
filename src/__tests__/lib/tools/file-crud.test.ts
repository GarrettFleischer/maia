import { describe, it, expect } from "bun:test";
import path from "path";
import {
  fileReadTool,
  fileWriteTool,
  fileAppendTool,
  fileDeleteTool,
  fileListTool,
  fileMoveTool,
  fileExistsTool,
  directoryCreateTool,
} from "@/lib/tools/file-crud";
import { getKnowledgeDir, getToolsDir } from "@/lib/data-dir";
import { makeTestContext, FakeFs } from "../../helpers/fakes";
import type { ToolContext } from "@/lib/tools/types";

const KNOWLEDGE_DIR = getKnowledgeDir();
const TOOLS_DIR = getToolsDir();

// Use path.resolve so the volume root matches what validatePath produces on any OS
const VOLUME = path.resolve("/workspace/agent-1");

function makeToolCtx(fs?: FakeFs): ToolContext {
  const fakefs = fs ?? new FakeFs();
  const ctx = makeTestContext({ fs: fakefs });
  return { ...ctx, agentId: "agent-1", sessionId: "session-1", volumeRoot: VOLUME };
}

// Helper: resolve a relative path against VOLUME, using OS separator
function vol(...parts: string[]): string {
  return path.join(VOLUME, ...parts);
}

describe("fileReadTool", () => {
  it("reads a file within the volume", async () => {
    const fs = new FakeFs();
    fs.seed(vol("hello.txt"), "Hello, World!");
    const ctx = makeToolCtx(fs);
    const result = await fileReadTool.execute({ path: "hello.txt" }, ctx);
    expect(result).toBe("Hello, World!");
  });

  it("throws on path traversal outside volume", async () => {
    const ctx = makeToolCtx();
    await expect(fileReadTool.execute({ path: "../../etc/passwd" }, ctx)).rejects.toThrow();
  });

  it("throws on missing file", async () => {
    const ctx = makeToolCtx();
    await expect(fileReadTool.execute({ path: "missing.txt" }, ctx)).rejects.toThrow();
  });

  it("resolves knowledge/ prefix to data/knowledge/", async () => {
    const fs = new FakeFs();
    fs.seed(path.join(KNOWLEDGE_DIR, "report.md"), "Knowledge content");
    const ctx = makeToolCtx(fs);
    const result = await fileReadTool.execute({ path: "knowledge/report.md" }, ctx);
    expect(result).toBe("Knowledge content");
  });

  it("resolves tools/ prefix to data/tools/", async () => {
    const fs = new FakeFs();
    fs.seed(path.join(TOOLS_DIR, "my-tool", "manifest.json"), '{"name":"my_tool"}');
    const ctx = makeToolCtx(fs);
    const result = await fileReadTool.execute({ path: "tools/my-tool/manifest.json" }, ctx);
    expect(result).toBe('{"name":"my_tool"}');
  });

  it("rejects path traversal under tools/", async () => {
    const ctx = makeToolCtx();
    await expect(
      fileReadTool.execute({ path: "tools/../etc/passwd" }, ctx),
    ).rejects.toThrow();
  });

  it("truncates files over 50KB", async () => {
    const fs = new FakeFs();
    const bigContent = "x".repeat(51 * 1024);
    fs.seed(vol("big.txt"), bigContent);
    const ctx = makeToolCtx(fs);
    const result = await fileReadTool.execute({ path: "big.txt" }, ctx) as string;
    expect(result).toContain("[truncated]");
    expect(result.length).toBeLessThan(bigContent.length);
  });
});

describe("fileWriteTool", () => {
  it("writes to data/knowledge/ when path is knowledge/...", async () => {
    const fs = new FakeFs();
    const ctx = makeToolCtx(fs);
    await fileWriteTool.execute({ path: "knowledge/reports/q4.md", content: "Q4 report" }, ctx);
    const full = path.join(KNOWLEDGE_DIR, "reports", "q4.md");
    expect(fs.snapshot()[full]).toBe("Q4 report");
  });

  it("writes a file to the volume", async () => {
    const fs = new FakeFs();
    const ctx = makeToolCtx(fs);
    await fileWriteTool.execute({ path: "new.txt", content: "New content" }, ctx);
    expect(fs.snapshot()[vol("new.txt")]).toBe("New content");
  });

  it("overwrites existing file", async () => {
    const fs = new FakeFs();
    fs.seed(vol("existing.txt"), "Old");
    const ctx = makeToolCtx(fs);
    await fileWriteTool.execute({ path: "existing.txt", content: "New" }, ctx);
    expect(fs.snapshot()[vol("existing.txt")]).toBe("New");
  });

  it("prevents path traversal", async () => {
    const ctx = makeToolCtx();
    await expect(fileWriteTool.execute({ path: "../../../evil.txt", content: "evil" }, ctx)).rejects.toThrow();
  });

  it("writes to data/tools/ when path is tools/...", async () => {
    const fs = new FakeFs();
    const ctx = makeToolCtx(fs);
    await fileWriteTool.execute({
      path: "tools/my-tool/manifest.json",
      content: '{"name":"my_tool","functions":[]}',
    }, ctx);
    const full = path.join(TOOLS_DIR, "my-tool", "manifest.json");
    expect(fs.snapshot()[full]).toBe('{"name":"my_tool","functions":[]}');
  });

  it("throws when writing to a path under a registered tool (read-only)", async () => {
    const baseCtx = makeTestContext();
    baseCtx.db
      .prepare("INSERT INTO approved_tools (tool_slug, approved_at) VALUES (?, ?)")
      .run("my-tool", "2025-01-01T00:00:00.000Z");
    const ctx = { ...baseCtx, agentId: "agent-1", sessionId: "s1", volumeRoot: VOLUME };
    await expect(
      fileWriteTool.execute({
        path: "tools/my-tool/foo.txt",
        content: "x",
      }, ctx),
    ).rejects.toThrow("Registered tools are read-only");
  });

  it("allows write to tools/ after slug is deregistered", async () => {
    const baseCtx = makeTestContext();
    baseCtx.db
      .prepare("INSERT INTO approved_tools (tool_slug, approved_at) VALUES (?, ?)")
      .run("my-tool", "2025-01-01T00:00:00.000Z");
    const ctx = { ...baseCtx, agentId: "agent-1", sessionId: "s1", volumeRoot: VOLUME };
    await expect(
      fileWriteTool.execute({ path: "tools/my-tool/foo.txt", content: "x" }, ctx),
    ).rejects.toThrow("Registered tools are read-only");
    baseCtx.db.prepare("DELETE FROM approved_tools WHERE tool_slug = ?").run("my-tool");
    await fileWriteTool.execute({ path: "tools/my-tool/foo.txt", content: "ok" }, ctx);
    const full = path.join(TOOLS_DIR, "my-tool", "foo.txt");
    expect((baseCtx.fs as FakeFs).snapshot()[full]).toBe("ok");
  });
});

describe("fileAppendTool", () => {
  it("appends to an existing file", async () => {
    const fs = new FakeFs();
    fs.seed(vol("log.txt"), "Line 1\n");
    const ctx = makeToolCtx(fs);
    await fileAppendTool.execute({ path: "log.txt", content: "Line 2\n" }, ctx);
    expect(fs.snapshot()[vol("log.txt")]).toBe("Line 1\nLine 2\n");
  });

  it("creates file if it doesn't exist", async () => {
    const fs = new FakeFs();
    const ctx = makeToolCtx(fs);
    await fileAppendTool.execute({ path: "new-log.txt", content: "First line" }, ctx);
    expect(fs.snapshot()[vol("new-log.txt")]).toBe("First line");
  });
});

describe("fileDeleteTool", () => {
  it("deletes a file", async () => {
    const fs = new FakeFs();
    fs.seed(vol("delete-me.txt"), "bye");
    const ctx = makeToolCtx(fs);
    await fileDeleteTool.execute({ path: "delete-me.txt" }, ctx);
    expect(fs.snapshot()[vol("delete-me.txt")]).toBeUndefined();
  });

  it("prevents path traversal", async () => {
    const ctx = makeToolCtx();
    await expect(fileDeleteTool.execute({ path: "../../etc/passwd" }, ctx)).rejects.toThrow();
  });
});

describe("fileListTool", () => {
  it("takes no args and lists all files and folders recursively under the agent workspace", async () => {
    const fs = new FakeFs();
    fs.seed(vol("dir", "a.txt"), "a");
    fs.seed(vol("dir", "b.txt"), "b");
    fs.seed(vol("top.txt"), "top");
    const ctx = makeToolCtx(fs);
    const result = await fileListTool.execute({}, ctx) as string[];
    expect(result).toContain("top.txt");
    expect(result).toContain(path.join("dir", "a.txt"));
    expect(result).toContain(path.join("dir", "b.txt"));
  });

  it("returns unique entries (no duplicates)", async () => {
    const fs = new FakeFs();
    fs.seed(vol("subdir", "nested", "a.txt"), "a");
    fs.seed(vol("subdir", "nested", "b.txt"), "b");
    const ctx = makeToolCtx(fs);
    const result = await fileListTool.execute({}, ctx) as string[];
    const unique = new Set(result);
    expect(unique.size).toBe(result.length);
  });

  it("returns empty array when workspace is empty", async () => {
    const fs = new FakeFs();
    const ctx = makeToolCtx(fs);
    const result = await fileListTool.execute({}, ctx) as string[];
    expect(result).toEqual([]);
  });
});

describe("fileMoveTool", () => {
  it("moves a file within the volume", async () => {
    const fs = new FakeFs();
    fs.seed(vol("source.txt"), "content");
    const ctx = makeToolCtx(fs);
    await fileMoveTool.execute({ from: "source.txt", to: "dest.txt" }, ctx);
    const snap = fs.snapshot();
    expect(snap[vol("source.txt")]).toBeUndefined();
    expect(snap[vol("dest.txt")]).toBe("content");
  });

  it("prevents path traversal in source", async () => {
    const ctx = makeToolCtx();
    await expect(fileMoveTool.execute({ from: "../../etc/passwd", to: "dest.txt" }, ctx)).rejects.toThrow();
  });
});

describe("fileExistsTool", () => {
  it("returns true for existing file", async () => {
    const fs = new FakeFs();
    fs.seed(vol("exists.txt"), "yes");
    const ctx = makeToolCtx(fs);
    expect(await fileExistsTool.execute({ path: "exists.txt" }, ctx)).toBe(true);
  });

  it("returns false for missing file", async () => {
    const ctx = makeToolCtx();
    expect(await fileExistsTool.execute({ path: "missing.txt" }, ctx)).toBe(false);
  });
});

describe("directoryCreateTool", () => {
  it("creates a directory path within the volume and returns created path", async () => {
    const fs = new FakeFs();
    const ctx = makeToolCtx(fs);
    const result = (await directoryCreateTool.execute(
      { path: "knowledge/jurisdictions" },
      ctx,
    )) as { created: string };
    expect(result.created).toBe(path.join(KNOWLEDGE_DIR, "jurisdictions"));
  });

  it("resolves workspace-relative path", async () => {
    const fs = new FakeFs();
    const ctx = makeToolCtx(fs);
    const result = (await directoryCreateTool.execute(
      { path: "reports/2024" },
      ctx,
    )) as { created: string };
    expect(result.created).toBe(vol("reports", "2024"));
  });

  it("prevents path traversal", async () => {
    const ctx = makeToolCtx();
    await expect(
      directoryCreateTool.execute({ path: "../../etc" }, ctx),
    ).rejects.toThrow();
  });

  it("has correct tool definition", () => {
    const def = directoryCreateTool.toDefinition();
    expect(def.name).toBe("directory_create");
    expect(def.description).toContain("directory");
  });
});

describe("toDefinition", () => {
  it("returns a valid tool definition", () => {
    const def = fileReadTool.toDefinition();
    expect(def.name).toBe("file_read");
    expect(typeof def.description).toBe("string");
    expect(typeof def.parameters).toBe("object");
  });
});
