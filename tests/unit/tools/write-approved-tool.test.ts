/**
 * @fileoverview Unit tests for writing an approved tool to the tools folder.
 * @module tests/unit/tools/write-approved-tool
 */

import { describe, it, expect } from "bun:test";
import { writeApprovedTool } from "../../../src/tools/write-approved-tool.js";
import { inMemoryFileSystem } from "../../helpers/index.js";
import { capturingLogger } from "../../helpers/index.js";
import type { ToolProposal } from "../../../src/tools/proposals.js";

function proposal(overrides?: Partial<ToolProposal>): ToolProposal {
  return {
    id: "prop-1",
    proposingAgentId: "maia",
    name: "my_tool",
    description: "Does something useful.",
    parametersJson: '{"type":"object","properties":{"x":{"type":"string"}},"required":["x"]}',
    implementationType: "inline",
    implementationConfigJson: '{"code":"export function createTool(deps){ return { name: \\"my_tool\\", definition: () => ({}), execute: async () => ({ content: \\"ok\\", success: true }); }; }"}',
    status: "user_approved",
    securityReason: null,
    userFeedback: null,
    createdAt: "2026-02-13T12:00:00.000Z",
    updatedAt: "2026-02-13T12:00:00.000Z",
    ...overrides,
  };
}

describe("writeApprovedTool", () => {
  it("should throw when tool name is invalid", async () => {
    const fs = inMemoryFileSystem();
    const logger = capturingLogger();
    await expect(
      writeApprovedTool(fs, "/tools", proposal({ name: "Invalid-Name" }), logger)
    ).rejects.toThrow("Invalid tool name");
    await expect(
      writeApprovedTool(fs, "/tools", proposal({ name: "" }), logger)
    ).rejects.toThrow("Invalid tool name");
  });

  it("should throw when parametersJson is invalid", async () => {
    const fs = inMemoryFileSystem();
    const logger = capturingLogger();
    await expect(
      writeApprovedTool(fs, "/tools", proposal({ parametersJson: "not json" }), logger)
    ).rejects.toThrow("Invalid parameters_json");
  });

  it("should write manifest.json and index.ts for inline code", async () => {
    const fs = inMemoryFileSystem();
    const logger = capturingLogger();
    await writeApprovedTool(fs, "/workspace/tools", proposal(), logger);

    const manifestRaw = await fs.readFile("/workspace/tools/my_tool/manifest.json");
    const manifest = JSON.parse(manifestRaw) as { name: string; description: string; functions: unknown[] };
    expect(manifest.name).toBe("my_tool");
    expect(manifest.description).toBe("Does something useful.");
    expect(manifest.functions).toHaveLength(1);
    expect((manifest.functions[0] as { name: string }).name).toBe("my_tool");

    const indexRaw = await fs.readFile("/workspace/tools/my_tool/index.ts");
    expect(indexRaw).toContain("createTool");
    expect(indexRaw).toContain("ok");
  });

  it("should write stub index when no inline code", async () => {
    const fs = inMemoryFileSystem();
    const logger = capturingLogger();
    await writeApprovedTool(
      fs,
      "/tools",
      proposal({
        implementationType: "template",
        implementationConfigJson: null,
      }),
      logger
    );

    const indexRaw = await fs.readFile("/tools/my_tool/index.ts");
    expect(indexRaw).toContain("createTool");
    expect(indexRaw).toContain("my_tool");
    expect(indexRaw).toContain("Dynamic tool");
  });
});
