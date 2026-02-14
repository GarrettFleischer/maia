/**
 * @fileoverview Unit tests for the WebSocket handler.
 * @module tests/unit/gateway/ws-handler
 */

import { describe, it, expect } from "bun:test";
import { createWSHandler } from "../../../src/gateway/ws-handler.js";
import { capturingLogger, mockEventBus } from "../../helpers/index.js";

describe("WSHandler", () => {
  function setup(
    onChatMessage?: (
      connectionId: string,
      senderId: string,
      content: string
    ) => Promise<{ content: string; remembered?: { memoryMd?: string; userMd?: string; soulMd?: string } }>
  ) {
    const logger = capturingLogger();
    const events = mockEventBus();
    const handler = createWSHandler({
      logger,
      events,
      onChatMessage,
    });
    return { handler, logger, events };
  }

  // ── Connection lifecycle ─────────────────────────────────────────

  it("should register a new connection", () => {
    const { handler } = setup();
    const conn = handler.connect("ws-1", "user-1");
    expect(conn.id).toBe("ws-1");
    expect(conn.senderId).toBe("user-1");
    expect(handler.connectionCount()).toBe(1);
  });

  it("should disconnect a connection", () => {
    const { handler } = setup();
    handler.connect("ws-1", "user-1");
    expect(handler.connectionCount()).toBe(1);
    handler.disconnect("ws-1");
    expect(handler.connectionCount()).toBe(0);
  });

  it("should get a connection by ID", () => {
    const { handler } = setup();
    handler.connect("ws-1", "user-1");
    const conn = handler.getConnection("ws-1");
    expect(conn).toBeTruthy();
    expect(conn!.senderId).toBe("user-1");
  });

  it("should return undefined for unknown connection", () => {
    const { handler } = setup();
    expect(handler.getConnection("nonexistent")).toBeUndefined();
  });

  // ── Message handling ─────────────────────────────────────────────

  it("should handle a chat message and return the reply", async () => {
    const { handler } = setup(async (_connId, _senderId, content) => {
      return { content: `Echo: ${content}` };
    });

    handler.connect("ws-1", "user-1");
    const response = await handler.handleMessage(
      "ws-1",
      JSON.stringify({ type: "chat", content: "Hello!" })
    );

    expect(response).not.toBeNull();
    const parsed = JSON.parse(response!);
    expect(parsed.type).toBe("chat_response");
    expect(parsed.content).toBe("Echo: Hello!");
  });

  it("should handle a ping message", async () => {
    const { handler } = setup();
    handler.connect("ws-1", "user-1");

    const response = await handler.handleMessage(
      "ws-1",
      JSON.stringify({ type: "ping" })
    );

    expect(response).not.toBeNull();
    const parsed = JSON.parse(response!);
    expect(parsed.type).toBe("pong");
  });

  it("should return an error for unknown connection", async () => {
    const { handler } = setup();
    const response = await handler.handleMessage("nonexistent", '{"type":"ping"}');
    expect(response).not.toBeNull();
    const parsed = JSON.parse(response!);
    expect(parsed.error).toBe("Unknown connection");
  });

  it("should return error for invalid JSON", async () => {
    const { handler } = setup();
    handler.connect("ws-1", "user-1");
    const response = await handler.handleMessage("ws-1", "not json");
    expect(response).not.toBeNull();
    const parsed = JSON.parse(response!);
    expect(parsed.error).toBe("Invalid JSON");
  });

  it("should handle subscribe message", async () => {
    const { handler } = setup();
    handler.connect("ws-1", "user-1");
    const response = await handler.handleMessage(
      "ws-1",
      JSON.stringify({ type: "subscribe", channel: "alerts" })
    );

    const parsed = JSON.parse(response!);
    expect(parsed.type).toBe("subscribed");
    expect(parsed.channel).toBe("alerts");

    const conn = handler.getConnection("ws-1");
    expect(conn!.subscriptions.has("alerts")).toBe(true);
  });

  it("should handle unsubscribe message", async () => {
    const { handler } = setup();
    handler.connect("ws-1", "user-1");
    await handler.handleMessage("ws-1", JSON.stringify({ type: "subscribe", channel: "alerts" }));
    const response = await handler.handleMessage(
      "ws-1",
      JSON.stringify({ type: "unsubscribe", channel: "alerts" })
    );

    const parsed = JSON.parse(response!);
    expect(parsed.type).toBe("unsubscribed");

    const conn = handler.getConnection("ws-1");
    expect(conn!.subscriptions.has("alerts")).toBe(false);
  });

  // ── Multiple connections ─────────────────────────────────────────

  it("should track multiple connections", () => {
    const { handler } = setup();
    handler.connect("ws-1", "user-1");
    handler.connect("ws-2", "user-2");
    handler.connect("ws-3", "user-3");
    expect(handler.connectionCount()).toBe(3);

    handler.disconnect("ws-2");
    expect(handler.connectionCount()).toBe(2);
    expect(handler.getConnection("ws-2")).toBeUndefined();
    expect(handler.getConnection("ws-1")).toBeTruthy();
  });

  // ── approval_response ───────────────────────────────────────────

  it("should handle approval_response and call onApprovalResponse", async () => {
    let captured: { connectionId: string; senderId: string; payload: Record<string, unknown> } | null = null;
    const handler = createWSHandler({
      logger: capturingLogger(),
      events: mockEventBus(),
      onApprovalResponse: async (connectionId, senderId, payload) => {
        captured = { connectionId, senderId, payload };
      },
    });
    handler.connect("ws-1", "user-1");
    const response = await handler.handleMessage(
      "ws-1",
      JSON.stringify({
        type: "approval_response",
        kind: "tool_proposal",
        decision: "approve",
        proposalId: "prop-123",
        approvalRequestId: "req-456",
      })
    );
    expect(response).not.toBeNull();
    const parsed = JSON.parse(response!);
    expect(parsed.type).toBe("approval_response_ack");
    expect(parsed.success).toBe(true);
    expect(captured).not.toBeNull();
    expect(captured!.connectionId).toBe("ws-1");
    expect(captured!.senderId).toBe("user-1");
    expect(captured!.payload.kind).toBe("tool_proposal");
    expect(captured!.payload.decision).toBe("approve");
    expect(captured!.payload.proposalId).toBe("prop-123");
    expect(captured!.payload.approvalRequestId).toBe("req-456");
  });

  it("should return error when approval_response missing kind or decision", async () => {
    const handler = createWSHandler({ logger: capturingLogger(), events: mockEventBus() });
    handler.connect("ws-1", "user-1");
    const r1 = await handler.handleMessage(
      "ws-1",
      JSON.stringify({ type: "approval_response", decision: "approve" })
    );
    expect(JSON.parse(r1!).error).toContain("kind and decision");
    const r2 = await handler.handleMessage(
      "ws-1",
      JSON.stringify({ type: "approval_response", kind: "tool_proposal" })
    );
    expect(JSON.parse(r2!).error).toContain("kind and decision");
  });

  it("should return error when approval_response handler not configured", async () => {
    const handler = createWSHandler({ logger: capturingLogger(), events: mockEventBus() });
    handler.connect("ws-1", "user-1");
    const response = await handler.handleMessage(
      "ws-1",
      JSON.stringify({ type: "approval_response", kind: "tool_proposal", decision: "approve" })
    );
    expect(JSON.parse(response!).error).toContain("not configured");
  });
});
