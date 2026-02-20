/**
 * @fileoverview Integration tests for agent_timers CRUD.
 * @module tests/db/timers.test
 */

import { describe, expect, it } from "bun:test";
import { openDb } from "@/db/client";
import { createTimerRepository } from "@/db/timers";

describe("timer repository", () => {
  it("create and get timer", async () => {
    const db = await openDb(":memory:");
    const repo = createTimerRepository(db);
    const fireAt = Date.now() + 60_000;
    const id = await repo.create({
      agent_id: "agent-1",
      fire_at_ms: fireAt,
      repeat_ms: 0,
    });
    expect(id).toBeDefined();
    const t = await repo.get(id);
    expect(t).not.toBeNull();
    expect(t?.agent_id).toBe("agent-1");
    expect(t?.fire_at_ms).toBe(fireAt);
    expect(t?.repeat_ms).toBe(0);
    db.close();
  });

  it("listDue returns timers with fire_at_ms <= now", async () => {
    const db = await openDb(":memory:");
    const repo = createTimerRepository(db);
    const now = Date.now();
    await repo.create({ agent_id: "a1", fire_at_ms: now - 1000, repeat_ms: 0 });
    await repo.create({ agent_id: "a2", fire_at_ms: now + 1000, repeat_ms: 0 });
    const due = await repo.listDue(now);
    expect(due.length).toBe(1);
    expect(due[0].agent_id).toBe("a1");
    db.close();
  });

  it("listByAgent and listAll", async () => {
    const db = await openDb(":memory:");
    const repo = createTimerRepository(db);
    await repo.create({ agent_id: "a1", fire_at_ms: 100, repeat_ms: 0 });
    await repo.create({ agent_id: "a1", fire_at_ms: 200, repeat_ms: 0 });
    await repo.create({ agent_id: "a2", fire_at_ms: 300, repeat_ms: 0 });
    const byAgent = await repo.listByAgent("a1");
    expect(byAgent).toHaveLength(2);
    const all = await repo.listAll();
    expect(all).toHaveLength(3);
    db.close();
  });

  it("update next fire and delete", async () => {
    const db = await openDb(":memory:");
    const repo = createTimerRepository(db);
    const id = await repo.create({
      agent_id: "a1",
      fire_at_ms: Date.now(),
      repeat_ms: 5000,
    });
    await repo.updateNextFire(id, Date.now() + 5000);
    const t = await repo.get(id);
    expect(t?.fire_at_ms).toBeGreaterThan(Date.now());
    await repo.delete(id);
    expect(await repo.get(id)).toBeNull();
    db.close();
  });
});
