import path from "path";
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { initMessagingService } from "@/lib/messaging-service";
import { registerMessagingImpls, messageToUserTool, messageSendTool } from "@/lib/tools/messaging";
import { makeTestContext, FakeEvents, FakeFs } from "../helpers/fakes";
import { createSession } from "@/lib/history";
import { getAgentsDir } from "@/lib/data-dir";
import type { AppContext } from "@/lib/context";

function seedAgent(ctx: AppContext, id: string, name = "Test Agent", model = "ollama/llama3.2", status = "active") {
  const now = new Date().toISOString();
  ctx.db.prepare(
    "INSERT INTO agents (id, name, model, system_prompt_extra, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(id, name, model, null, status, now, now);
}

function seedIdentityFiles(fs: FakeFs, agentId: string, soul = "# Soul\nI am Sender Agent.") {
  const dir = path.join(getAgentsDir(), agentId);
  fs.seed(path.join(dir, "SOUL.md"), soul);
  fs.seed(path.join(dir, "MEMORY.md"), "# Memory\nNo memories yet.");
  fs.seed(path.join(dir, "USER.md"), "# User\nThe user is a developer.");
}

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
    const runAgentFn = async () => "";
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
      initMessagingService(ctx, async () => "");
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
      initMessagingService(ctx, async () => "");
      const toolCtx = { ...ctx, agentId: "maia", sessionId, volumeRoot: "/workspace" };
      await messageToUserTool.execute({ content: "Event test" }, toolCtx);
      const messageEvents = events.emitted.filter((e) => e.event === "message");
      expect(messageEvents).toHaveLength(1);
      expect((messageEvents[0].data as { entry: { content: string } }).entry.content).toBe("Event test");
    });

    it("adds agent to session participants if not already there", async () => {
      const sessionId = createSession(ctx, ["user"]);
      initMessagingService(ctx, async () => "");
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
      initMessagingService(ctx, async (_c, toAgentId) => { runCalls.push(toAgentId); return ""; });
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
      initMessagingService(ctx, async () => "");
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

    it("returns immediately and runs recipient in background; runAgentFn is called for target agent", async () => {
      const triggered: string[] = [];
      initMessagingService(ctx, async (_c, agentId) => {
        triggered.push(agentId);
        return "Reply from agent-2";
      });
      const sourceSession = createSession(ctx, ["agent-1"]);
      const toolCtx = { ...ctx, agentId: "agent-1", sessionId: sourceSession, volumeRoot: "/workspace" };
      const reply = await messageSendTool.execute({ toAgentId: "agent-2", content: "Wake up!" }, toolCtx);
      expect(reply).toContain("Message sent");
      expect(reply).toContain("separate thread");
      await new Promise((r) => setImmediate(r));
      expect(triggered).toContain("agent-2");
    });

    it("passes only sender name/id and content to runAgentFn; recipient gets own system prompt from runner", async () => {
      const fs = new FakeFs();
      ctx = makeTestContext({ fs });
      seedAgent(ctx, "agent-1", "Sender Agent");
      seedIdentityFiles(fs, "agent-1", "# Soul\nI am Sender Agent, the one who sends.");

      let capturedMessage = "";
      initMessagingService(ctx, async (_c, toAgentId, _sessionId, message, _opts) => {
        if (toAgentId === "agent-2") capturedMessage = message;
        return "OK";
      });
      const sourceSession = createSession(ctx, ["agent-1"]);
      const toolCtx = { ...ctx, agentId: "agent-1", sessionId: sourceSession, volumeRoot: "/workspace" };
      await messageSendTool.execute({ toAgentId: "agent-2", content: "Hello recipient" }, toolCtx);
      await new Promise((r) => setImmediate(r));

      expect(capturedMessage).toContain("Message from **Sender Agent**");
      expect(capturedMessage).toContain("agent-1");
      expect(capturedMessage).toContain("Hello recipient");
      // Recipient gets their own system prompt when runner runs them; we do NOT embed sender's identity
      expect(capturedMessage).not.toContain("Sender's Identity");
      expect(capturedMessage).not.toContain("### Soul");
      expect(capturedMessage).not.toContain("I am Sender Agent, the one who sends.");
    });
  });
});
