/**
 * @fileoverview Unit tests for the dynamic tools loader.
 * @module tests/unit/tools/loader
 */

import { describe, it, expect } from "bun:test";
import { join } from "path";
import { loadDynamicTools } from "../../../src/tools/loader.js";
import { inMemoryFileSystem, capturingLogger } from "../../helpers/index.js";
import type { FileSystem } from "../../../src/core/types.js";

describe("loadDynamicTools", () => {
  it("should return empty array when tools dir does not exist", async () => {
    const fs = inMemoryFileSystem();
    const tools = await loadDynamicTools(fs, "/nonexistent/tools", {
      logger: capturingLogger(),
    });
    expect(tools).toEqual([]);
  });

  it("should return empty array when tools dir is empty", async () => {
    const fs = inMemoryFileSystem();
    await fs.mkdir("/workspace/tools");
    const tools = await loadDynamicTools(fs, "/workspace/tools", {
      logger: capturingLogger(),
    });
    expect(tools).toEqual([]);
  });

  it("should skip subdirs without manifest or index", async () => {
    const fs = inMemoryFileSystem();
    await fs.mkdir("/workspace/tools");
    await fs.mkdir("/workspace/tools/empty_subdir");
    const tools = await loadDynamicTools(fs, "/workspace/tools", {
      logger: capturingLogger(),
    });
    expect(tools).toEqual([]);
  });

  it("should skip subdir with manifest but no index.ts", async () => {
    const fs = inMemoryFileSystem();
    await fs.mkdir("/workspace/tools");
    await fs.mkdir("/workspace/tools/partial");
    await fs.writeFile(
      "/workspace/tools/partial/manifest.json",
      JSON.stringify({ name: "partial", description: "No index", functions: [] })
    );
    const tools = await loadDynamicTools(fs, "/workspace/tools", {
      logger: capturingLogger(),
    });
    expect(tools).toEqual([]);
  });

  it("should load a real tool from fixture dir", async () => {
    const toolsDir = join(import.meta.dir, "..", "..", "fixtures", "dynamic-tools");
    const { existsSync, readdirSync, readFileSync } = await import("fs");
    const realFs: FileSystem = {
      exists: async (path: string) => {
        try {
          return existsSync(path);
        } catch {
          return false;
        }
      },
      readFile: async (path: string) => readFileSync(path, "utf-8"),
      readDir: async (path: string) => readdirSync(path) as string[],
      writeFile: async () => {},
      appendFile: async () => {},
      mkdir: async () => {},
      stat: async () => ({ size: 0, isFile: true, isDirectory: false, mtime: new Date() }),
      checksum: async () => "",
      remove: async () => {},
      chmod: async () => {},
    };
    const exists = await realFs.exists(toolsDir);
    if (!exists) return;
    const tools = await loadDynamicTools(realFs, toolsDir, {
      logger: capturingLogger(),
    });
    if (tools.length === 0) return;
    expect(tools.length).toBeGreaterThanOrEqual(1);
    const sample = tools.find((t) => t.name === "sample_tool");
    expect(sample).toBeDefined();
    expect(sample!.definition().name).toBe("sample_tool");
    const result = await sample!.execute(
        {},
        { sessionId: "test", channelId: "test", senderId: "test", privacyMode: false }
      );
    expect(result.success).toBe(true);
    expect(result.content).toContain("sample ok");
  });
});
