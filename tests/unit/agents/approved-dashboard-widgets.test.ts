/**
 * @fileoverview Unit tests for the approved dashboard widgets repository.
 * @module tests/unit/agents/approved-dashboard-widgets
 *
 * @brief Covers create, getByAgentAndWidget, and listByAgent used by the
 * dashboard API and by the widget approval flow (dynamic iframe loading).
 */

import { describe, it, expect, beforeAll } from "bun:test";
import { createApprovedDashboardWidgetsRepository } from "../../../src/agents/approved-dashboard-widgets.js";
import { capturingLogger } from "../../helpers/index.js";
import { createSQLiteDatabase } from "../../../src/adapters/database.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";

async function createTestDb(): Promise<ReturnType<typeof createSQLiteDatabase>> {
  const db = createSQLiteDatabase(":memory:");
  const sqlPath = path.resolve(
    "src/core/migrations/migrations/010_add_widget_review_and_approved_widgets.sql"
  );
  const sql = await fs.readFile(sqlPath, "utf-8");
  await db.execute(sql);
  return db;
}

describe("ApprovedDashboardWidgetsRepository", () => {
  let db: ReturnType<typeof createSQLiteDatabase>;

  beforeAll(async () => {
    db = await createTestDb();
  });

  it("create inserts a widget and returns it with createdAt", async () => {
    const repo = createApprovedDashboardWidgetsRepository({
      db,
      logger: capturingLogger(),
    });
    const w = await repo.create({
      id: "w-1",
      agentId: "agent-a",
      widgetId: "my-panel",
      name: "My Panel",
      html: "<div>Hello</div>",
      css: "div { color: blue; }",
      js: "console.log('ok');",
    });
    expect(w.id).toBe("w-1");
    expect(w.agentId).toBe("agent-a");
    expect(w.widgetId).toBe("my-panel");
    expect(w.name).toBe("My Panel");
    expect(w.html).toBe("<div>Hello</div>");
    expect(w.css).toBe("div { color: blue; }");
    expect(w.js).toBe("console.log('ok');");
    expect(w.createdAt).toBeTruthy();
  });

  it("getByAgentAndWidget returns undefined for missing widget", async () => {
    const repo = createApprovedDashboardWidgetsRepository({
      db,
      logger: capturingLogger(),
    });
    const got = await repo.getByAgentAndWidget("agent-a", "nonexistent");
    expect(got).toBeUndefined();
  });

  it("getByAgentAndWidget returns the widget after create", async () => {
    const repo = createApprovedDashboardWidgetsRepository({
      db,
      logger: capturingLogger(),
    });
    await repo.create({
      id: "w-get",
      agentId: "agent-b",
      widgetId: "stats",
      html: "<p>Stats</p>",
      css: "",
      js: "",
    });
    const got = await repo.getByAgentAndWidget("agent-b", "stats");
    expect(got).toBeDefined();
    expect(got!.id).toBe("w-get");
    expect(got!.html).toBe("<p>Stats</p>");
  });

  it("listByAgent returns only widgets for that agent (for dashboard API)", async () => {
    const repo = createApprovedDashboardWidgetsRepository({
      db,
      logger: capturingLogger(),
    });
    await repo.create({
      id: "w-list-1",
      agentId: "agent-list",
      widgetId: "panel-1",
      name: "Panel 1",
      html: "<div>1</div>",
      css: "",
      js: "",
    });
    await repo.create({
      id: "w-list-2",
      agentId: "agent-list",
      widgetId: "panel-2",
      html: "<div>2</div>",
      css: "",
      js: "",
    });
    await repo.create({
      id: "w-other",
      agentId: "other-agent",
      widgetId: "other",
      html: "<div>other</div>",
      css: "",
      js: "",
    });
    const list = await repo.listByAgent("agent-list");
    expect(list).toHaveLength(2);
    expect(list.map((w) => w.widgetId).sort()).toEqual(["panel-1", "panel-2"]);
    expect(list.every((w) => w.agentId === "agent-list")).toBe(true);
  });

  it("listByAgent returns empty array when agent has no approved widgets", async () => {
    const repo = createApprovedDashboardWidgetsRepository({
      db,
      logger: capturingLogger(),
    });
    const list = await repo.listByAgent("no-widgets-agent");
    expect(list).toEqual([]);
  });
});
