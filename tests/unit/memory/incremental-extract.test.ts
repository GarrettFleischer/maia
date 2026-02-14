/**
 * @fileoverview Unit tests for per-message incremental memory extraction.
 * @module tests/unit/memory/incremental-extract
 */

import { describe, it, expect } from "bun:test";
import { createIncrementalExtract } from "../../../src/memory/incremental-extract.js";
import type { IncrementalExtractDeps } from "../../../src/memory/incremental-extract.js";
import type { LLMProvider, ChatChunk, ChatMessage } from "../../../src/core/types.js";
import type { ContextBuilder } from "../../../src/agent/context.js";
import {
  inMemoryFileSystem,
  inMemoryDatabase,
  capturingLogger,
} from "../../helpers/index.js";

// ─── Helpers ─────────────────────────────────────────────────────

function mockLLM(responseJson: string): LLMProvider {
  return {
    id: "mock",
    name: "Mock LLM",
    async *chat(): AsyncGenerator<ChatChunk> {
      yield { content: responseJson, done: true };
    },
    async listModels() { return []; },
    async healthCheck() { return true; },
    contextWindowSize() { return 4096; },
  };
}

function mockContextBuilder(files?: Record<string, string>): ContextBuilder {
  const fileStore = files ?? {};
  return {
    async buildSystemPrompt() {
      return { role: "system", content: "You are helpful." };
    },
    async loadWorkspaceFile(filename: string) {
      return fileStore[filename] ?? "";
    },
  };
}

function fullResponse(overrides?: Record<string, unknown>): string {
  const base = {
    memories: [
      { text: "User likes TypeScript", category: "preference", importance: 0.9 },
    ],
    memoryMdUpdates: "## Preferences\n- TypeScript",
    userMdUpdates: "## Languages\n- TypeScript",
    soulMdUpdates: "",
    knowledgeNotes: [
      { path: "topics/TypeScript.md", content: "# TypeScript\nUser's preferred language." },
    ],
    ...overrides,
  };
  return JSON.stringify(base);
}

function makeDeps(overrides?: Partial<IncrementalExtractDeps>): IncrementalExtractDeps {
  return {
    fs: overrides?.fs ?? inMemoryFileSystem(),
    db: overrides?.db ?? inMemoryDatabase(),
    logger: overrides?.logger ?? capturingLogger(),
    llm: overrides?.llm ?? mockLLM(fullResponse()),
    workspacePath: overrides?.workspacePath ?? "/workspace",
    contextBuilder: overrides?.contextBuilder ?? mockContextBuilder(),
  };
}

// ─── Tests ───────────────────────────────────────────────────────

describe("IncrementalExtract", () => {
  it("should extract and apply all fields", async () => {
    const fs = inMemoryFileSystem();
    const db = inMemoryDatabase();
    const deps = makeDeps({ fs, db });
    const extractor = createIncrementalExtract(deps);

    await extractor.extract("What's your fav language?", "I can help with TypeScript!");

    // Memory inserted into DB
    const insertSql = db.executedSql.find((s) => s.sql.includes("INSERT INTO memories"));
    expect(insertSql).toBeDefined();

    // MEMORY.md appended
    expect(fs.files.has("/workspace/MEMORY.md")).toBe(true);
    expect(fs.files.get("/workspace/MEMORY.md")).toContain("TypeScript");

    // USER.md appended
    expect(fs.files.has("/workspace/USER.md")).toBe(true);
    expect(fs.files.get("/workspace/USER.md")).toContain("TypeScript");

    // Knowledge note written
    expect(fs.files.has("/workspace/knowledge/topics/TypeScript.md")).toBe(true);
  });

  it("should not modify files when all fields are empty", async () => {
    const fs = inMemoryFileSystem();
    const emptyResponse = fullResponse({
      memories: [],
      memoryMdUpdates: "",
      userMdUpdates: "",
      soulMdUpdates: "",
      knowledgeNotes: [],
    });
    const deps = makeDeps({ fs, llm: mockLLM(emptyResponse) });
    const extractor = createIncrementalExtract(deps);

    await extractor.extract("Hello", "Hi there!");

    expect(fs.files.has("/workspace/MEMORY.md")).toBe(false);
    expect(fs.files.has("/workspace/USER.md")).toBe(false);
    expect(fs.files.has("/workspace/SOUL.md")).toBe(false);
  });

  it("should append to existing files (not overwrite)", async () => {
    const fs = inMemoryFileSystem({
      "/workspace/MEMORY.md": "# Existing\n- Old note",
      "/workspace/USER.md": "# User Profile\n- Name: Garret",
    });
    const deps = makeDeps({ fs });
    const extractor = createIncrementalExtract(deps);

    await extractor.extract("I like TS", "Great choice!");

    const memory = fs.files.get("/workspace/MEMORY.md")!;
    expect(memory).toContain("Old note");
    expect(memory).toContain("TypeScript");

    const user = fs.files.get("/workspace/USER.md")!;
    expect(user).toContain("Garret");
    expect(user).toContain("TypeScript");
  });

  it("should create dirs for knowledge notes", async () => {
    const fs = inMemoryFileSystem();
    const deps = makeDeps({ fs });
    const extractor = createIncrementalExtract(deps);

    await extractor.extract("TS stuff", "Sure!");

    // The knowledge note is under topics/ subdirectory
    expect(fs.files.has("/workspace/knowledge/topics/TypeScript.md")).toBe(true);
  });

  it("should handle invalid JSON from LLM and log warning", async () => {
    const logger = capturingLogger();
    const deps = makeDeps({ llm: mockLLM("This is not JSON!"), logger });
    const extractor = createIncrementalExtract(deps);

    await extractor.extract("Hello", "Hi");

    expect(logger.calls.some((c) => c.level === "warn" && c.message.includes("failed to parse"))).toBe(true);
  });

  it("should strip markdown fences before parsing", async () => {
    const fs = inMemoryFileSystem();
    const fencedResponse = "```json\n" + fullResponse() + "\n```";
    const deps = makeDeps({ fs, llm: mockLLM(fencedResponse) });
    const extractor = createIncrementalExtract(deps);

    await extractor.extract("Hello", "Hi");

    // Should parse successfully and write MEMORY.md
    expect(fs.files.has("/workspace/MEMORY.md")).toBe(true);
  });

  it("should default missing fields to empty", async () => {
    const fs = inMemoryFileSystem();
    // Response with only some fields
    const partialResponse = JSON.stringify({ memories: [], memoryMdUpdates: "## Update" });
    const deps = makeDeps({ fs, llm: mockLLM(partialResponse) });
    const extractor = createIncrementalExtract(deps);

    await extractor.extract("Hello", "Hi");

    // memoryMdUpdates was provided, so MEMORY.md should exist
    expect(fs.files.has("/workspace/MEMORY.md")).toBe(true);
    // userMdUpdates/soulMdUpdates were missing -> defaulted to empty -> no files
    expect(fs.files.has("/workspace/USER.md")).toBe(false);
    expect(fs.files.has("/workspace/SOUL.md")).toBe(false);
  });

  it("should log warning on DB insert failure but continue", async () => {
    const logger = capturingLogger();
    const db = inMemoryDatabase();
    // Make execute throw for INSERT
    const originalExecute = db.execute.bind(db);
    db.execute = async (sql: string, params?: unknown[]) => {
      if (sql.includes("INSERT INTO memories")) {
        throw new Error("DB write error");
      }
      return originalExecute(sql, params);
    };
    const fs = inMemoryFileSystem();
    const deps = makeDeps({ fs, db, logger });
    const extractor = createIncrementalExtract(deps);

    await extractor.extract("Hello", "Hi");

    // Should warn about DB failure
    expect(logger.calls.some((c) => c.level === "warn" && c.message.includes("failed to insert"))).toBe(true);
    // But still write the markdown files
    expect(fs.files.has("/workspace/MEMORY.md")).toBe(true);
  });

  it("should log warning on knowledge note write failure", async () => {
    const logger = capturingLogger();
    const fs = inMemoryFileSystem();
    // Override writeFile to throw for knowledge paths
    const originalWriteFile = fs.writeFile.bind(fs);
    fs.writeFile = async (path: string, content: string) => {
      if (path.includes("/knowledge/")) {
        throw new Error("Write error");
      }
      return originalWriteFile(path, content);
    };
    const deps = makeDeps({ fs, logger });
    const extractor = createIncrementalExtract(deps);

    await extractor.extract("Hello", "Hi");

    expect(logger.calls.some((c) => c.level === "warn" && c.message.includes("knowledge note"))).toBe(true);
  });

  it("should show '(empty)' in prompt for empty workspace files", async () => {
    let capturedMessages: ChatMessage[] = [];
    const llm: LLMProvider = {
      id: "capture",
      name: "Capture LLM",
      async *chat(messages: ChatMessage[]): AsyncGenerator<ChatChunk> {
        capturedMessages = messages;
        yield { content: fullResponse({ memories: [], memoryMdUpdates: "", userMdUpdates: "", soulMdUpdates: "", knowledgeNotes: [] }), done: true };
      },
      async listModels() { return []; },
      async healthCheck() { return true; },
      contextWindowSize() { return 4096; },
    };
    const deps = makeDeps({ llm });
    const extractor = createIncrementalExtract(deps);

    await extractor.extract("Hi", "Hello");

    const userMsg = capturedMessages.find((m) => m.role === "user");
    expect(userMsg).toBeDefined();
    expect(userMsg!.content).toContain("(empty)");
  });

  it("should catch and log top-level errors without throwing", async () => {
    const logger = capturingLogger();
    // LLM that throws
    const throwingLLM: LLMProvider = {
      id: "throw",
      name: "Throwing LLM",
      async *chat(): AsyncGenerator<ChatChunk> {
        throw new Error("Network error");
      },
      async listModels() { return []; },
      async healthCheck() { return true; },
      contextWindowSize() { return 4096; },
    };
    const deps = makeDeps({ llm: throwingLLM, logger });
    const extractor = createIncrementalExtract(deps);

    // Should not throw
    await extractor.extract("Hello", "World");

    expect(logger.calls.some((c) => c.level === "warn" && c.message.includes("failed"))).toBe(true);
  });

  it("should not touch SOUL.md when soulMdUpdates is empty", async () => {
    const fs = inMemoryFileSystem();
    const response = fullResponse({ soulMdUpdates: "" });
    const deps = makeDeps({ fs, llm: mockLLM(response) });
    const extractor = createIncrementalExtract(deps);

    await extractor.extract("Hi", "Hello");

    expect(fs.files.has("/workspace/SOUL.md")).toBe(false);
  });

  it("should log info summary when there are updates", async () => {
    const logger = capturingLogger();
    const deps = makeDeps({ logger });
    const extractor = createIncrementalExtract(deps);

    await extractor.extract("Like TS", "Great!");

    expect(logger.calls.some((c) => c.level === "info" && c.message.includes("Incremental extract complete"))).toBe(true);
  });

  it("should not log info when nothing was extracted", async () => {
    const logger = capturingLogger();
    const emptyResponse = fullResponse({
      memories: [],
      memoryMdUpdates: "",
      userMdUpdates: "",
      soulMdUpdates: "",
      knowledgeNotes: [],
    });
    const deps = makeDeps({ logger, llm: mockLLM(emptyResponse) });
    const extractor = createIncrementalExtract(deps);

    await extractor.extract("Hi", "Hello");

    expect(logger.calls.some((c) => c.level === "info" && c.message.includes("Incremental extract complete"))).toBe(false);
  });
});
