/**
 * @fileoverview Tests for permissions (approval) repository.
 * @module tests/db/permissions.test
 */

import { describe, expect, it } from "bun:test";
import { openDb } from "@/db/client";
import { createPermissionsRepository } from "@/db/permissions";

describe("permissions repository", () => {
  it("record and get permission", async () => {
    const db = await openDb(":memory:");
    const repo = createPermissionsRepository(db);
    await repo.record("agent-1", "terminal", true);
    const result = await repo.get("agent-1", "terminal");
    expect(result).toBe(true);
    db.close();
  });

  it("get returns null when no permission recorded", async () => {
    const db = await openDb(":memory:");
    const repo = createPermissionsRepository(db);
    const result = await repo.get("agent-1", "terminal");
    expect(result).toBeNull();
    db.close();
  });

  it("latest permission wins for same agent and tool", async () => {
    const db = await openDb(":memory:");
    const repo = createPermissionsRepository(db);
    await repo.record("agent-1", "terminal", true);
    await repo.record("agent-1", "terminal", false);
    const result = await repo.get("agent-1", "terminal");
    expect(result).toBe(false);
    db.close();
  });
});
