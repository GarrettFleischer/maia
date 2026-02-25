/**
 * @fileoverview Tests for server initialization (initMaiaAgent).
 * @module __tests__/lib/init.test
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { makeTestContext } from "../helpers/fakes";
import { initMaiaAgent } from "@/lib/init";
import type { AppContext } from "@/lib/context";

describe("initMaiaAgent", () => {
  let ctx: AppContext;

  beforeEach(() => {
    ctx = makeTestContext();
  });

  it("inserts maia agent row on first call", () => {
    const before = ctx.db.prepare("SELECT id FROM agents WHERE id = 'maia'").get();
    expect(before).toBeUndefined();

    initMaiaAgent(ctx);

    const row = ctx.db.prepare("SELECT id, name, model, status FROM agents WHERE id = 'maia'").get() as {
      id: string;
      name: string;
      model: string;
      status: string;
    };
    expect(row).toBeDefined();
    expect(row.id).toBe("maia");
    expect(row.name).toBe("Maia");
    expect(row.model).toBe("ollama/llama3.2");
    expect(row.status).toBe("active");
  });

  it("is idempotent on second call", () => {
    initMaiaAgent(ctx);
    initMaiaAgent(ctx);

    const rows = ctx.db.prepare("SELECT id FROM agents WHERE id = 'maia'").all() as { id: string }[];
    expect(rows).toHaveLength(1);
  });
});
