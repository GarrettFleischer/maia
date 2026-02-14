/**
 * @fileoverview Unit tests for the propose_mcp_server tool.
 * @module tests/unit/agents/propose-mcp-server
 */

import { describe, it, expect } from "bun:test";
import { createProposeMcpServerTool } from "../../../src/agents/tools/propose-mcp-server.js";
import type { ProposeMcpServerToolDeps } from "../../../src/agents/tools/propose-mcp-server.js";
import type { McpServerProposalsRepository, McpServerProposal } from "../../../src/agents/mcp-server-proposals.js";
import type { AgentRegistry } from "../../../src/agents/registry.js";
import type { ToolContext } from "../../../src/agent/tools/base.js";
import type { CryptoProvider } from "../../../src/core/types.js";
import { capturingLogger } from "../../helpers/index.js";

function defaultContext(): ToolContext {
  return {
    sessionId: "s1",
    channelId: "cli",
    senderId: "user-1",
    privacyMode: false,
  };
}

function mockRegistry(workspacePath: string): AgentRegistry {
  return {
    register: async (c) => ({ ...c, createdAt: new Date().toISOString(), active: true }),
    get: async () => undefined,
    list: async () => [],
    remove: async () => false,
    update: async () => undefined,
    agentWorkspacePath: () => workspacePath,
  };
}

function mockRepo(overrides?: {
  create?: McpServerProposalsRepository["create"];
  updateStatus?: McpServerProposalsRepository["updateStatus"];
}): McpServerProposalsRepository {
  const created: McpServerProposal[] = [];
  return {
    async create(input) {
      const p: McpServerProposal = {
        id: input.id,
        proposingAgentId: input.proposingAgentId,
        name: input.name,
        description: input.description ?? null,
        sandboxPath: input.sandboxPath,
        dockerfilePath: input.dockerfilePath ?? null,
        imageRef: input.imageRef ?? null,
        status: "pending_security",
        securityReason: null,
        userFeedback: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      created.push(p);
      if (overrides?.create) return overrides.create(input);
      return p;
    },
    async getById(id) {
      return created.find((c) => c.id === id);
    },
    async updateStatus(id, status, options) {
      const found = created.find((c) => c.id === id);
      if (!found) return undefined;
      const updated = { ...found, status, updatedAt: new Date().toISOString() };
      if (options?.securityReason !== undefined) (updated as McpServerProposal).securityReason = options.securityReason;
      if (options?.userFeedback !== undefined) (updated as McpServerProposal).userFeedback = options.userFeedback;
      const idx = created.indexOf(found);
      created[idx] = updated as McpServerProposal;
      if (overrides?.updateStatus) return overrides.updateStatus(id, status, options);
      return updated as McpServerProposal;
    },
    async listByStatus() {
      return created.filter((c) => c.status === "pending_user");
    },
  };
}

function makeDeps(overrides?: Partial<ProposeMcpServerToolDeps>): ProposeMcpServerToolDeps {
  return {
    logger: overrides?.logger ?? capturingLogger(),
    crypto: overrides?.crypto ?? ({ randomUUID: () => "uuid-1" } as CryptoProvider),
    repo: overrides?.repo ?? mockRepo(),
    registry: overrides?.registry ?? mockRegistry("/workspace/agents/my-agent"),
    resolveAgentId: overrides?.resolveAgentId ?? (() => "my-agent"),
    onMcpProposalForUserApproval: overrides?.onMcpProposalForUserApproval ?? (() => {}),
  };
}

describe("propose_mcp_server tool", () => {
  it("returns valid ToolDefinition with required name and sandbox_path", () => {
    const tool = createProposeMcpServerTool(makeDeps());
    const def = tool.definition();
    expect(def.name).toBe("propose_mcp_server");
    expect(def.parameters.required).toContain("name");
    expect(def.parameters.required).toContain("sandbox_path");
    expect(def.parameters.properties).toHaveProperty("description");
    expect(def.parameters.properties).toHaveProperty("dockerfile_path");
    expect(def.parameters.properties).toHaveProperty("image_ref");
  });

  it("fails when resolveAgentId returns undefined", async () => {
    const tool = createProposeMcpServerTool(
      makeDeps({ resolveAgentId: () => undefined })
    );
    const result = await tool.execute(
      { name: "mcp", sandbox_path: "mcp" },
      defaultContext()
    );
    expect(result.success).toBe(false);
    expect(result.content).toContain("Could not determine your agent ID");
  });

  it("fails when name is missing or empty", async () => {
    const tool = createProposeMcpServerTool(makeDeps());
    const r1 = await tool.execute({ sandbox_path: "mcp" }, defaultContext());
    expect(r1.success).toBe(false);
    expect(r1.content).toContain("name is required");
    const r2 = await tool.execute({ name: "  ", sandbox_path: "mcp" }, defaultContext());
    expect(r2.success).toBe(false);
    expect(r2.content).toContain("name is required");
  });

  it("fails when sandbox_path is missing or empty", async () => {
    const tool = createProposeMcpServerTool(makeDeps());
    const r1 = await tool.execute({ name: "mcp" }, defaultContext());
    expect(r1.success).toBe(false);
    expect(r1.content).toContain("sandbox_path is required");
    const r2 = await tool.execute({ name: "mcp", sandbox_path: "  " }, defaultContext());
    expect(r2.success).toBe(false);
    expect(r2.content).toContain("sandbox_path is required");
  });

  it("fails when sandbox_path escapes agent workspace", async () => {
    const registry = mockRegistry("/workspace/agents/agent-a");
    const tool = createProposeMcpServerTool(makeDeps({ registry }));
    const result = await tool.execute(
      { name: "mcp", sandbox_path: "../../../etc" },
      defaultContext()
    );
    expect(result.success).toBe(false);
    expect(result.content).toContain("sandbox_path must be inside your agent workspace");
  });

  it("fails when sandbox_path escapes workspace with multiple ..", async () => {
    const registry = mockRegistry("/workspace/agents/agent-a");
    const tool = createProposeMcpServerTool(makeDeps({ registry }));
    const result = await tool.execute(
      { name: "mcp", sandbox_path: "../../../other-workspace" },
      defaultContext()
    );
    expect(result.success).toBe(false);
    expect(result.content).toContain("sandbox_path must be inside your agent workspace");
  });

  it("succeeds when path is under workspace and calls repo and callback", async () => {
    const repo = mockRepo();
    let capturedProposal: McpServerProposal | null = null;
    const tool = createProposeMcpServerTool(
      makeDeps({
        repo,
        onMcpProposalForUserApproval: (p) => {
          capturedProposal = p;
        },
        crypto: { randomUUID: () => "fixed-uuid" } as CryptoProvider,
      })
    );
    const result = await tool.execute(
      { name: "my-api", description: "REST API", sandbox_path: "mcp/server" },
      defaultContext()
    );
    expect(result.success).toBe(true);
    expect(result.content).toContain("submitted for user approval");
    expect(result.content).toContain("my-api");
    const created = await repo.getById("fixed-uuid");
    expect(created).toBeDefined();
    expect(created!.name).toBe("my-api");
    expect(created!.description).toBe("REST API");
    expect(created!.proposingAgentId).toBe("my-agent");
    expect(created!.sandboxPath).toContain("mcp");
    expect(created!.sandboxPath).toContain("server");
    expect(capturedProposal).not.toBeNull();
    expect(capturedProposal!.status).toBe("pending_user");
  });

  it("passes optional dockerfile_path and image_ref to repo", async () => {
    const repo = mockRepo();
    const tool = createProposeMcpServerTool(
      makeDeps({
        repo,
        crypto: { randomUUID: () => "uuid-opt" } as CryptoProvider,
      })
    );
    await tool.execute(
      {
        name: "opt-mcp",
        sandbox_path: "app",
        dockerfile_path: "Dockerfile.mcp",
        image_ref: "oci:reg/img:tag",
      },
      defaultContext()
    );
    const created = await repo.getById("uuid-opt");
    expect(created!.dockerfilePath).toBe("Dockerfile.mcp");
    expect(created!.imageRef).toBe("oci:reg/img:tag");
  });

  it("accepts path with dot segments that stay under workspace", async () => {
    const tool = createProposeMcpServerTool(makeDeps());
    const result = await tool.execute(
      { name: "mcp", sandbox_path: "mcp/./sub/../server" },
      defaultContext()
    );
    expect(result.success).toBe(true);
  });

  it("returns failure and logs when repo.create throws", async () => {
    const repo = mockRepo({
      create: async () => {
        throw new Error("DB error");
      },
    });
    const logger = capturingLogger();
    const tool = createProposeMcpServerTool(
      makeDeps({ repo, logger, crypto: { randomUUID: () => "u" } as CryptoProvider })
    );
    const result = await tool.execute(
      { name: "mcp", sandbox_path: "mcp" },
      defaultContext()
    );
    expect(result.success).toBe(false);
    expect(result.content).toContain("Failed to submit proposal");
    expect(result.content).toContain("DB error");
    expect(logger.calls.some((c) => c.level === "warn" && c.message === "MCP server proposal failed")).toBe(true);
  });
});
