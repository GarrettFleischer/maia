import path from "path";
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { initMessagingService } from "@/lib/messaging-service";
import { registerLlmQueueHandlers } from "@/lib/queue/llm-queue-handlers";
import { registerMessagingImpls, messageSendTool } from "@/lib/tools/messaging";
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

function seedIdentityFiles(fs: FakeFs, agentId: string, persona = "# Persona\nI am Sender Agent.") {
  const dir = path.join(getAgentsDir(), agentId);
  fs.seed(path.join(dir, "PERSONA.md"), persona);
}

afterEach(() => {
  // Reset registered impls after each test
  registerMessagingImpls(null, null);
});

describe("initMessagingService", () => {
  let ctx: AppContext;

  beforeEach(() => {
    registerLlmQueueHandlers();
    ctx = makeTestContext();
  });

  it("registers messaging implementations", async () => {
    const runAgentFn = async () => "";
    initMessagingService(ctx, runAgentFn);
    // After init, message_send to user should NOT throw
    const sessionId = createSession(ctx, ["user", "maia"]);
    const toolCtx = { ...ctx, agentId: "maia", sessionId, volumeRoot: "/workspace" };
    await messageSendTool.execute({ to: "user", text: "hello" }, toolCtx);
  });

  describe("message_send to user", () => {
    it("appends an agent entry to the session", async () => {
      const sessionId = createSession(ctx, ["user", "maia"]);
      initMessagingService(ctx, async () => "");
      const toolCtx = { ...ctx, agentId: "maia", sessionId, volumeRoot: "/workspace" };
      await messageSendTool.execute({ to: "user", text: "Hi there!" }, toolCtx);
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
      await messageSendTool.execute({ to: "user", text: "Event test" }, toolCtx);
      const messageEvents = events.emitted.filter((e) => e.event === "message");
      expect(messageEvents).toHaveLength(1);
      expect((messageEvents[0].data as { entry: { content: string } }).entry.content).toBe("Event test");
    });

    it("adds agent to session participants if not already there", async () => {
      const sessionId = createSession(ctx, ["user"]);
      initMessagingService(ctx, async () => "");
      const toolCtx = { ...ctx, agentId: "maia", sessionId, volumeRoot: "/workspace" };
      await messageSendTool.execute({ to: "user", text: "Join me" }, toolCtx);
      const row = ctx.db.prepare("SELECT participants FROM sessions WHERE id = ?").get(sessionId) as { participants: string };
      const parts = JSON.parse(row.participants);
      expect(parts).toContain("maia");
    });
  });

  describe("message_send (non-user targets, unified session)", () => {
    it("does not create type=agents sessions when messaging another agent", async () => {
      seedAgent(ctx, "agent-1", "A1");
      seedAgent(ctx, "agent-2", "A2");
      initMessagingService(ctx, async () => "OK");
      const sourceSession = createSession(ctx, ["agent-1", "user"]);
      const toolCtx = {
        ...ctx,
        agentId: "agent-1",
        sessionId: sourceSession,
        volumeRoot: "/workspace",
      };
      await messageSendTool.execute({ to: "agent-2", text: "Hello agent 2" }, toolCtx);
      await new Promise((r) => setImmediate(r));
      const row = ctx.db
        .prepare("SELECT COUNT(*) as c FROM sessions WHERE type = 'agents'")
        .get() as { c: number };
      expect(row.c).toBe(0);
    });

    it("enqueues runAgent on the caller session with the target agent id", async () => {
      seedAgent(ctx, "agent-1", "A1");
      seedAgent(ctx, "agent-2", "A2");
      let captured: { agentId: string; sessionId: string; message: string } | null =
        null;
      initMessagingService(ctx, async (_c, toAgentId, sid, message) => {
        captured = { agentId: toAgentId, sessionId: sid, message };
        return "done";
      });
      const sourceSession = createSession(ctx, ["user", "maia"]);
      const toolCtx = {
        ...ctx,
        agentId: "maia",
        sessionId: sourceSession,
        volumeRoot: "/workspace",
      };
      await messageSendTool.execute({ to: "agent-2", text: "Ping" }, toolCtx);
      await new Promise((r) => setImmediate(r));
      expect(captured).not.toBeNull();
      expect(captured!.agentId).toBe("agent-2");
      expect(captured!.sessionId).toBe(sourceSession);
      expect(captured!.message).toContain("Ping");
    });

    it("returns copy that mentions this thread and queued delivery", async () => {
      seedAgent(ctx, "agent-2", "A2");
      initMessagingService(ctx, async () => "OK");
      const sourceSession = createSession(ctx, ["agent-1", "user"]);
      const toolCtx = {
        ...ctx,
        agentId: "agent-1",
        sessionId: sourceSession,
        volumeRoot: "/workspace",
      };
      const reply = await messageSendTool.execute({ to: "agent-2", text: "Hi" }, toolCtx);
      expect(reply).toContain("this thread");
      expect(reply.toLowerCase()).toContain("queued");
    });

    it("passes formatted sender line to runAgentFn; recipient gets own system prompt from runner", async () => {
      const fs = new FakeFs();
      ctx = makeTestContext({ fs });
      seedAgent(ctx, "agent-1", "Sender Agent");
      seedAgent(ctx, "agent-2", "Recipient");
      seedIdentityFiles(
        fs,
        "agent-1",
        "# Persona\nI am Sender Agent, the one who sends.",
      );

      let capturedMessage = "";
      initMessagingService(ctx, async (_c, toAgentId, _sessionId, message) => {
        if (toAgentId === "agent-2") capturedMessage = message;
        return "OK";
      });
      const sourceSession = createSession(ctx, ["agent-1"]);
      const toolCtx = {
        ...ctx,
        agentId: "agent-1",
        sessionId: sourceSession,
        volumeRoot: "/workspace",
      };
      await messageSendTool.execute({ to: "agent-2", text: "Hello recipient" }, toolCtx);
      await new Promise((r) => setImmediate(r));

      expect(capturedMessage).toContain("Message from **Sender Agent**");
      expect(capturedMessage).toContain("agent-1");
      expect(capturedMessage).toContain("Hello recipient");
      expect(capturedMessage).not.toContain("### Soul");
      expect(capturedMessage).not.toContain("I am Sender Agent, the one who sends.");
    });

    it("runs a single queued runAgent per message (no multi-agent forward loop)", async () => {
      seedAgent(ctx, "agent-2", "Recipient Agent");
      const runCalls: string[] = [];
      initMessagingService(ctx, async (_c, agentId) => {
        runCalls.push(agentId);
        return "[DONE]";
      });
      const sourceSession = createSession(ctx, ["agent-1", "user"]);
      const toolCtx = {
        ...ctx,
        agentId: "agent-1",
        sessionId: sourceSession,
        volumeRoot: "/workspace",
      };
      await messageSendTool.execute({ to: "agent-2", text: "Question" }, toolCtx);
      await new Promise((r) => setImmediate(r));
      expect(runCalls).toEqual(["agent-2"]);
    });
  });
});
