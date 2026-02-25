/**
 * @fileoverview Tests for system date/time tools that expose the host clock to agents.
 * @module __tests__/lib/tools/datetime-tools.test
 */

import { describe, it, expect } from "bun:test";
import { makeTestContext } from "../../helpers/fakes";
import type { ToolContext } from "@/lib/tools/types";
import { systemDateTimeTool, systemDateTool } from "@/lib/tools/datetime";

function makeToolCtx(): ToolContext {
  const ctx = makeTestContext();
  return {
    ...ctx,
    agentId: "agent-1",
    sessionId: "datetime-tools-session",
    volumeRoot: "/workspace",
  };
}

describe("datetime tools", () => {
  it("system_datetime returns iso, local, and timezone fields", async () => {
    const ctx = makeToolCtx();
    const result = await systemDateTimeTool.execute({}, ctx);

    expect(typeof result.iso).toBe("string");
    expect(result.iso).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(typeof result.local).toBe("string");
    expect(result.local.length).toBeGreaterThan(0);
    expect(typeof result.timezone).toBe("string");
    expect(result.timezone.length).toBeGreaterThan(0);
  });

  it("system_date returns a YYYY-MM-DD date and iso field", async () => {
    const ctx = makeToolCtx();
    const result = await systemDateTool.execute({}, ctx);

    expect(typeof result.date).toBe("string");
    expect(result.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(typeof result.iso).toBe("string");
    expect(result.iso.startsWith(result.date)).toBe(true);
  });
});

