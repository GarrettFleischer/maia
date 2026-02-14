/**
 * @fileoverview Unit tests for the propose_tool agent tool.
 * @module tests/unit/agents/propose-tool
 */

import { describe, it, expect } from "bun:test";
import { createProposeToolTool } from "../../../src/agents/tools/propose-tool.js";
import type { ToolProposalsRepository } from "../../../src/tools/proposals.js";
import type { RequestQueue } from "../../../src/providers/queue.js";
import { capturingLogger, mockCryptoProvider } from "../../helpers/index.js";
import type { ToolContext } from "../../../src/agent/tools/base.js";

function defaultContext(senderId = "maia"): ToolContext {
  return {
    sessionId: "session-1",
    channelId: "cli",
    senderId,
    privacyMode: false,
  };
}

describe("propose_tool", () => {
  it("should return valid ToolDefinition", () => {
    const tool = createProposeToolTool({
      logger: capturingLogger(),
      proposals: { create: async () => ({} as never), getById: async () => undefined, updateStatus: async () => undefined, listByStatus: async () => [], getLastCheckinSecurityAt: async () => null, setLastCheckinSecurityAt: async () => {} },
      queue: { enqueue: async <T>() => undefined as T, enqueueJob: async () => {}, loadFromFile: async () => {}, depth: () => 0, running: () => 0, isPaused: () => false },
      crypto: mockCryptoProvider(),
      resolveAgentId: () => "maia",
    });
    const def = tool.definition();
    expect(def.name).toBe("propose_tool");
    expect(def.parameters?.required).toContain("name");
    expect(def.parameters?.required).toContain("description");
    expect(def.parameters?.required).toContain("parameters");
    expect(def.parameters?.required).toContain("implementation_type");
  });

  it("should create proposal and enqueue tool_review job on success", async () => {
    const created: { id: string; name: string }[] = [];
    const jobs: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const proposals: ToolProposalsRepository = {
      create: async (input) => {
        created.push({ id: input.id, name: input.name });
        return {
          id: input.id,
          proposingAgentId: input.proposingAgentId,
          name: input.name,
          description: input.description,
          parametersJson: input.parametersJson,
          implementationType: input.implementationType,
          implementationConfigJson: input.implementationConfigJson ?? null,
          status: "pending_security",
          securityReason: null,
          userFeedback: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
      },
      getById: async () => undefined,
      updateStatus: async () => undefined,
      listByStatus: async () => [],
      getLastCheckinSecurityAt: async () => null,
      setLastCheckinSecurityAt: async () => {},
    };
    const queue: RequestQueue = {
      enqueue: async <T>() => undefined as T,
      enqueueJob: async (d) => { jobs.push({ type: d.type, payload: d.payload }); },
      loadFromFile: async () => {},
      depth: () => 0,
      running: () => 0,
      isPaused: () => false,
    };
    const crypto = mockCryptoProvider();
    const tool = createProposeToolTool({
      logger: capturingLogger(),
      proposals,
      queue,
      crypto,
      resolveAgentId: (ctx) => ctx.senderId,
    });

    const result = await tool.execute(
      {
        name: "my_helper",
        description: "A helpful tool that does something safe and useful.",
        parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
        implementation_type: "inline",
      },
      defaultContext()
    );

    expect(result.success).toBe(true);
    expect(result.content).toContain("pending security review");
    expect(created).toHaveLength(1);
    expect(created[0].name).toBe("my_helper");
    expect(jobs).toHaveLength(1);
    expect(jobs[0].type).toBe("tool_review");
    expect(jobs[0].payload.proposalId).toBe(created[0].id);
  });

  it("should fail when resolveAgentId returns undefined", async () => {
    const tool = createProposeToolTool({
      logger: capturingLogger(),
      proposals: { create: async () => ({} as never), getById: async () => undefined, updateStatus: async () => undefined, listByStatus: async () => [], getLastCheckinSecurityAt: async () => null, setLastCheckinSecurityAt: async () => {} },
      queue: { enqueue: async <T>() => undefined as T, enqueueJob: async () => {}, loadFromFile: async () => {}, depth: () => 0, running: () => 0, isPaused: () => false },
      crypto: mockCryptoProvider(),
      resolveAgentId: () => undefined,
    });
    const result = await tool.execute(
      { name: "x", description: "desc", parameters: {}, implementation_type: "inline" },
      defaultContext()
    );
    expect(result.success).toBe(false);
    expect(result.content).toContain("agent ID");
  });

  it("should fail when name, description, or implementation_type missing", async () => {
    const tool = createProposeToolTool({
      logger: capturingLogger(),
      proposals: { create: async () => ({} as never), getById: async () => undefined, updateStatus: async () => undefined, listByStatus: async () => [], getLastCheckinSecurityAt: async () => null, setLastCheckinSecurityAt: async () => {} },
      queue: { enqueue: async <T>() => undefined as T, enqueueJob: async () => {}, loadFromFile: async () => {}, depth: () => 0, running: () => 0, isPaused: () => false },
      crypto: mockCryptoProvider(),
      resolveAgentId: () => "maia",
    });
    const r1 = await tool.execute(
      { description: "d", parameters: {}, implementation_type: "inline" },
      defaultContext()
    );
    expect(r1.success).toBe(false);
    expect(r1.content).toContain("required");

    const r2 = await tool.execute(
      { name: "x", parameters: {}, implementation_type: "inline" },
      defaultContext()
    );
    expect(r2.success).toBe(false);
  });

  it("should fail when parameters is not an object", async () => {
    const tool = createProposeToolTool({
      logger: capturingLogger(),
      proposals: { create: async () => ({} as never), getById: async () => undefined, updateStatus: async () => undefined, listByStatus: async () => [], getLastCheckinSecurityAt: async () => null, setLastCheckinSecurityAt: async () => {} },
      queue: { enqueue: async <T>() => undefined as T, enqueueJob: async () => {}, loadFromFile: async () => {}, depth: () => 0, running: () => 0, isPaused: () => false },
      crypto: mockCryptoProvider(),
      resolveAgentId: () => "maia",
    });
    const result = await tool.execute(
      { name: "x", description: "long enough description here", parameters: "not an object", implementation_type: "inline" },
      defaultContext()
    );
    expect(result.success).toBe(false);
    expect(result.content).toContain("JSON object");
  });

  it("should fail when proposals.create throws", async () => {
    const tool = createProposeToolTool({
      logger: capturingLogger(),
      proposals: {
        create: async () => { throw new Error("DB error"); },
        getById: async () => undefined,
        updateStatus: async () => undefined,
        listByStatus: async () => [],
        getLastCheckinSecurityAt: async () => null,
        setLastCheckinSecurityAt: async () => {},
      },
      queue: { enqueue: async <T>() => undefined as T, enqueueJob: async () => {}, loadFromFile: async () => {}, depth: () => 0, running: () => 0, isPaused: () => false },
      crypto: mockCryptoProvider(),
      resolveAgentId: () => "maia",
    });
    const result = await tool.execute(
      { name: "x", description: "long enough description here", parameters: {}, implementation_type: "inline" },
      defaultContext()
    );
    expect(result.success).toBe(false);
    expect(result.content).toContain("Failed to save");
  });

  it("should fail when queue.enqueueJob throws", async () => {
    const tool = createProposeToolTool({
      logger: capturingLogger(),
      proposals: {
        create: async (input) => ({
          ...input,
          id: input.id,
          status: "pending_security",
          securityReason: null,
          userFeedback: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        } as never),
        getById: async () => undefined,
        updateStatus: async () => undefined,
        listByStatus: async () => [],
        getLastCheckinSecurityAt: async () => null,
        setLastCheckinSecurityAt: async () => {},
      },
      queue: {
        enqueue: async <T>() => undefined as T,
        enqueueJob: async () => { throw new Error("Queue full"); },
        loadFromFile: async () => {},
        depth: () => 0,
        running: () => 0,
        isPaused: () => false,
      },
      crypto: mockCryptoProvider(),
      resolveAgentId: () => "maia",
    });
    const result = await tool.execute(
      { name: "x", description: "long enough description here", parameters: {}, implementation_type: "inline" },
      defaultContext()
    );
    expect(result.success).toBe(false);
    expect(result.content).toContain("could not be queued");
  });
});
