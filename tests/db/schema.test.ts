/**
 * @fileoverview Integration tests for DB schema and client.
 * @module tests/db/schema.test
 */

import { describe, expect, it } from "bun:test";
import { openDb } from "@/db/client";

describe("db client and schema", () => {
  it("opens in-memory db and runs schema", async () => {
    const db = await openDb(":memory:");
    db.run(
      "INSERT INTO agents (id, name, model, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      ["agent-1", "Test", null, 1, Date.now(), Date.now()]
    );
    const row = db.get<{ id: string; name: string }>(
      "SELECT id, name FROM agents WHERE id = ?",
      ["agent-1"]
    );
    expect(row).toBeDefined();
    expect(row?.id).toBe("agent-1");
    expect(row?.name).toBe("Test");
    db.close();
  });

  it("creates all tables", async () => {
    const db = await openDb(":memory:");
    const agents = db.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    );
    const names = agents.map((r) => r.name);
    expect(names).toContain("agents");
    expect(names).toContain("conversations");
    expect(names).toContain("messages");
    expect(names).toContain("agent_timers");
    expect(names).toContain("permissions");
    expect(names).toContain("secrets");
    expect(names).toContain("security_violations");
    expect(names).toContain("memory_chunks");
    db.close();
  });

  it("opens file db and persists on close", async () => {
    const path = await import("node:path");
    const fs = await import("node:fs");
    const tmpDir = path.join(process.cwd(), "tmp-db-" + Date.now());
    fs.mkdirSync(tmpDir, { recursive: true });
    const dbPath = path.join(tmpDir, "test.sqlite");
    const db = await openDb(dbPath);
    db.run("INSERT INTO agents (id, name, model, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)", [
      "persist-1",
      "Persist",
      null,
      1,
      Date.now(),
      Date.now(),
    ]);
    db.close();
    const db2 = await openDb(dbPath);
    const row = db2.get<{ name: string }>("SELECT name FROM agents WHERE id = ?", ["persist-1"]);
    expect(row?.name).toBe("Persist");
    db2.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
