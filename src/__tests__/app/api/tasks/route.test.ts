/**
 * @fileoverview Tests for GET/POST /api/tasks (including realtime tasks_changed emission).
 * @module __tests__/app/api/tasks/route.test
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { _setTestContext } from "@/instrumentation";
import { makeTestContext, FakeEvents } from "@/__tests__/helpers/fakes";
import { createNextRequest } from "@/__tests__/helpers/next-request";
import { GET, POST } from "@/app/api/tasks/route";

describe("GET /api/tasks", () => {
  beforeEach(() => {
    _setTestContext(makeTestContext());
  });

  it("returns empty tasks list when none exist", async () => {
    const req = createNextRequest("http://localhost/api/tasks");
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tasks: unknown[] };
    expect(body.tasks).toEqual([]);
  });
});

describe("POST /api/tasks", () => {
  beforeEach(() => {
    _setTestContext(makeTestContext());
  });

  it("creates task and returns 201", async () => {
    const req = createNextRequest("http://localhost/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Test task" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { task: { id: string; title: string } };
    expect(body.task.title).toBe("Test task");
    expect(body.task.id).toBeDefined();
  });

  it("emits tasks_changed so task board can update in realtime", async () => {
    const events = new FakeEvents();
    _setTestContext(makeTestContext({ events }));

    const req = createNextRequest("http://localhost/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Realtime task" }),
    });
    await POST(req);

    const tasksChanged = events.emitted.filter((e) => e.event === "tasks_changed");
    expect(tasksChanged.length).toBe(1);
    expect(tasksChanged[0]).toEqual({ event: "tasks_changed", data: {} });
  });
});
