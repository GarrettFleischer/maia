/**
 * @fileoverview Tools for layered memory: registry, graph episodes, session compaction, PARA, daily notes.
 * @module lib/tools/layered-memory-tools
 */

import { z } from "zod";
import { zodToJsonSchema } from "../zod-to-json";
import { createEmbeddingAdapter } from "../knowledge/embedding";
import { getSettings } from "../settings";
import {
  insertRegistryMemory,
  searchRegistryMemories,
  pruneRegistryIfOverCap,
} from "../memory/registry";
import {
  insertMemoryEpisode,
  searchMemoryEpisodes,
  insertMemoryEntity,
  insertMemoryEdge,
  expandGraphNeighbors,
} from "../memory/graph";
import {
  insertSessionCompaction,
  listSessionCompactions,
  expandSessionCompaction,
} from "../memory/compaction";
import {
  readParaItemsFile,
  upsertParaFact,
  collectActiveParaFacts,
} from "../memory/para";
import { readDailyNote, appendDailyNote } from "../memory/daily-notes";
import type { Tool, ToolContext } from "./types";

function makeTool<S extends z.ZodTypeAny>(
  name: string,
  description: string,
  schema: S,
  execute: (args: z.infer<S>, ctx: ToolContext) => Promise<unknown>,
): Tool<z.infer<S>> {
  return {
    name,
    description,
    schema,
    execute,
    toDefinition: () => ({
      name,
      description,
      parameters: zodToJsonSchema(schema),
    }),
  };
}

export const memoryRememberTool = makeTool(
  "memory_remember",
  "Store a durable memory in the pre-prompt registry (auto-recall). Use for explicit user facts to remember. Example: memory_remember({ text: 'User prefers dark mode', quality: 0.9 }).",
  z.object({
    text: z.string().describe("Fact or memory to store"),
    quality: z.number().min(0).max(1).optional().describe("Quality 0–1 (default 1)"),
  }),
  async ({ text, quality }, ctx) => {
    const settings = getSettings(ctx);
    const embedder = createEmbeddingAdapter(settings, ctx.http);
    const emb = await embedder.embed(text);
    const id = insertRegistryMemory(
      ctx,
      ctx.agentId,
      text,
      emb,
      "explicit",
      quality ?? 1,
    );
    pruneRegistryIfOverCap(ctx, ctx.agentId, 500);
    return { id };
  },
);

export const memoryRegistrySearchTool = makeTool(
  "memory_registry_search",
  "Semantic search the agent memory registry (Gigabrain layer). Example: memory_registry_search({ q: 'pricing' }).",
  z.object({
    q: z.string().describe("Query"),
    limit: z.number().min(1).max(20).optional(),
  }),
  async ({ q, limit }, ctx) => {
    const settings = getSettings(ctx);
    const embedder = createEmbeddingAdapter(settings, ctx.http);
    const emb = await embedder.embed(q);
    return searchRegistryMemories(ctx, ctx.agentId, emb, limit ?? 8);
  },
);

export const memoryGraphSearchTool = makeTool(
  "memory_graph_search",
  "Cross-session episode memory with optional graph neighbor hints. Example: memory_graph_search({ q: 'last week deployment' }).",
  z.object({
    q: z.string().describe("Query"),
    limit: z.number().min(1).max(20).optional(),
  }),
  async ({ q, limit }, ctx) => {
    const settings = getSettings(ctx);
    const embedder = createEmbeddingAdapter(settings, ctx.http);
    const emb = await embedder.embed(q);
    return searchMemoryEpisodes(ctx, ctx.agentId, emb, limit ?? 8);
  },
);

export const memoryEpisodeRecordTool = makeTool(
  "memory_episode_record",
  "Record a summarized episode linked to history entry ids for cross-session recall. Example: memory_episode_record({ session_id, entry_ids, summary }).",
  z.object({
    session_id: z.string().describe("Session id"),
    entry_ids: z.array(z.string()).describe("History entry UUIDs covered"),
    summary: z.string().describe("Short episode summary"),
  }),
  async ({ session_id, entry_ids, summary }, ctx) => {
    const settings = getSettings(ctx);
    const embedder = createEmbeddingAdapter(settings, ctx.http);
    const emb = await embedder.embed(summary);
    const id = insertMemoryEpisode(
      ctx,
      ctx.agentId,
      session_id,
      entry_ids,
      summary,
      emb,
    );
    return { id };
  },
);

export const memoryEntityLinkTool = makeTool(
  "memory_entity_link",
  "Create an entity and optional relationship edge between two graph ids (episode or entity ids). Example: memory_entity_link({ name, kind, from_id, to_id, relation }).",
  z.object({
    name: z.string().describe("Entity display name"),
    kind: z.string().optional().describe("Entity kind label"),
    from_id: z.string().optional().describe("Edge tail (optional)"),
    to_id: z.string().optional().describe("Edge head (optional)"),
    relation: z.string().optional().describe("Edge label when both ends set"),
  }),
  async ({ name, kind, from_id, to_id, relation }, ctx) => {
    const entityId = insertMemoryEntity(ctx, ctx.agentId, name, kind ?? "entity", {});
    let edgeId: string | undefined;
    if (from_id && to_id && relation) {
      edgeId = insertMemoryEdge(ctx, ctx.agentId, from_id, to_id, relation);
    }
    return { entityId, edgeId, neighbors: expandGraphNeighbors(ctx, ctx.agentId, entityId) };
  },
);

export const sessionCompactionListTool = makeTool(
  "session_compaction_list",
  "List structured session compaction summaries (LCM layer). Example: session_compaction_list({ session_id }).",
  z.object({
    session_id: z.string().describe("Session id"),
  }),
  async ({ session_id }, ctx) => listSessionCompactions(ctx, session_id),
);

export const sessionCompactionExpandTool = makeTool(
  "session_compaction_expand",
  "Expand a compaction to full source history entries by id. Example: session_compaction_expand({ compaction_id }).",
  z.object({
    compaction_id: z.string().describe("Compaction row id"),
  }),
  async ({ compaction_id }, ctx) => expandSessionCompaction(ctx, compaction_id),
);

export const sessionCompactionSaveTool = makeTool(
  "session_compaction_save",
  "Record a session compaction summary with source entry ids for later expansion. Example: session_compaction_save({ session_id, summary, source_entry_ids }).",
  z.object({
    session_id: z.string(),
    summary: z.string(),
    source_entry_ids: z.array(z.string()),
  }),
  async ({ session_id, summary, source_entry_ids }, ctx) => ({
    id: insertSessionCompaction(ctx, session_id, summary, source_entry_ids),
  }),
);

export const paraFactReadTool = makeTool(
  "para_fact_read",
  "Read active PARA facts from life/<path>/items.json. Example: para_fact_read({ path: 'projects/my-app/items.json' }).",
  z.object({
    path: z.string().describe("Path under agent life/ to items.json"),
  }),
  async ({ path }, ctx) => readParaItemsFile(ctx, ctx.agentId, path),
);

export const paraFactUpsertTool = makeTool(
  "para_fact_upsert",
  "Upsert an atomic PARA fact (prior facts with same id become superseded). Example: para_fact_upsert({ path, id, fact, category, source }).",
  z.object({
    path: z.string().describe("Path under life/ to items.json"),
    id: z.string().describe("Stable fact id"),
    fact: z.string().describe("Single atomic fact sentence"),
    category: z.string().optional(),
    source: z.string().optional(),
  }),
  async ({ path, id, fact, category, source }, ctx) => {
    const now = new Date().toISOString();
    upsertParaFact(ctx, ctx.agentId, path, {
      id,
      fact,
      category: category ?? "general",
      created_at: now,
      source: source ?? "agent",
      status: "active",
    });
    return { ok: true };
  },
);

export const paraFactScanTool = makeTool(
  "para_fact_scan",
  "Scan active PARA items across life/**/items.json (bounded). Example: para_fact_scan({ max_files: 10 }).",
  z.object({
    max_files: z.number().min(1).max(50).optional(),
  }),
  async ({ max_files }, ctx) =>
    collectActiveParaFacts(ctx, ctx.agentId, max_files ?? 12),
);

export const dailyNoteReadTool = makeTool(
  "daily_note_read",
  "Read the operational daily note for a date (ISO). Defaults to today. Example: daily_note_read({ date: '2026-03-30' }).",
  z.object({
    date: z.string().optional().describe("ISO date; default today"),
  }),
  async ({ date }, ctx) => {
    const d = date ?? new Date().toISOString();
    return { content: readDailyNote(ctx, ctx.agentId, d) };
  },
);

export const dailyNoteAppendTool = makeTool(
  "daily_note_append",
  "Append a section to today’s daily operational log. Example: daily_note_append({ section: 'Shipped feature X.' }).",
  z.object({
    section: z.string().describe("Markdown section to append"),
    date: z.string().optional().describe("ISO date key; default today"),
  }),
  async ({ section, date }, ctx) => {
    appendDailyNote(ctx, ctx.agentId, date ?? new Date().toISOString(), section);
    return { ok: true };
  },
);

export const layeredMemoryTools: Tool[] = [
  memoryRememberTool,
  memoryRegistrySearchTool,
  memoryGraphSearchTool,
  memoryEpisodeRecordTool,
  memoryEntityLinkTool,
  sessionCompactionListTool,
  sessionCompactionExpandTool,
  sessionCompactionSaveTool,
  paraFactReadTool,
  paraFactUpsertTool,
  paraFactScanTool,
  dailyNoteReadTool,
  dailyNoteAppendTool,
];
