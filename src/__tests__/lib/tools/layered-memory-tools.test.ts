/**
 * @fileoverview Integration tests for layered memory tools (embed + db + optional fs paths).
 * @module __tests__/lib/tools/layered-memory-tools
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "fs";
import path from "path";
import { makeTestContext, FakeHttp, FakeResponse, FakeFs } from "../../helpers/fakes";
import type { ToolContext } from "@/lib/tools/types";
import {
  memoryRememberTool,
  memoryRegistrySearchTool,
  memoryGraphSearchTool,
  memoryEpisodeRecordTool,
  memoryEntityLinkTool,
  sessionCompactionListTool,
  sessionCompactionSaveTool,
  sessionCompactionExpandTool,
  paraFactReadTool,
  paraFactUpsertTool,
  paraFactScanTool,
  dailyNoteReadTool,
  dailyNoteAppendTool,
} from "@/lib/tools/layered-memory-tools";
import { createSession, appendEntry } from "@/lib/history";
import { getAgentDir } from "@/lib/data-dir";

describe("layered memory tools", () => {
  let tmpRoot: string;
  let prevDataDir: string | undefined;

  beforeEach(() => {
    prevDataDir = process.env.MAIA_DATA_DIR;
    tmpRoot = path.join(process.cwd(), ".tmp-layered-memory-test");
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    fs.mkdirSync(tmpRoot, { recursive: true });
    process.env.MAIA_DATA_DIR = tmpRoot;
  });

  afterEach(() => {
    if (prevDataDir !== undefined) process.env.MAIA_DATA_DIR = prevDataDir;
    else delete process.env.MAIA_DATA_DIR;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function toolCtx(agentId = "maia-tool"): ToolContext {
    const ctx = makeTestContext();
    const http = ctx.http as FakeHttp;
    http.on("/api/embed", async () =>
      new FakeResponse(200, JSON.stringify({ embedding: [1, 0, 0] })),
    );
    return {
      ...ctx,
      http,
      agentId,
      sessionId: "sess-tool",
      volumeRoot: "/unused",
    };
  }

  it("memory_remember and memory_registry_search round-trip", async () => {
    const ctx = toolCtx();
    const r1 = await memoryRememberTool.execute({ text: "User likes tea" }, ctx);
    expect(typeof (r1 as { id: string }).id).toBe("string");
    const r2 = await memoryRegistrySearchTool.execute({ q: "tea" }, ctx);
    expect(Array.isArray(r2)).toBe(true);
    expect((r2 as { id: string }[]).length).toBeGreaterThanOrEqual(1);
  });

  it("memory_graph_search and memory_episode_record", async () => {
    const ctx = toolCtx();
    await memoryEpisodeRecordTool.execute(
      {
        session_id: "s1",
        entry_ids: ["e1"],
        summary: "released v2",
      },
      ctx,
    );
    const hits = await memoryGraphSearchTool.execute({ q: "release" }, ctx);
    expect(Array.isArray(hits)).toBe(true);
    expect((hits as { summary: string }[]).length).toBeGreaterThanOrEqual(1);
  });

  it("memory_entity_link with edge and without edge", async () => {
    const ctx = toolCtx();
    const withEdge = await memoryEntityLinkTool.execute(
      {
        name: "Node A",
        kind: "thing",
        from_id: "f1",
        to_id: "t1",
        relation: "links",
      },
      ctx,
    );
    expect(typeof (withEdge as { entityId: string }).entityId).toBe("string");
    expect(typeof (withEdge as { edgeId?: string }).edgeId).toBe("string");

    const noEdge = await memoryEntityLinkTool.execute({ name: "Solo" }, ctx);
    expect((noEdge as { edgeId?: string }).edgeId).toBeUndefined();
  });

  it("session compaction save list expand", async () => {
    const ctx = toolCtx();
    const appCtx = ctx;
    const sessionId = createSession(appCtx);
    const entry = appendEntry(appCtx, sessionId, {
      role: "user",
      content: "ping",
      timestamp: new Date().toISOString(),
    });
    const save = await sessionCompactionSaveTool.execute(
      {
        session_id: sessionId,
        summary: " brief ",
        source_entry_ids: [entry.id],
      },
      ctx,
    );
    const cid = (save as { id: string }).id;
    const listed = await sessionCompactionListTool.execute(
      { session_id: sessionId },
      ctx,
    );
    expect((listed as unknown[]).length).toBeGreaterThanOrEqual(1);
    const expanded = await sessionCompactionExpandTool.execute(
      { compaction_id: cid },
      ctx,
    );
    const ex = expanded as { entries: { id: string }[] };
    expect(ex.entries.some((e) => e.id === entry.id)).toBe(true);
  });

  it("para_fact_read upsert scan and daily notes", async () => {
    const agentId = "para-agent";
    const ctx = toolCtx(agentId);
    const lifeRel = "projects/p1/items.json";
    const itemsPath = path.join(getAgentDir(agentId), "life", lifeRel.replace(/\//g, path.sep));
    const fsAdapter = ctx.fs as FakeFs;
    fsAdapter.seed(
      itemsPath,
      JSON.stringify([
        {
          id: "f1",
          fact: "Hello",
          category: "general",
          created_at: "2026-01-01",
          source: "user",
          status: "active",
          access_count: 0,
          last_accessed_at: "2026-01-01",
        },
      ]),
    );

    const read = await paraFactReadTool.execute({ path: lifeRel }, ctx);
    expect(Array.isArray(read)).toBe(true);
    expect((read as { fact: string }[])[0].fact).toBe("Hello");

    await paraFactUpsertTool.execute(
      {
        path: lifeRel,
        id: "f2",
        fact: "New fact",
        category: "x",
        source: "test",
      },
      ctx,
    );

    const scan = await paraFactScanTool.execute({ max_files: 5 }, ctx);
    expect(Array.isArray(scan)).toBe(true);
    const blocks = scan as { path: string; facts: { fact: string }[] }[];
    const flat = blocks.flatMap((b) => b.facts);
    expect(flat.some((f) => f.fact === "New fact")).toBe(true);

    const iso = "2026-05-04T12:00:00.000Z";
    const emptyDay = await dailyNoteReadTool.execute({ date: iso }, ctx);
    expect((emptyDay as { content: string }).content).toBe("");

    await dailyNoteAppendTool.execute(
      { section: "Done task", date: iso },
      ctx,
    );
    const after = await dailyNoteReadTool.execute({ date: iso }, ctx);
    expect((after as { content: string }).content).toContain("Done task");
  });
});
