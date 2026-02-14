/**
 * @fileoverview Unit tests for remember-block handler and applyRememberedContent.
 * @module tests/unit/memory/remember-block
 */

import { describe, it, expect } from "bun:test";
import {
  createRememberBlockHandler,
  applyRememberedContent,
  REMEMBER_DELIMITER,
} from "../../../src/memory/remember-block.js";
import { inMemoryFileSystem, capturingLogger } from "../../helpers/index.js";

describe("RememberBlockHandler", () => {
  it("returns displayContent and remembered false when no delimiter", async () => {
    const fs = inMemoryFileSystem();
    const handler = createRememberBlockHandler({
      fs,
      logger: capturingLogger(),
      workspacePath: "/workspace",
    });
    const result = await handler.parseAndApply("Just a reply.");
    expect(result.displayContent).toBe("Just a reply.");
    expect(result.remembered).toBe(false);
    expect(result.rememberedContent).toBeUndefined();
  });

  it("appends to MEMORY.md when remember block has memoryMd", async () => {
    const fs = inMemoryFileSystem();
    const handler = createRememberBlockHandler({
      fs,
      logger: capturingLogger(),
      workspacePath: "/workspace",
    });
    const raw = `Ok.\n${REMEMBER_DELIMITER}\n{"memoryMd": "User prefers TypeScript."}`;
    const result = await handler.parseAndApply(raw);
    expect(result.displayContent).toBe("Ok.");
    expect(result.remembered).toBe(true);
    expect(result.rememberedContent?.memoryMd).toBe("User prefers TypeScript.");

    const content = await fs.readFile("/workspace/MEMORY.md");
    expect(content).toBe("User prefers TypeScript.");
  });

  it("appends to USER.md and SOUL.md when present in block", async () => {
    const fs = inMemoryFileSystem();
    const handler = createRememberBlockHandler({
      fs,
      logger: capturingLogger(),
      workspacePath: "/w",
    });
    const raw = `${REMEMBER_DELIMITER}\n{"userMd": "Likes dark mode.", "soulMd": "Values privacy."}`;
    const result = await handler.parseAndApply(raw);
    expect(result.remembered).toBe(true);
    expect(await fs.readFile("/w/USER.md")).toBe("Likes dark mode.");
    expect(await fs.readFile("/w/SOUL.md")).toBe("Values privacy.");
  });

  it("returns remembered false on invalid JSON", async () => {
    const fs = inMemoryFileSystem();
    const handler = createRememberBlockHandler({
      fs,
      logger: capturingLogger(),
      workspacePath: "/workspace",
    });
    const raw = `Ok.\n${REMEMBER_DELIMITER}\n{ invalid }`;
    const result = await handler.parseAndApply(raw);
    expect(result.displayContent).toBe("Ok.");
    expect(result.remembered).toBe(false);
  });
});

describe("applyRememberedContent", () => {
  it("writes memoryMd to MEMORY.md, userMd to USER.md, soulMd to SOUL.md", async () => {
    const fs = inMemoryFileSystem();
    const logger = capturingLogger();
    await applyRememberedContent(
      fs,
      "/other/workspace",
      {
        memoryMd: "Shared fact.",
        userMd: "User note.",
        soulMd: "Soul note.",
      },
      logger
    );
    expect(await fs.readFile("/other/workspace/MEMORY.md")).toBe("Shared fact.");
    expect(await fs.readFile("/other/workspace/USER.md")).toBe("User note.");
    expect(await fs.readFile("/other/workspace/SOUL.md")).toBe("Soul note.");
  });

  it("appends to existing files", async () => {
    const fs = inMemoryFileSystem({
      "/w/MEMORY.md": "Existing line.",
    });
    await applyRememberedContent(
      fs,
      "/w",
      { memoryMd: "New line." },
      capturingLogger()
    );
    expect(await fs.readFile("/w/MEMORY.md")).toBe("Existing line.\nNew line.");
  });

  it("skips empty or missing fields", async () => {
    const fs = inMemoryFileSystem();
    await applyRememberedContent(
      fs,
      "/w",
      { memoryMd: "Only this.", userMd: "  ", soulMd: "" },
      capturingLogger()
    );
    expect(await fs.readFile("/w/MEMORY.md")).toBe("Only this.");
    await expect(fs.exists("/w/USER.md")).resolves.toBe(false);
    await expect(fs.exists("/w/SOUL.md")).resolves.toBe(false);
  });
});
