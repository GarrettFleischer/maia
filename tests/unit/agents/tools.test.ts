/**
 * @fileoverview Unit tests for agent management tools (create, list, remove, inspect, update).
 * @module tests/unit/agents/tools
 */

import { describe, it, expect } from "bun:test";
import {
  createAgentCreateTool,
  createAgentListTool,
  createAgentRemoveTool,
  createAgentInspectTool,
  createAgentUpdateTool,
} from "../../../src/agents/tools.js";
import type { AgentToolsDeps } from "../../../src/agents/tools.js";
import type { AgentRegistry, AgentConfig } from "../../../src/agents/registry.js";
import type { SubAgent } from "../../../src/agents/factory.js";
import type { ToolContext } from "../../../src/agent/tools/base.js";
import type { CryptoProvider } from "../../../src/core/types.js";
import { capturingLogger } from "../../helpers/index.js";

// ─── Helpers ─────────────────────────────────────────────────────

function sampleConfig(overrides?: Partial<AgentConfig>): AgentConfig {
  return {
    id: "test-bot",
    name: "TestBot",
    emoji: "🤖",
    personality: "helpful tester",
    createdBy: "maia",
    schedule: "",
    tools: ["memory_search"],
    model: { provider: "gemini", model: "gemini-2.0-flash" },
    active: true,
    createdAt: "2026-02-13T12:00:00.000Z",
    ...overrides,
  };
}

function mockRegistry(configs?: AgentConfig[]): AgentRegistry {
  const store = new Map<string, AgentConfig>();
  for (const c of configs ?? []) store.set(c.id, c);

  return {
    async register(config: AgentConfig) {
      store.set(config.id, { ...config, createdAt: new Date().toISOString(), active: true });
      return store.get(config.id)!;
    },
    async get(id: string) { return store.get(id); },
    async list() { return Array.from(store.values()); },
    async remove(id: string) {
      if (!store.has(id)) return false;
      store.delete(id);
      return true;
    },
    async update(id: string, changes: Partial<AgentConfig>) {
      const existing = store.get(id);
      if (!existing) return undefined;
      const updated = { ...existing, ...changes, id };
      store.set(id, updated);
      return updated;
    },
    agentWorkspacePath(id: string) { return `/workspace/agents/${id}`; },
  };
}

function mockSubAgent(id: string, responseText?: string): SubAgent {
  const content = responseText ?? `Response from ${id}`;
  return {
    config: sampleConfig({ id }),
    runtime: {
      handleMessage: async () => ({ content }),
      getSessionId: () => undefined,
      getToolRegistry: () => ({
        register: () => {},
        get: () => undefined,
        definitions: () => [],
        execute: async () => ({ content: "", success: false }),
        list: () => [],
      }),
    },
    workspacePath: `/workspace/agents/${id}`,
  };
}

function defaultContext(): ToolContext {
  return {
    sessionId: "session-1",
    channelId: "cli",
    senderId: "user-1",
    privacyMode: false,
  };
}

function makeDeps(overrides?: Partial<AgentToolsDeps>): AgentToolsDeps {
  return {
    registry: overrides?.registry ?? mockRegistry(),
    logger: overrides?.logger ?? capturingLogger(),
    createRuntime: overrides?.createRuntime ?? ((config: AgentConfig) => mockSubAgent(config.id)),
    activeAgents: overrides?.activeAgents ?? new Map<string, SubAgent>(),
    crypto:
      overrides?.crypto ??
      ({ randomUUID: () => "test-uuid-" + Math.random().toString(36).slice(2) } as CryptoProvider),
  };
}

// ─── agent_create ────────────────────────────────────────────────

describe("agent_create tool", () => {
  it("should create agent, add to activeAgents, return success", async () => {
    const deps = makeDeps();
    const tool = createAgentCreateTool(deps);

    const result = await tool.execute(
      {
        id: "research-bot",
        schedule: "",
        tools: ["web_fetch"],
      },
      defaultContext()
    );

    expect(result.success).toBe(true);
    expect(result.content).toContain("created successfully");
    expect(result.content).toContain("set_identity");
    expect(deps.activeAgents.has("research-bot")).toBe(true);
  });

  it("should fail when agent already exists", async () => {
    const registry = mockRegistry([sampleConfig({ id: "existing" })]);
    const tool = createAgentCreateTool(makeDeps({ registry }));

    const result = await tool.execute({ id: "existing" }, defaultContext());

    expect(result.success).toBe(false);
    expect(result.content).toContain("already exists");
  });

  it("should use default emoji and tools when not provided", async () => {
    const activeAgents = new Map<string, SubAgent>();
    const deps = makeDeps({ activeAgents });
    const tool = createAgentCreateTool(deps);

    await tool.execute({ id: "minimal" }, defaultContext());

    const agent = activeAgents.get("minimal");
    expect(agent).toBeDefined();
  });

  it("should return valid ToolDefinition", () => {
    const tool = createAgentCreateTool(makeDeps());
    const def = tool.definition();
    expect(def.name).toBe("agent_create");
    expect(def.parameters).toBeDefined();
    expect(def.parameters.required).toContain("id");
  });
});

// ─── agent_list ──────────────────────────────────────────────────

describe("agent_list tool", () => {
  it("should return formatted list of agents", async () => {
    const registry = mockRegistry([
      sampleConfig({ id: "bot-a", name: "BotA" }),
      sampleConfig({ id: "bot-b", name: "BotB" }),
    ]);
    const tool = createAgentListTool(makeDeps({ registry }));

    const result = await tool.execute({}, defaultContext());

    expect(result.success).toBe(true);
    expect(result.content).toContain("BotA");
    expect(result.content).toContain("BotB");
    expect(result.data!.count).toBe(2);
  });

  it("should return 'No agents registered' when empty", async () => {
    const tool = createAgentListTool(makeDeps());

    const result = await tool.execute({}, defaultContext());

    expect(result.success).toBe(true);
    expect(result.content).toContain("No agents registered");
  });

  it("should return valid ToolDefinition", () => {
    const tool = createAgentListTool(makeDeps());
    const def = tool.definition();
    expect(def.name).toBe("agent_list");
  });
});

// ─── agent_remove ────────────────────────────────────────────────

describe("agent_remove tool", () => {
  it("should remove agent from registry and activeAgents", async () => {
    const registry = mockRegistry([sampleConfig({ id: "doomed" })]);
    const activeAgents = new Map<string, SubAgent>();
    activeAgents.set("doomed", mockSubAgent("doomed"));
    const tool = createAgentRemoveTool(makeDeps({ registry, activeAgents }));

    const result = await tool.execute({ id: "doomed" }, defaultContext());

    expect(result.success).toBe(true);
    expect(result.content).toContain("removed");
    expect(activeAgents.has("doomed")).toBe(false);
  });

  it("should return failure for non-existent agent", async () => {
    const tool = createAgentRemoveTool(makeDeps());

    const result = await tool.execute({ id: "ghost" }, defaultContext());

    expect(result.success).toBe(false);
    expect(result.content).toContain("not found");
  });
});

// ─── agent_inspect ───────────────────────────────────────────────

describe("agent_inspect tool", () => {
  it("should return config JSON by default", async () => {
    const registry = mockRegistry([sampleConfig({ id: "inspect-me" })]);
    const tool = createAgentInspectTool(makeDeps({ registry }));

    const result = await tool.execute({ id: "inspect-me" }, defaultContext());

    expect(result.success).toBe(true);
    expect(result.content).toContain("config");
    expect(result.content).toContain("inspect-me");
  });

  it("should return file path for workspace files", async () => {
    const registry = mockRegistry([sampleConfig({ id: "inspect-me" })]);
    const tool = createAgentInspectTool(makeDeps({ registry }));

    const result = await tool.execute({ id: "inspect-me", file: "soul" }, defaultContext());

    expect(result.success).toBe(true);
    expect(result.data!.file).toBe("SOUL.md");
    expect(result.data!.path).toContain("/workspace/agents/inspect-me/SOUL.md");
  });

  it("should handle 'memory' file type", async () => {
    const registry = mockRegistry([sampleConfig({ id: "inspect-me" })]);
    const tool = createAgentInspectTool(makeDeps({ registry }));

    const result = await tool.execute({ id: "inspect-me", file: "memory" }, defaultContext());

    expect(result.success).toBe(true);
    expect(result.data!.file).toBe("MEMORY.md");
  });

  it("should fail for unknown agent", async () => {
    const tool = createAgentInspectTool(makeDeps());

    const result = await tool.execute({ id: "nobody" }, defaultContext());

    expect(result.success).toBe(false);
    expect(result.content).toContain("not found");
  });

  it("should fail for unknown file type", async () => {
    const registry = mockRegistry([sampleConfig({ id: "inspect-me" })]);
    const tool = createAgentInspectTool(makeDeps({ registry }));

    const result = await tool.execute({ id: "inspect-me", file: "banana" }, defaultContext());

    expect(result.success).toBe(false);
    expect(result.content).toContain("Unknown file");
  });
});

// ─── agent_update ────────────────────────────────────────────────

describe("agent_update tool", () => {
  it("should apply partial changes", async () => {
    const registry = mockRegistry([sampleConfig({ id: "update-me" })]);
    const tool = createAgentUpdateTool(makeDeps({ registry }));

    const result = await tool.execute({ id: "update-me", name: "UpdatedBot" }, defaultContext());

    expect(result.success).toBe(true);
    expect(result.content).toContain("updated");
    expect(result.content).toContain("name");
  });

  it("should fail for non-existent agent", async () => {
    const tool = createAgentUpdateTool(makeDeps());

    const result = await tool.execute({ id: "ghost", name: "X" }, defaultContext());

    expect(result.success).toBe(false);
    expect(result.content).toContain("not found");
  });
});
