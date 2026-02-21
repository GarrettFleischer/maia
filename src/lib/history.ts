import { v4 as uuidv4 } from "uuid";
import type { AppContext } from "./context";
import type { HistoryEntry, Session, SessionMeta } from "./types";

// -- Session CRUD --

export function createSession(
  ctx: AppContext,
  participants: string[] = ["user", "maia"],
  type: "user" | "agents" = "user"
): string {
  const id = uuidv4();
  const now = new Date().toISOString();
  ctx.db.prepare(
    `INSERT INTO sessions (id, name, description, participants, tags, type, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, "", "", JSON.stringify(participants), JSON.stringify([]), type, now, now);
  return id;
}

export function listSessions(
  ctx: AppContext,
  type?: "user" | "agents" | "all"
): SessionMeta[] {
  let rows: Record<string, unknown>[];
  if (!type || type === "all") {
    rows = ctx.db
      .prepare("SELECT * FROM sessions ORDER BY updated_at DESC")
      .all() as Record<string, unknown>[];
  } else {
    rows = ctx.db
      .prepare("SELECT * FROM sessions WHERE type = ? ORDER BY updated_at DESC")
      .all(type) as Record<string, unknown>[];
  }
  return rows.map(rowToMeta);
}

export function getSession(ctx: AppContext, id: string): Session | null {
  const row = ctx.db
    .prepare("SELECT * FROM sessions WHERE id = ?")
    .get(id) as Record<string, unknown> | undefined;
  if (!row) return null;

  const original = ctx.db
    .prepare(
      "SELECT * FROM history_entries WHERE session_id = ? AND is_compressed = 0 ORDER BY timestamp ASC"
    )
    .all(id) as Record<string, unknown>[];

  const compressed = ctx.db
    .prepare(
      "SELECT * FROM history_entries WHERE session_id = ? AND is_compressed = 1 ORDER BY timestamp ASC"
    )
    .all(id) as Record<string, unknown>[];

  return {
    ...rowToMeta(row),
    original: original.map(rowToEntry),
    compressed: compressed.map(rowToEntry),
  };
}

export function updateSessionMeta(
  ctx: AppContext,
  id: string,
  meta: Partial<{ name: string; description: string; tags: string[] }>
): void {
  const parts: string[] = [];
  const vals: unknown[] = [];
  if (meta.name !== undefined) { parts.push("name = ?"); vals.push(meta.name); }
  if (meta.description !== undefined) { parts.push("description = ?"); vals.push(meta.description); }
  if (meta.tags !== undefined) { parts.push("tags = ?"); vals.push(JSON.stringify(meta.tags)); }
  parts.push("updated_at = ?");
  vals.push(new Date().toISOString());
  vals.push(id);
  ctx.db.prepare(`UPDATE sessions SET ${parts.join(", ")} WHERE id = ?`).run(...vals);
}

// -- Entry management --

export function appendEntry(
  ctx: AppContext,
  sessionId: string,
  entry: Omit<HistoryEntry, "id">,
  isCompressed = false
): HistoryEntry {
  const id = uuidv4();
  ctx.db.prepare(
    `INSERT INTO history_entries (id, session_id, role, content, tool_name, tool_args, timestamp, is_compressed)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    sessionId,
    entry.role,
    entry.content,
    entry.toolName ?? null,
    entry.toolArgs ? JSON.stringify(entry.toolArgs) : null,
    entry.timestamp,
    isCompressed ? 1 : 0
  );
  // bump session updated_at
  ctx.db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(
    new Date().toISOString(),
    sessionId
  );
  return { ...entry, id };
}

// -- Active session --

export function getActiveSessionId(ctx: AppContext): string | null {
  const row = ctx.db
    .prepare("SELECT session_id FROM active_session WHERE singleton = 1")
    .get() as { session_id: string | null } | undefined;
  return row?.session_id ?? null;
}

export function setActiveSessionId(ctx: AppContext, sessionId: string): void {
  ctx.db
    .prepare("UPDATE active_session SET session_id = ? WHERE singleton = 1")
    .run(sessionId);
}

// -- Fuzzy search --

export function searchEntries(
  ctx: AppContext,
  query: string,
  sessionId?: string,
  mode: "compressed" | "original" | "both" = "both"
): HistoryEntry[] {
  const keywords = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!keywords.length) return [];

  const compressionFilter =
    mode === "both" ? "" : `AND is_compressed = ${mode === "compressed" ? 1 : 0}`;

  let rows: Record<string, unknown>[];
  if (sessionId) {
    rows = ctx.db
      .prepare(
        `SELECT * FROM history_entries WHERE session_id = ? ${compressionFilter} ORDER BY timestamp ASC`
      )
      .all(sessionId) as Record<string, unknown>[];
  } else {
    rows = ctx.db
      .prepare(
        `SELECT * FROM history_entries WHERE 1=1 ${compressionFilter} ORDER BY timestamp ASC`
      )
      .all() as Record<string, unknown>[];
  }

  return rows
    .map((r) => ({ entry: rowToEntry(r), row: r }))
    .filter(({ entry }) => {
      const text = entry.content.toLowerCase();
      const hits = keywords.filter((kw) => text.includes(kw)).length;
      return hits / keywords.length >= 0.5;
    })
    .map(({ entry }) => entry);
}

export function searchAcrossSessions(
  ctx: AppContext,
  query: string,
  mode: "compressed" | "original" | "both" = "both",
  tags?: string[]
): { sessionId: string; sessionName: string; entries: HistoryEntry[] }[] {
  const sessions = listSessions(ctx, "all");
  const filtered = tags?.length
    ? sessions.filter((s) => tags.some((t) => s.tags.includes(t)))
    : sessions;

  const results = [];
  for (const s of filtered) {
    const entries = searchEntries(ctx, query, s.id, mode);
    if (entries.length) {
      results.push({ sessionId: s.id, sessionName: s.name, entries });
    }
  }
  return results;
}

// -- Row mappers --

function rowToMeta(r: Record<string, unknown>): SessionMeta {
  return {
    id: r.id as string,
    name: r.name as string,
    description: r.description as string,
    participants: JSON.parse(r.participants as string),
    tags: JSON.parse(r.tags as string),
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

function rowToEntry(r: Record<string, unknown>): HistoryEntry {
  return {
    id: r.id as string,
    role: r.role as HistoryEntry["role"],
    content: r.content as string,
    toolName: r.tool_name as string | undefined,
    toolArgs: r.tool_args ? JSON.parse(r.tool_args as string) : undefined,
    timestamp: r.timestamp as string,
  };
}
