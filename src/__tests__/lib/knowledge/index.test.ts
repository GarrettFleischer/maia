/**
 * @fileoverview Tests for knowledge base index (Muninn-only).
 * @module __tests__/lib/knowledge/index
 */
import path from "path";
import { describe, it, expect, beforeEach } from "bun:test";
import {
  makeTestContext,
  FakeHttp,
  FakeResponse,
} from "@/__tests__/helpers/fakes";
import { runKnowledgeIndex, DATA_DIR } from "@/lib/knowledge/index";
import type { AppContext } from "@/lib/context";

describe("knowledge index", () => {
  let ctx: AppContext;

  beforeEach(() => {
    ctx = makeTestContext();
  });

  it("returns 0 indexed when Muninn not configured", async () => {
    const result = await runKnowledgeIndex(ctx, {});
    expect(result.indexed).toBe(0);
    expect(result.removed).toBe(0);
  });

  it("creates knowledge dir and returns 0 indexed when dir empty and Muninn enabled", async () => {
    ctx.db
      .prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)")
      .run("muninnUrl", "http://localhost:8475");
    const http = new FakeHttp();
    http.on(
      "/api/engrams",
      async () => new FakeResponse(200, JSON.stringify({ id: "eng-1" })),
    );
    ctx = { ...ctx, http };
    const result = await runKnowledgeIndex(ctx, {});
    expect(result.indexed).toBe(0);
    expect(result.removed).toBe(0);
  });

  it("indexes markdown files when Muninn enabled", async () => {
    ctx.db
      .prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)")
      .run("muninnUrl", "http://localhost:8475");
    let capturedBody: Record<string, unknown> = {};
    const http = new FakeHttp();
    http.on("/api/engrams", async (_url, init) => {
      const body =
        init?.body && typeof init.body === "string"
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : {};
      capturedBody = body;
      return new FakeResponse(200, JSON.stringify({ id: "eng-1" }));
    });
    ctx = { ...ctx, http };
    ctx.fs.mkdirp(DATA_DIR);
    ctx.fs.writeFile(
      path.join(DATA_DIR, "report.md"),
      "# Report\n\nContent here.",
    );

    const result = await runKnowledgeIndex(ctx, {});
    expect(result.indexed).toBe(1);
    expect(result.removed).toBe(0);
    expect(capturedBody.vault).toBe("default");
    expect(capturedBody.concept).toBe("report.md");
    expect((capturedBody.content as string).trim()).toBe(
      "# Report\n\nContent here.",
    );
    expect(capturedBody.tags).toEqual(["knowledge", "report.md"]);
  });

  it("returns 0 indexed when file deleted from disk (no remove tracking)", async () => {
    ctx.db
      .prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)")
      .run("muninnUrl", "http://localhost:8475");
    const http = new FakeHttp();
    http.on(
      "/api/engrams",
      async () => new FakeResponse(200, JSON.stringify({ id: "eng-1" })),
    );
    ctx = { ...ctx, http };
    ctx.fs.mkdirp(DATA_DIR);
    ctx.fs.writeFile(path.join(DATA_DIR, "gone.md"), "content");
    await runKnowledgeIndex(ctx, {});

    ctx.fs.deleteFile(path.join(DATA_DIR, "gone.md"));
    const result = await runKnowledgeIndex(ctx, {});
    expect(result.indexed).toBe(0);
    expect(result.removed).toBe(0);
  });

  it("truncates content to 16K when writing to Muninn", async () => {
    ctx.db
      .prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)")
      .run("muninnUrl", "http://localhost:8475");
    let capturedContentLength = 0;
    const http = new FakeHttp();
    http.on("/api/engrams", async (_url, init) => {
      const body =
        init?.body && typeof init.body === "string"
          ? (JSON.parse(init.body) as { content: string })
          : { content: "" };
      capturedContentLength = body.content.length;
      return new FakeResponse(200, JSON.stringify({ id: "eng-1" }));
    });
    ctx = { ...ctx, http };
    ctx.fs.mkdirp(DATA_DIR);
    const longContent = "x".repeat(20 * 1024);
    ctx.fs.writeFile(path.join(DATA_DIR, "long.md"), longContent);

    await runKnowledgeIndex(ctx, {});
    expect(capturedContentLength).toBe(16 * 1024);
  });
});
