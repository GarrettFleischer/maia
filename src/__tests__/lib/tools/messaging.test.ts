import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { messageSendTool, registerMessagingImpls } from "@/lib/tools/messaging";
import { makeTestContext } from "../../helpers/fakes";
import type { ToolContext } from "@/lib/tools/types";

function makeToolCtx(sessionId = "session-1"): ToolContext {
  const ctx = makeTestContext();
  return { ...ctx, agentId: "agent-1", sessionId, volumeRoot: "/workspace" };
}

describe("messageSendTool", () => {
  beforeEach(() => {
    registerMessagingImpls(null, null);
  });

  afterEach(() => {
    registerMessagingImpls(null, null);
  });

  it("throws when messaging service is not initialized", async () => {
    const ctx = makeToolCtx();
    await expect(
      messageSendTool.execute({ to: "agent-2", text: "hello" }, ctx)
    ).rejects.toThrow("Messaging service not initialized");
  });

  it("sends to user: calls toUser impl and returns string", async () => {
    const calls: Array<{ agentId: string; sessionId: string; content: string }> = [];
    registerMessagingImpls(
      async (agentId, sessionId, content) => { calls.push({ agentId, sessionId, content }); },
      null
    );
    const ctx = makeToolCtx("my-session");
    const reply = await messageSendTool.execute({ to: "user", text: "Hi user!" }, ctx);
    expect(reply).toBe("Message sent to user.");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ agentId: "agent-1", sessionId: "my-session", content: "Hi user!" });
  });

  it("sends to agent: calls toAgent impl and returns status string", async () => {
    const calls: Array<{ from: string; to: string; content: string; callerSessionId: string }> = [];
    const statusString =
      "Message sent. They're working on it in a separate thread; when they reply you'll be run again here to review and report to the user.";
    registerMessagingImpls(
      null,
      async (fromAgentId, toAgentId, content, callerSessionId) => {
        calls.push({ from: fromAgentId, to: toAgentId, content, callerSessionId });
        return statusString;
      }
    );
    const ctx = makeToolCtx("my-caller-session");
    const reply = await messageSendTool.execute({ to: "agent-2", text: "Hey agent 2!" }, ctx);
    expect(reply).toBe(statusString);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      from: "agent-1",
      to: "agent-2",
      content: "Hey agent 2!",
      callerSessionId: "my-caller-session",
    });
  });

  it("has correct tool definition", () => {
    const def = messageSendTool.toDefinition();
    expect(def.name).toBe("message_send");
    expect(def.parameters).toBeDefined();
  });
});
