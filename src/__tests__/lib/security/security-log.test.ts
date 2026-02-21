import { describe, it, expect, beforeEach } from "bun:test";
import { logSecurityEvent, logInjectionDetected } from "@/lib/security/security-log";
import { makeTestContext } from "../../helpers/fakes";
import type { AppContext } from "@/lib/context";

describe("logSecurityEvent", () => {
  let ctx: AppContext;

  beforeEach(() => {
    ctx = makeTestContext();
  });

  it("inserts a row into security_events", () => {
    logSecurityEvent(ctx, "agent-1", "session-1", "tool_call", { tool: "file_read" });
    const rows = ctx.db.prepare("SELECT * FROM security_events").all() as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0].agent_id).toBe("agent-1");
    expect(rows[0].session_id).toBe("session-1");
    expect(rows[0].event_type).toBe("tool_call");
  });

  it("serializes detail as JSON", () => {
    logSecurityEvent(ctx, "a", "s", "test", { key: "value", num: 42 });
    const row = ctx.db.prepare("SELECT detail FROM security_events").get() as { detail: string };
    const detail = JSON.parse(row.detail);
    expect(detail.key).toBe("value");
    expect(detail.num).toBe(42);
  });

  it("generates unique IDs for each event", () => {
    logSecurityEvent(ctx, "a", "s", "t1", {});
    logSecurityEvent(ctx, "a", "s", "t2", {});
    const rows = ctx.db.prepare("SELECT id FROM security_events").all() as { id: string }[];
    expect(rows[0].id).not.toBe(rows[1].id);
  });

  it("records occurred_at as ISO string", () => {
    logSecurityEvent(ctx, "a", "s", "t", {});
    const row = ctx.db.prepare("SELECT occurred_at FROM security_events").get() as { occurred_at: string };
    expect(() => new Date(row.occurred_at)).not.toThrow();
    expect(new Date(row.occurred_at).getFullYear()).toBeGreaterThanOrEqual(2024);
  });

  it("can log multiple events across different agents/sessions", () => {
    logSecurityEvent(ctx, "agent-1", "session-1", "event_a", {});
    logSecurityEvent(ctx, "agent-2", "session-2", "event_b", {});
    const rows = ctx.db.prepare("SELECT * FROM security_events ORDER BY occurred_at").all() as Record<string, unknown>[];
    expect(rows).toHaveLength(2);
    expect(rows[0].agent_id).toBe("agent-1");
    expect(rows[1].agent_id).toBe("agent-2");
  });
});

describe("logInjectionDetected", () => {
  let ctx: AppContext;

  beforeEach(() => {
    ctx = makeTestContext();
  });

  it("logs an injection_detected event with correct fields", () => {
    logInjectionDetected(ctx, "agent-1", "session-1", "web_search", "ignore.*instructions", 500);
    const row = ctx.db.prepare("SELECT event_type, detail FROM security_events").get() as {
      event_type: string;
      detail: string;
    };
    expect(row.event_type).toBe("injection_detected");
    const detail = JSON.parse(row.detail);
    expect(detail.source).toBe("web_search");
    expect(detail.pattern_matched).toBe("ignore.*instructions");
    expect(detail.original_length).toBe(500);
  });
});
