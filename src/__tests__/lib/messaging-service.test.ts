import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { initMessagingService } from "@/lib/messaging-service";
import { registerMessagingImpls, messageToUserTool, messageSendTool } from "@/lib/tools/messaging";
import { makeTestContext, FakeEvents } from "../helpers/fakes";
import { createSession } from "@/lib/history";
import type { AppContext } from "@/lib/context";

afterEach(() => {
  // Reset registered impls after each test
  registerMessagingImpls(null, null);
});

describe("initMessagingService", () => {
  let ctx: AppContext;

  beforeEach(() => {
    ctx = makeTestContext();
  });

  it("registers messaging implementations", async () => {
    const runAgentFn = async () => {};
    initMessagingService(ctx, runAgentFn);
    // After init, messageToUserTool should NOT throw
    const sessionId = createSession(ctx, ["user", "maia"]);
    const toolCtx = { ...ctx, agentId: "maia", sessionId, volumeRoot: "/workspace" };
    // Should resolve without throwing
    await messageToUserTool.execute({ content: "hello" }, toolCtx);
  });

  describe("message_to_user", () => {
    it("appends an agent entry to the session", async () => {
      const sessionId = createSession(ctx, ["user", "maia"]);
      initMessagingService(ctx, async () => {});
      const toolCtx = { ...ctx, agentId: "maia", sessionId, volumeRoot: "/workspace" };
      await messageToUserTool.execute({ content: "Hi there!" }, toolCtx);
      const rows = ctx.db
        .prepare("SELECT * FROM history_entries WHERE session_id = ?")
        .all(sessionId) as Record<string, unknown>[];
      expect(rows).toHaveLength(1);
      expect(rows[0].content).toBe("Hi there!");
      expect(rows[0].role).toBe("agent");
    });

    it("emits a message event on the event bus", async () => {
      const events = new FakeEvents();
      ctx = makeTestContext({ events });
      const sessionId = createSession(ctx, ["user", "maia"]);
      initMessagingService(ctx, async () => {});
      const toolCtx = { ...ctx, agentId: "maia", sessionId, volumeRoot: "/workspace" };
      await messageToUserTool.execute({ content: "Event test" }, toolCtx);
      const messageEvents = events.emitted.filter((e) => e.event === "message");
      expect(messageEvents).toHaveLength(1);
      expect((messageEvents[0].data as { entry: { content: string } }).entry.content).toBe("Event test");
    });

    it("adds agent to session participants if not already there", async () => {
      const sessionId = createSession(ctx, ["user"]);
      initMessagingService(ctx, async () => {});
      const toolCtx = { ...ctx, agentId: "maia", sessionId, volumeRoot: "/workspace" };
      await messageToUserTool.execute({ content: "Join me" }, toolCtx);
      const row = ctx.db.prepare("SELECT participants FROM sessions WHERE id = ?").get(sessionId) as { participants: string };
      const parts = JSON.parse(row.participants);
      expect(parts).toContain("maia");
    });
  });

  describe("message_send (agent-to-agent)", () => {
    it("creates a new session for the conversation if none exists", async () => {
      const runCalls: string[] = [];
      initMessagingService(ctx, async (_c, toAgentId) => { runCalls.push(toAgentId); });
      const sourceSession = createSession(ctx, ["agent-1", "maia"]);
      const toolCtx = { ...ctx, agentId: "agent-1", sessionId: sourceSession, volumeRoot: "/workspace" };
      await messageSendTool.execute({ toAgentId: "agent-2", content: "Hello agent 2" }, toolCtx);
      // A new agent session should have been created
      const sessions = ctx.db
        .prepare("SELECT * FROM sessions WHERE type = 'agents'")
        .all() as Record<string, unknown>[];
      expect(sessions.some((s) => {
        const parts = JSON.parse(s.participants as string);
        return parts.includes("agent-1") && parts.includes("agent-2");
      })).toBe(true);
    });

    it("reuses existing agent-to-agent session", async () => {
      initMessagingService(ctx, async () => {});
      // Pre-create the session
      const agentSession = createSession(ctx, ["agent-1", "agent-2"], "agents");
      const sourceSession = createSession(ctx, ["agent-1"]);
      const toolCtx = { ...ctx, agentId: "agent-1", sessionId: sourceSession, volumeRoot: "/workspace" };
      await messageSendTool.execute({ toAgentId: "agent-2", content: "Reuse session" }, toolCtx);
      await messageSendTool.execute({ toAgentId: "agent-2", content: "Second message" }, toolCtx);
      // Should still be only one session between agent-1 and agent-2
      const sessions = ctx.db
        .prepare("SELECT * FROM sessions WHERE type = 'agents'")
        .all() as Record<string, unknown>[];
      const a2aSessions = sessions.filter((s) => {
        const parts = JSON.parse(s.participants as string);
        return parts.includes("agent-1") && parts.includes("agent-2");
      });
      expect(a2aSessions).toHaveLength(1);
      expect(a2aSessions[0].id).toBe(agentSession);
    });

    it("triggers runAgentFn for the target agent", async () => {
      const triggered: string[] = [];
      initMessagingService(ctx, async (_c, agentId) => { triggered.push(agentId); });
      const sourceSession = createSession(ctx, ["agent-1"]);
      const toolCtx = { ...ctx, agentId: "agent-1", sessionId: sourceSession, volumeRoot: "/workspace" };
      await messageSendTool.execute({ toAgentId: "agent-2", content: "Wake up!" }, toolCtx);
      // Allow the fire-and-forget to settle
      await new Promise((r) => setTimeout(r, 10));
      expect(triggered).toContain("agent-2");
    });
  });
});
