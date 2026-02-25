/**
 * @fileoverview Tests for PATCH /api/tasks/[id] (including realtime tasks_changed emission).
 * @module __tests__/app/api/tasks/[id]/route.test
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { _setTestContext } from "@/instrumentation";
import { makeTestContext, FakeEvents } from "@/__tests__/helpers/fakes";
import { createNextRequest } from "@/__tests__/helpers/next-request";
import { POST } from "@/app/api/tasks/route";
import { PATCH, DELETE } from "@/app/api/tasks/[id]/route";

describe("PATCH /api/tasks/[id]", () => {
  beforeEach(() => {
    _setTestContext(makeTestContext());
  });

  it("returns 404 when task does not exist", async () => {
    const req = createNextRequest("http://localhost/api/tasks/nonexistent", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "in_progress" }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ id: "nonexistent" }) });
    expect(res.status).toBe(404);
  });

  it("updates task status and emits tasks_changed", async () => {
    const events = new FakeEvents();
    const ctx = makeTestContext({ events });
    _setTestContext(ctx);

    const postReq = createNextRequest("http://localhost/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Update me" }),
    });
    const postRes = await POST(postReq);
    expect(postRes.status).toBe(201);
    const { task } = (await postRes.json()) as { task: { id: string } };
    events.reset();

    const patchReq = createNextRequest(`http://localhost/api/tasks/${task.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "in_progress" }),
    });
    const patchRes = await PATCH(patchReq, { params: Promise.resolve({ id: task.id }) });
    expect(patchRes.status).toBe(200);

    const tasksChanged = events.emitted.filter((e) => e.event === "tasks_changed");
    expect(tasksChanged.length).toBe(1);
    expect(tasksChanged[0]).toEqual({ event: "tasks_changed", data: {} });
  });
});

describe("DELETE /api/tasks/[id]", () => {
  beforeEach(() => {
    _setTestContext(makeTestContext());
  });

  it("returns 404 when task does not exist", async () => {
    const req = createNextRequest("http://localhost/api/tasks/nonexistent", { method: "DELETE" });
    const res = await DELETE(req, { params: Promise.resolve({ id: "nonexistent" }) });
    expect(res.status).toBe(404);
  });

  it("deletes task, returns 204, and emits tasks_changed", async () => {
    const events = new FakeEvents();
    const ctx = makeTestContext({ events });
    _setTestContext(ctx);

    const postReq = createNextRequest("http://localhost/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Delete me" }),
    });
    const postRes = await POST(postReq);
    expect(postRes.status).toBe(201);
    const { task } = (await postRes.json()) as { task: { id: string } };
    events.reset();

    const deleteReq = createNextRequest(`http://localhost/api/tasks/${task.id}`, { method: "DELETE" });
    const deleteRes = await DELETE(deleteReq, { params: Promise.resolve({ id: task.id }) });
    expect(deleteRes.status).toBe(204);

    const row = ctx.db.prepare("SELECT * FROM tasks WHERE id = ?").get(task.id);
    expect(row).toBeUndefined();

    const tasksChanged = events.emitted.filter((e) => e.event === "tasks_changed");
    expect(tasksChanged.length).toBe(1);
    expect(tasksChanged[0]).toEqual({ event: "tasks_changed", data: {} });
  });
});
