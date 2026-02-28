/**
 * @fileoverview Tests for GET /api/dashboard (agents, task counts, recent sessions, cron jobs).
 * @module __tests__/app/api/dashboard/route.test
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { _setTestContext } from "@/instrumentation";
import { makeTestContext } from "@/__tests__/helpers/fakes";
import { initMaiaAgent } from "@/lib/init";
import { createNextRequest } from "@/__tests__/helpers/next-request";
import { GET } from "@/app/api/dashboard/route";

describe("GET /api/dashboard", () => {
  beforeEach(() => {
    const ctx = makeTestContext();
    initMaiaAgent(ctx);
    _setTestContext(ctx);
  });

  it("returns 200 and dashboard shape with agents, taskCountsByStatus, taskCountsByAgent, recentAgentSessions, cronJobs", async () => {
    const req = createNextRequest("http://localhost/api/dashboard");
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      agents: { id: string; name: string; model: string; status: string }[];
      taskCountsByStatus: { todo: number; in_progress: number; done: number };
      taskCountsByAgent: Record<string, { todo: number; in_progress: number; done: number }>;
      recentAgentSessions: { id: string; name: string; participants: string[]; updatedAt: string }[];
      cronJobs: { id: string; expression: string; taskDescription: string; agentId: string; isBuiltIn: boolean }[];
    };
    expect(body.agents).toBeDefined();
    expect(Array.isArray(body.agents)).toBe(true);
    expect(body.agents.some((a) => a.id === "maia")).toBe(true);
    expect(body.taskCountsByStatus).toBeDefined();
    expect(body.taskCountsByStatus).toEqual({ todo: 0, in_progress: 0, done: 0 });
    expect(body.taskCountsByAgent).toBeDefined();
    expect(typeof body.taskCountsByAgent).toBe("object");
    expect(body.recentAgentSessions).toBeDefined();
    expect(Array.isArray(body.recentAgentSessions)).toBe(true);
    expect(body.cronJobs).toBeDefined();
    expect(Array.isArray(body.cronJobs)).toBe(true);
  });

  it("returns task counts by status when tasks exist", async () => {
    const ctx = makeTestContext();
    initMaiaAgent(ctx);
    const now = new Date().toISOString();
    ctx.db.prepare(
      `INSERT INTO tasks (id, title, description, status, created_by, assigned_to, created_at, updated_at, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run("t1", "Task 1", "", "todo", "user", null, now, now, "[]");
    ctx.db.prepare(
      `INSERT INTO tasks (id, title, description, status, created_by, assigned_to, created_at, updated_at, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run("t2", "Task 2", "", "in_progress", "user", "maia", now, now, "[]");
    ctx.db.prepare(
      `INSERT INTO tasks (id, title, description, status, created_by, assigned_to, created_at, updated_at, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run("t3", "Task 3", "", "done", "user", "maia", now, now, "[]");
    _setTestContext(ctx);

    const req = createNextRequest("http://localhost/api/dashboard");
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json() as { taskCountsByStatus: { todo: number; in_progress: number; done: number }; taskCountsByAgent: Record<string, { todo: number; in_progress: number; done: number }> };
    expect(body.taskCountsByStatus).toEqual({ todo: 1, in_progress: 1, done: 1 });
    expect(body.taskCountsByAgent.maia).toEqual({ todo: 0, in_progress: 1, done: 1 });
  });

  it("returns recent agent sessions when type=agents sessions exist", async () => {
    const ctx = makeTestContext();
    initMaiaAgent(ctx);
    const now = new Date().toISOString();
    ctx.db.prepare(
      `INSERT INTO sessions (id, name, description, participants, tags, type, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run("s1", "Agent run", "", '["maia","helper"]', "[]", "agents", now, now);
    _setTestContext(ctx);

    const req = createNextRequest("http://localhost/api/dashboard");
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json() as { recentAgentSessions: { id: string; name: string; participants: string[]; updatedAt: string }[] };
    expect(body.recentAgentSessions.length).toBeGreaterThanOrEqual(1);
    const session = body.recentAgentSessions.find((s) => s.id === "s1");
    expect(session).toBeDefined();
    expect(session!.name).toBe("Agent run");
    expect(session!.participants).toEqual(["maia", "helper"]);
    expect(session!.updatedAt).toBe(now);
  });

  it("includes cron jobs array (heartbeat is optional; user can ask Maia to create it)", async () => {
    const req = createNextRequest("http://localhost/api/dashboard");
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json() as { cronJobs: { id: string; agentId: string; isBuiltIn: boolean }[] };
    expect(Array.isArray(body.cronJobs)).toBe(true);
  });
});
